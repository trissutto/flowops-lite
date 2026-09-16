import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import { gunzipSync } from 'zlib';
import { PrismaService } from '../prisma/prisma.service';
import { ArquivoStone, CapturaStone, lerArquivoStone } from '../stone/stone-arquivo.parser';

/**
 * Baixa e grava o ARQUIVO DE CONCILIAÇÃO da Stone (API "Cliente Stone").
 * Doc: https://conciliacao.stone.com.br/reference/overview-da-api-cliente-stone
 *
 *   GET https://conciliation.stone.com.br/v2/merchant/{StoneCode}/conciliation-file/{AAAAMMDD}?layout=XML2_4
 *   Authorization: Basic base64("<chave>:")   ·   Accept-Encoding: gzip   ·   x-user-type: client
 *
 * A chave é criada pelo TITULAR no Portal Stone (Perfil → Chaves de
 * Autenticação → Criar Chave → "API de Conciliação Stone") e vale pros
 * StoneCodes do MESMO CPF/CNPJ. O grupo tem mais de um CNPJ, então
 * `STONE_CONCILIACAO_CHAVES` aceita várias (vírgula) e cada StoneCode usa a
 * que abrir o arquivo.
 *
 * Regras da Stone que moldam o código:
 *  - o arquivo do dia D sai a partir das 4h de D+1 (antes: 503);
 *  - 7 requisições por hora por StoneCode × dia (429);
 *  - não há ambiente de teste.
 */

const URL_BASE = 'https://conciliation.stone.com.br/v2/merchant';
const LIMITE_POR_HORA = 6; // a Stone corta em 7
const TIMEOUT_MS = 90_000;

export class ErroArquivoStone extends Error {
  constructor(
    message: string,
    /** status que vai pro stone_arquivos */
    readonly situacao: 'erro' | 'sem_acesso' | 'indisponivel' | 'limite',
  ) {
    super(message);
  }
}

export interface ResumoImportacao {
  stoneCode: string;
  dia: string;
  status: string;
  capturas: number;
  cancelamentos: number;
  /** dias (de captura) que mudaram e precisam ser reconferidos */
  diasAfetados: string[];
  erro?: string;
  pulado?: boolean;
}

function mascarar(chave: string): string {
  return chave.length > 4 ? chave.slice(-4) : '****';
}

@Injectable()
export class StoneArquivosService {
  private readonly logger = new Logger(StoneArquivosService.name);
  /** StoneCode → chave que abriu o último arquivo (evita testar todas de novo) */
  private readonly chaveDoCodigo = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  chaves(): string[] {
    return String(process.env.STONE_CONCILIACAO_CHAVES || '')
      .split(/[\s,;]+/)
      .map((c) => c.trim())
      .filter((c) => c.length >= 8);
  }

  /** Baixa o XML de um StoneCode × dia, testando as chaves configuradas. */
  async baixar(stoneCode: string, dia: string): Promise<{ xml: string; bytes: number; chave: string }> {
    const chaves = this.chaves();
    if (!chaves.length) {
      throw new ErroArquivoStone('Nenhuma chave da Stone no Railway (STONE_CONCILIACAO_CHAVES)', 'sem_acesso');
    }
    const preferida = this.chaveDoCodigo.get(stoneCode);
    const ordem = preferida ? [preferida, ...chaves.filter((c) => c !== preferida)] : chaves;
    const url = `${URL_BASE}/${encodeURIComponent(stoneCode)}/conciliation-file/${dia.replace(/-/g, '')}?layout=XML2_4`;
    const recusas: string[] = [];

    for (const chave of ordem) {
      let resp: AxiosResponse<ArrayBuffer>;
      try {
        resp = await axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
          decompress: true,
          headers: {
            Authorization: `Basic ${Buffer.from(`${chave}:`).toString('base64')}`,
            'Accept-Encoding': 'gzip',
            'x-user-type': 'client',
          },
        });
      } catch (e: any) {
        throw new ErroArquivoStone(`sem conexão com a Stone: ${e?.code || e?.message || e}`, 'erro');
      }
      const corpo = Buffer.from(resp.data || []);
      if (resp.status === 200) {
        const xml = (corpo[0] === 0x1f && corpo[1] === 0x8b ? gunzipSync(corpo) : corpo).toString('utf8');
        this.chaveDoCodigo.set(stoneCode, chave);
        return { xml, bytes: corpo.length, chave };
      }
      const detalhe = corpo.toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
      if (resp.status === 401 || resp.status === 403) {
        recusas.push(`…${mascarar(chave)}: ${resp.status}`);
        continue;
      }
      if (resp.status === 429) {
        throw new ErroArquivoStone('limite de consultas da Stone (7 por hora) — tenta de novo depois', 'limite');
      }
      if (resp.status === 503) {
        throw new ErroArquivoStone(`a Stone ainda não liberou o arquivo (${detalhe || 'volte depois das 4h'})`, 'indisponivel');
      }
      if (resp.status === 404) {
        throw new ErroArquivoStone(`a Stone não encontrou o arquivo deste dia (${detalhe || '404'})`, 'indisponivel');
      }
      throw new ErroArquivoStone(`a Stone respondeu ${resp.status}: ${detalhe}`, 'erro');
    }
    throw new ErroArquivoStone(
      `nenhuma chave abriu o StoneCode ${stoneCode} (${recusas.join(', ')}) — a chave precisa ser gerada no CNPJ dono desta maquininha`,
      'sem_acesso',
    );
  }

  /**
   * Importa um StoneCode × dia. `forcar` baixa de novo mesmo se já está ok
   * (a Stone reprocessa o dia quando há ajuste).
   */
  async importar(stoneCode: string, storeCode: string, dia: string, forcar = false): Promise<ResumoImportacao> {
    const base: ResumoImportacao = { stoneCode, dia, status: 'erro', capturas: 0, cancelamentos: 0, diasAfetados: [] };
    const atual = await this.db.stoneArquivo.findUnique({ where: { stoneCode_dia: { stoneCode, dia } } });
    if (atual?.status === 'ok' && !forcar) {
      return { ...base, status: 'ok', capturas: atual.capturas, cancelamentos: atual.cancelamentos, pulado: true };
    }
    // `tentativas` conta só a hora corrente: zera quando a última passou de 1h.
    const naMesmaHora =
      !!atual?.ultimaTentativa && Date.now() - new Date(atual.ultimaTentativa).getTime() < 60 * 60_000;
    if (naMesmaHora && (atual.tentativas || 0) >= LIMITE_POR_HORA) {
      return { ...base, status: atual.status, erro: 'limite de consultas da Stone nesta hora', pulado: true };
    }
    const tentativasNaHora = naMesmaHora ? (atual.tentativas || 0) + 1 : 1;

    try {
      const { xml, bytes, chave } = await this.baixar(stoneCode, dia);
      const arquivo = lerArquivoStone(xml);
      if (arquivo.stoneCode && String(Number(arquivo.stoneCode)) !== String(Number(stoneCode))) {
        throw new ErroArquivoStone(`o arquivo veio do StoneCode ${arquivo.stoneCode}, não do ${stoneCode}`, 'erro');
      }
      if (arquivo.dataReferencia && arquivo.dataReferencia !== dia) {
        throw new ErroArquivoStone(`o arquivo veio do dia ${arquivo.dataReferencia}, não do ${dia}`, 'erro');
      }
      const diasAfetados = await this.gravar(arquivo, stoneCode, storeCode, dia);
      await this.registrar(stoneCode, dia, storeCode, {
        status: 'ok',
        capturas: arquivo.capturas.length,
        cancelamentos:
          arquivo.cancelamentosAvulsos.length + arquivo.capturas.filter((c) => c.valorCancelado > 0).length,
        bytes,
        erro: null,
        chaveFinal: mascarar(chave),
        tentativas: tentativasNaHora,
        baixadoEm: new Date(),
      });
      this.logger.log(
        `[stone] ${stoneCode} (loja ${storeCode}) ${dia}: ${arquivo.capturas.length} captura(s), ` +
          `${arquivo.cancelamentosAvulsos.length} cancelamento(s) de outros dias`,
      );
      return {
        ...base,
        status: 'ok',
        capturas: arquivo.capturas.length,
        cancelamentos: arquivo.cancelamentosAvulsos.length,
        diasAfetados,
      };
    } catch (e: any) {
      const situacao = e instanceof ErroArquivoStone ? e.situacao : 'erro';
      const msg = String(e?.message || e).slice(0, 500);
      await this.registrar(stoneCode, dia, storeCode, {
        status: situacao,
        erro: msg,
        tentativas: tentativasNaHora,
      });
      this.logger.warn(`[stone] ${stoneCode} (loja ${storeCode}) ${dia}: ${situacao} — ${msg}`);
      return { ...base, status: situacao, erro: msg };
    }
  }

  private async registrar(stoneCode: string, dia: string, storeCode: string, dados: Record<string, any>) {
    await this.db.stoneArquivo.upsert({
      where: { stoneCode_dia: { stoneCode, dia } },
      create: { stoneCode, dia, storeCode, ultimaTentativa: new Date(), ...dados },
      update: { storeCode, ultimaTentativa: new Date(), ...dados },
    });
  }

  /** Grava capturas e cancelamentos. Devolve os dias de captura que mudaram. */
  private async gravar(arquivo: ArquivoStone, stoneCode: string, storeCode: string, dia: string): Promise<string[]> {
    const afetados = new Set<string>([dia]);
    for (const c of arquivo.capturas) {
      await this.gravarCaptura(c, stoneCode, storeCode, dia);
      if (c.diaLocal) afetados.add(c.diaLocal);
    }
    for (const canc of arquivo.cancelamentosAvulsos) {
      const t = await this.db.stoneTransaction.findUnique({ where: { stoneTxId: canc.chave } });
      if (!t) continue; // venda de antes do período importado — nada a conciliar
      const bruto = this.lerBruto(t.rawPayload);
      const lista: any[] = Array.isArray(bruto.cancelamentosAvulsos) ? bruto.cancelamentosAvulsos : [];
      const assinatura = `${dia}|${canc.canceladaEm?.toISOString() || ''}|${canc.valorDevolvido}`;
      if (!lista.some((x) => x.assinatura === assinatura)) {
        lista.push({ assinatura, dia, canceladaEm: canc.canceladaEm, valor: canc.valorDevolvido });
      }
      bruto.cancelamentosAvulsos = lista;
      const avulso = lista.reduce((s, x) => s + (Number(x.valor) || 0), 0);
      const mesmoDia = Number(bruto.captura?.valorCancelado) || 0;
      const capturado = Number(t.valorCapturado ?? t.amount) || 0;
      // Cancelamento avulso sem valor (só o evento): a Stone não disse quanto — trata como total.
      const cancelado = Math.min(capturado, canc.valorDevolvido > 0 ? mesmoDia + avulso : capturado);
      await this.db.stoneTransaction.update({
        where: { id: t.id },
        data: {
          valorCancelado: cancelado,
          amount: Math.round((capturado - cancelado) * 100) / 100,
          status: cancelado >= capturado - 0.005 ? 'canceled' : 'partially_canceled',
          canceladaEm: canc.canceladaEm || new Date(),
          rawPayload: JSON.stringify(bruto),
        },
      });
      if (t.dataReferencia) afetados.add(t.dataReferencia);
    }
    return [...afetados].sort();
  }

  private lerBruto(raw: string | null): any {
    try {
      const v = JSON.parse(raw || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  private async gravarCaptura(c: CapturaStone, stoneCode: string, storeCode: string, dia: string) {
    const existente = await this.db.stoneTransaction.findUnique({ where: { stoneTxId: c.chave } });
    const bruto = existente ? this.lerBruto(existente.rawPayload) : {};
    bruto.captura = { ...c, arquivo: dia };
    const avulsos: any[] = Array.isArray(bruto.cancelamentosAvulsos) ? bruto.cancelamentosAvulsos : [];
    const cancelado = Math.min(
      c.valorCapturado,
      c.valorCancelado + avulsos.reduce((s, x) => s + (Number(x.valor) || 0), 0),
    );
    const liquidoCaixa = Math.round((c.valorCapturado - cancelado) * 100) / 100;
    const status = cancelado <= 0.005 ? 'captured' : cancelado >= c.valorCapturado - 0.005 ? 'canceled' : 'partially_canceled';
    const metodo =
      c.tipo === 'credito' ? 'credit_card' : c.tipo === 'debito' ? 'debit_card' : c.tipo === 'voucher' ? 'voucher' : c.tipo;
    const ultimoCancelamento = c.cancelamentos.map((x) => x.canceladaEm).filter(Boolean).pop() || null;
    const dados = {
      stoneNsu: c.chave,
      authorizationCode: c.autorizacao,
      amount: liquidoCaixa,
      paymentMethod: metodo,
      bandeira: c.bandeira,
      last4: c.finalCartao,
      installments: c.parcelas ?? 1,
      merchantId: stoneCode,
      storeCode,
      status,
      capturedAt: c.capturadaEm,
      rawPayload: JSON.stringify(bruto),
      origem: 'arquivo',
      dataReferencia: c.diaLocal || dia,
      valorCapturado: c.valorCapturado,
      valorCancelado: cancelado,
      valorLiquido: c.valorLiquido,
      taxa: c.taxa,
      previsaoPagamento: c.previsaoPagamento,
      tipoTerminal: c.terminal,
      serialTerminal: c.serial,
      canceladaEm: ultimoCancelamento,
    };
    if (existente) {
      await this.db.stoneTransaction.update({ where: { id: existente.id }, data: dados });
    } else {
      await this.db.stoneTransaction.create({ data: { stoneTxId: c.chave, ...dados } });
    }
  }
}
