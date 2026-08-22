import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleAdsService } from './google-ads.service';

/**
 * A VENDA VOLTA PRO GOOGLE PELO SERVIDOR — sem GA4 no meio.
 *
 * ── POR QUE ISTO PRECISOU EXISTIR ──
 *
 * Em 19/08/2026, às 09:00, a conta de e-commerce parou de registrar conversão.
 * As DUAS ações morreram no mesmo minuto: a `Compra [OK]`, disparada pelo Tag
 * Manager do WordPress (que morreu quando o site novo assumiu `lurds.com.br`),
 * e o import `[GA4] (web) purchase`, que é a ação PRINCIPAL da conta.
 * Resultado: dias de campanha em ROAS desejado otimizando às cegas, com a
 * entrega do Shopping caindo de 487 para 127 cliques/dia — o robô não corta o
 * gasto quando perde o sinal, corta a entrega.
 *
 * A medição dependia de uma corrente de três elos (site → GA4 → Ads) em que
 * ninguém avisa quando um elo arrebenta. Isto é o caminho curto.
 *
 * ── POR QUE NÃO DÁ PRA FAZER COM TAG NO NAVEGADOR ──
 *
 * `purchase` é `SERVER_ONLY_EVENTS` no site, e por dois bons motivos: evento de
 * compra disparado pelo navegador é forjável (há teste cobrindo), e o PIX é
 * pago horas depois, quando não existe mais navegador aberto.
 *
 * ── 🚨 A AÇÃO DE CONVERSÃO TEM QUE SER `UPLOAD_CLICKS` ──
 *
 * A doc é categórica: *"The conversion action must have a type of
 * UPLOAD_CLICKS."* Ação nascida de tag do site (gtag/GTM) tem `type=WEBPAGE` e
 * recusa **100%** do lote com `INVALID_CONVERSION_ACTION_TYPE` — não é "algumas
 * falham", é sempre, para sempre. E recusa aqui é SILENCIOSA: HTTP 200, com
 * `results` cheio de objetos vazios. De fora parece cron saudável.
 *
 * Por isso `garantirAcaoValida()` confere o tipo antes do primeiro upload e se
 * recusa a arrancar se estiver errado. Custa 1 operação e elimina a única
 * classe de erro aqui que não tem desfazer.
 *
 * A ação certa nasce em: Ferramentas → Conversões → Nova ação → **Importar** →
 * Outras fontes de dados ou CRM → Acompanhar conversões de cliques. É ação
 * NOVA: não dá pra converter nem reaproveitar a do gtag.
 *
 * ⚠️ Ação recém-criada só aceita upload **6 horas depois** de existir
 * (`TOO_RECENT_CONVERSION_ACTION`). Criar hoje, ligar amanhã.
 *
 * ── O QUE TORNA ISTO SEGURO DE RODAR ──
 *
 * · `orderId` em toda conversão: o Google deduplica por ele.
 * · `adsConversaoEnviadaEm` carimba o pedido — a garantia é NOSSA (mesma lição
 *   do outbox do PDV, que não confia no Giga).
 * · `partialFailure: true` e leitura POSICIONAL de `results`: só os índices que
 *   voltaram OK são carimbados.
 * · Recusa definitiva é gravada e o pedido SAI da fila. Sem isso, o retry
 *   eterno entope o lote e queima a cota diária do token — que é compartilhada
 *   com o espelho de gasto, então derrubaria a tela de ROAS junto.
 * · Carência de 6h desde o pagamento: o Google recusa clique com menos de 6h
 *   (`TOO_RECENT_EVENT`), e a compra de mesma sessão é a maioria do tráfego
 *   pago. Sem o piso, o log encheria de recusa que não é problema — e log que
 *   grita à toa treina todo mundo a ignorar o log.
 * · Sem credencial ou sem `GOOGLE_ADS_CONVERSAO_ACTION_ID`, não roda.
 */
@Injectable()
export class GoogleAdsConversaoService {
  private readonly logger = new Logger(GoogleAdsConversaoService.name);

  /** Teto de tentativas antes de desistir de um pedido. */
  private readonly MAX_TENTATIVAS = 5;

  /** O Google recusa clique com menos de 6h. Piso de idade da nossa fila. */
  private readonly CARENCIA_MS = 6 * 60 * 60 * 1000;

  /**
   * Recusas que NUNCA vão passar numa segunda tentativa. Reapresentar isto é
   * queimar cota para receber o mesmo "não".
   */
  private readonly DEFINITIVOS = [
    'INVALID_CONVERSION_ACTION_TYPE',
    'EXPIRED_EVENT',
    'EVENT_NOT_FOUND',
    'EXPIRED_CLICK',
    'CLICK_NOT_FOUND',
    'INVALID_CUSTOMER_FOR_CLICK',
    'CONVERSION_PRECEDES_EVENT',
    'DUPLICATE_ORDER_ID',
    'INVALID_CONVERSION_ACTION',
    'CONVERSION_NOT_COMPLIANT_WITH_ATT_POLICY',
  ];

  /** Cache do check de tipo: null = ainda não conferido nesta instância. */
  private acaoValida: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ads: GoogleAdsService,
  ) {}

  private env(nome: string): string | null {
    return this.config.get<string>(nome)?.trim() || null;
  }

  /** Conta dona da AÇÃO de conversão. Sem ela, cai na primeira de `GOOGLE_ADS_CONTAS`. */
  private conta(): string | null {
    const propria = this.env('GOOGLE_ADS_CONVERSAO_CONTA')?.replace(/\D/g, '');
    if (propria) return propria;
    return (
      (this.config.get<string>('GOOGLE_ADS_CONTAS') || '')
        .split(',')
        .map((c) => c.trim().replace(/\D/g, ''))
        .filter(Boolean)[0] ?? null
    );
  }

  /**
   * Id da ação de conversão do tipo **UPLOAD_CLICKS**.
   *
   * ⚠️ NÃO é a ação do gtag/GTM. A `Compra [OK]` (6807548872) desta conta é
   * `type=WEBPAGE` e recusa todo upload — ver o cabeçalho desta classe.
   */
  private acaoId(): string | null {
    return this.env('GOOGLE_ADS_CONVERSAO_ACTION_ID')?.replace(/\D/g, '') || null;
  }

  configurado(): boolean {
    return Boolean(
      this.ads.configurado() &&
        this.conta() &&
        this.acaoId() &&
        this.config.get<string>('GOOGLE_ADS_CONVERSAO_UPLOAD') !== '0',
    );
  }

  /**
   * De hora em hora, não de 10 em 10 minutos.
   *
   * O Google leva horas pra refletir a conversão no relatório e o lance dele
   * reaprende em dias — pressa aqui não compra nada. E o teto de operações do
   * token é compartilhado com o espelho de gasto: cada ciclo a mais é cota a
   * menos pra tela de ROAS. Minuto 37 pra não colidir com o 7 (Meta) nem com o
   * 17 (gasto do Google).
   */
  @Cron('37 * * * *')
  async cronEnviar(): Promise<void> {
    if (!this.configurado()) return;
    try {
      const r = await this.enviarPendentes();
      if (r.enviadas > 0 || r.recusadas > 0) {
        this.logger.log(
          `conversões: ${r.enviadas} aceita(s), ${r.recusadas} recusada(s) pelo Google`,
        );
      }
    } catch (err) {
      // Nunca lança: métrica não derruba processo.
      this.logger.error(`falha ao enviar conversão ao Google: ${String(err)}`);
    }
  }

  /**
   * CONFERE O TIPO DA AÇÃO ANTES DO PRIMEIRO UPLOAD.
   *
   * Uma operação, uma vez por processo. Sem ela, apontar a env pra ação errada
   * produz um cron que roda, responde 200 e não entrega nada — o modo de falha
   * mais caro que existe, porque parece sucesso.
   */
  private async garantirAcaoValida(conta: string, acao: string): Promise<boolean> {
    if (this.acaoValida !== null) return this.acaoValida;

    try {
      const corpo = await this.ads.requisitar(`customers/${conta}/googleAds:searchStream`, {
        query:
          'SELECT conversion_action.id, conversion_action.type, conversion_action.status ' +
          `FROM conversion_action WHERE conversion_action.id = ${acao}`,
      });
      const lotes: Array<{ results?: any[] }> = Array.isArray(corpo) ? corpo : [corpo];
      const linha = lotes.flatMap((l) => l?.results ?? [])[0];
      const tipo = linha?.conversionAction?.type;

      if (!linha) {
        this.logger.error(
          `ação de conversão ${acao} não existe na conta ${conta} — confira GOOGLE_ADS_CONVERSAO_ACTION_ID`,
        );
        this.acaoValida = false;
        return false;
      }
      if (tipo !== 'UPLOAD_CLICKS') {
        this.logger.error(
          `ação de conversão ${acao} é do tipo ${tipo}, e o upload exige UPLOAD_CLICKS. ` +
            'Crie em Ferramentas > Conversões > Nova ação > Importar > Outras fontes de dados ' +
            'ou CRM > Acompanhar conversões de cliques, e aponte a env pra ela. ' +
            'A ação do gtag/GTM NÃO serve.',
        );
        this.acaoValida = false;
        return false;
      }
      this.acaoValida = true;
      return true;
    } catch (err) {
      // Falha de rede não é veredito: não cacheia, tenta de novo no próximo ciclo.
      this.logger.warn(`não deu pra conferir o tipo da ação de conversão: ${String(err)}`);
      return false;
    }
  }

  /**
   * Sobe as vendas pagas que o Google ainda não contou.
   *
   * `validar = true` usa `validateOnly` da API: o Google confere tudo e não
   * grava nada. É o único jeito de descobrir sem sujar a conta se o token e a
   * ação estão certos. ⚠️ Com `validateOnly`, `results` vem VAZIO de propósito
   * — não confundir com falha, e por isso nada é carimbado nesse modo.
   */
  async enviarPendentes(
    limite = 200,
    validar = false,
  ): Promise<{ enviadas: number; recusadas: number; validado?: number; erro?: string }> {
    if (!this.configurado()) return { enviadas: 0, recusadas: 0 };

    const conta = this.conta()!;
    const acaoId = this.acaoId()!;
    if (!(await this.garantirAcaoValida(conta, acaoId))) {
      return { enviadas: 0, recusadas: 0, erro: 'ação de conversão inválida (ver log)' };
    }

    const agora = Date.now();
    const pedidos = await (this.prisma as any).order.findMany({
      where: {
        source: 'ecommerce',
        // PROVA DE PAGAMENTO, não lista de status. O enum não tem 'paid' nem
        // 'completed' (`common/enums.ts`): quem paga vira 'processing', e só
        // depois de um humano rotear é que vira 'separating'. Filtrar por
        // status deixaria de fora justamente o pedido recém-pago — e a janela
        // de 60 dias o faria expirar sem nunca ter sido tentado.
        paidAt: {
          not: null,
          // Carência de 6h: o Google recusa clique mais novo que isso.
          lte: new Date(agora - this.CARENCIA_MS),
          // Fora da janela não adianta mais tentar.
          gte: new Date(agora - 60 * 24 * 60 * 60 * 1000),
        },
        status: { notIn: ['cancelled', 'failed'] },
        gclid: { not: null },
        adsConversaoEnviadaEm: null,
        adsConversaoTentativas: { lt: this.MAX_TENTATIVAS },
      },
      select: {
        id: true,
        wcOrderNumber: true,
        gclid: true,
        totalAmount: true,
        paidAt: true,
        adsConversaoTentativas: true,
      },
      orderBy: { paidAt: 'asc' },
      // Teto da API é 2.000 por request.
      take: Math.min(limite, 2000),
    });
    if (!pedidos.length) return { enviadas: 0, recusadas: 0 };

    const acao = `customers/${conta}/conversionActions/${acaoId}`;
    const conversoes = pedidos.map((p: any) => ({
      gclid: p.gclid,
      conversionAction: acao,
      // A hora da CONVERSÃO é a do pagamento — o PIX pago no dia seguinte
      // pertence ao dia seguinte.
      conversionDateTime: this.momento(p.paidAt),
      conversionValue: Number(p.totalAmount) || 0,
      currencyCode: 'BRL',
      // A chave de deduplicação do lado do Google.
      orderId: p.wcOrderNumber ?? p.id,
    }));

    const resposta = await this.ads.requisitar(`customers/${conta}:uploadClickConversions`, {
      conversions: conversoes,
      partialFailure: true,
      ...(validar ? { validateOnly: true } : {}),
    });

    if (validar) {
      // Nada é carimbado: o Google não gravou nada.
      return {
        enviadas: 0,
        recusadas: 0,
        validado: pedidos.length,
        erro: resposta?.partialFailureError
          ? JSON.stringify(resposta.partialFailureError).slice(0, 800)
          : undefined,
      };
    }

    // `results` vem com UMA entrada por conversão, na MESMA ordem. A que falhou
    // volta como objeto VAZIO — por isso a leitura é posicional. Carimbar o
    // lote inteiro perderia em silêncio as recusadas.
    const resultados: any[] = Array.isArray(resposta?.results) ? resposta.results : [];
    const errosPorIndice = this.errosPorIndice(resposta?.partialFailureError);

    const aceitos: string[] = [];
    const recusados: Array<{ id: string; erro: string; definitivo: boolean }> = [];

    pedidos.forEach((p: any, i: number) => {
      const r = resultados[i];
      if (r && (r.orderId || r.gclidDateTimePair || r.conversionAction)) {
        aceitos.push(p.id);
        return;
      }
      const erro = errosPorIndice.get(i) ?? 'recusada sem detalhe';
      recusados.push({
        id: p.id,
        erro: erro.slice(0, 300),
        definitivo: this.DEFINITIVOS.some((d) => erro.includes(d)),
      });
    });

    if (aceitos.length) {
      await (this.prisma as any).order.updateMany({
        where: { id: { in: aceitos } },
        data: { adsConversaoEnviadaEm: new Date(), adsConversaoErro: null },
      });
    }

    for (const r of recusados) {
      await (this.prisma as any).order.update({
        where: { id: r.id },
        data: {
          adsConversaoErro: r.erro,
          // Recusa definitiva sai da fila NA HORA, sem gastar as 5 tentativas.
          adsConversaoTentativas: r.definitivo ? this.MAX_TENTATIVAS : { increment: 1 },
        },
      });
    }

    if (recusados.length) {
      const definitivas = recusados.filter((r) => r.definitivo).length;
      this.logger.warn(
        `${recusados.length} conversão(ões) recusada(s) (${definitivas} definitiva(s)). ` +
          `Primeiro motivo: ${recusados[0].erro}`,
      );
    }
    return { enviadas: aceitos.length, recusadas: recusados.length };
  }

  /**
   * Mapeia índice do lote → mensagem de erro, lendo o `partialFailureError`.
   *
   * O Google diz QUAL item falhou em
   * `details[].errors[].location.fieldPathElements[].index` (0-based, casa
   * posicionalmente com o array enviado). Esse índice já chegava na resposta e
   * era jogado fora — sem ele não dá pra distinguir "tenta de novo" de "nunca
   * mais", e todo erro vira retry eterno.
   */
  private errosPorIndice(partialFailureError: any): Map<number, string> {
    const mapa = new Map<number, string>();
    const detalhes: any[] = partialFailureError?.details ?? [];
    for (const d of detalhes) {
      for (const e of d?.errors ?? []) {
        const idx = (e?.location?.fieldPathElements ?? []).find(
          (f: any) => typeof f?.index === 'number',
        )?.index;
        // O nome do erro é a chave do objeto `errorCode` (ex.: conversionUploadError).
        const codigo = Object.values(e?.errorCode ?? {})[0];
        const texto = `${codigo ?? ''} ${e?.message ?? ''}`.trim();
        if (typeof idx === 'number') mapa.set(idx, texto);
      }
    }
    return mapa;
  }

  /**
   * 'yyyy-MM-dd HH:mm:ss+/-HH:mm' — com ESPAÇO, não 'T'. `toISOString()` não
   * serve. O fuso é obrigatório: sem ele o Google assume o da conta e a venda
   * das 23h vira do dia seguinte.
   */
  private momento(d: Date): string {
    const opcoes: Intl.DateTimeFormatOptions = {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    // 'sv-SE' já entrega 'YYYY-MM-DD HH:mm:ss' — o único locale que sai no
    // formato certo sem remontar string na mão.
    const local = new Intl.DateTimeFormat('sv-SE', opcoes).format(d).replace('T', ' ');

    // O deslocamento é PERGUNTADO, não chumbado. Hoje o Brasil não tem horário
    // de verão (acabou em 2019) e isto devolve sempre -03:00 — mas se voltar,
    // um `-03:00` fixo mandaria toda venda de verão uma hora errada, em
    // silêncio, e ninguém confere carimbo de conversão.
    const nome = new Intl.DateTimeFormat('en-US', { ...opcoes, timeZoneName: 'longOffset' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value; // ex.: 'GMT-03:00'
    const offset = /GMT([+-]\d{2}:\d{2})/.exec(nome ?? '')?.[1] ?? '-03:00';

    return `${local}${offset}`;
  }
}
