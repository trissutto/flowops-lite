import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { NfeSequenceService } from './nfe-sequence.service';
import { signXmlNfeWithA1, transmitNfeSefazSp, cancelNfceSefazSp } from '../pdv/nfce-sefaz';
import { SEFAZ_SP_NFE_ENDPOINTS, HOMOLOG_FRASE } from './nfe-sefaz-endpoints';

/** UF → código IBGE (cUF). Só os estados que a rede opera; expandir se preciso. */
// ═══ REGRAS FISCAIS DE VENDA (tabela do contador, 28/07/26) ══════════════
// CFOP decidido AUTOMATICAMENTE (usuário nunca escolhe):
//   mesmo estado → 5102 · interestadual c/ IE → 6102 · interestadual s/ IE → 6108
// Alíquota interestadual a partir de SP: 7% pra N/NE/CO + ES; 12% pra S/SE.
const UF_ALIQ_INTER_7 = new Set(['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'PA', 'PB', 'PE', 'PI', 'RN', 'RO', 'RR', 'SE', 'TO']);
// Alíquota INTERNA (modal) de cada UF pro DIFAL — CONFERIR COM O CONTADOR;
// ajustável sem deploy via NFE_UF_ALIQ_JSON ('{"RJ":22,"BA":20.5,...}').
const UF_ALIQ_INTERNA_DEFAULT: Record<string, number> = {
  AC: 19, AL: 20, AM: 20, AP: 18, BA: 20.5, CE: 20, DF: 20, ES: 17, GO: 19,
  MA: 23, MG: 18, MS: 17, MT: 17, PA: 19, PB: 20, PE: 20.5, PI: 22.5, PR: 19.5,
  RJ: 22, RN: 20, RO: 19.5, RR: 20, RS: 17, SC: 17, SE: 20, SP: 18, TO: 20,
};
// FCP (fundo de combate à pobreza) por UF destino — default só RJ 2%;
// ajustável via NFE_UF_FCP_JSON. Conferir com o contador.
const UF_FCP_DEFAULT: Record<string, number> = { RJ: 2 };

function aliqInternaUF(uf: string): number {
  try { const j = JSON.parse(process.env.NFE_UF_ALIQ_JSON || '{}'); if (j[uf] != null) return Number(j[uf]); } catch { /* JSON inválido → default */ }
  return UF_ALIQ_INTERNA_DEFAULT[uf] ?? 18;
}
function fcpUF(uf: string): number {
  try { const j = JSON.parse(process.env.NFE_UF_FCP_JSON || '{}'); if (j[uf] != null) return Number(j[uf]); } catch { /* idem */ }
  return UF_FCP_DEFAULT[uf] ?? 0;
}
function aliqInterSaidaSP(destUF: string): number {
  return UF_ALIQ_INTER_7.has(destUF) ? 7 : 12;
}
/** Regra central do CFOP de venda (árvore do contador). */
export function cfopVenda(origemUF: string, destUF: string, destTemIE: boolean): { cfop: string; natOp: string } {
  if (origemUF === destUF) return { cfop: '5102', natOp: 'VENDA DE MERCADORIA ADQUIRIDA DE TERCEIROS' };
  if (destTemIE) return { cfop: '6102', natOp: 'VENDA DE MERCADORIA ADQUIRIDA DE TERCEIROS' };
  // natOp tem LIMITE DE 60 CARACTERES no schema — o texto antigo tinha 61 e
  // TODA venda interestadual caía com cStat 225 genérico (29/07, meio dia de caça).
  return { cfop: '6108', natOp: 'VENDA DE MERC. ADQ. DE TERCEIROS A NAO CONTRIBUINTE' };
}

const CUF_BY_UF: Record<string, string> = {
  SP: '35', RJ: '33', MG: '31', ES: '32', PR: '41', SC: '42', RS: '43',
  BA: '29', GO: '52', DF: '53', MS: '50', MT: '51', PE: '26', CE: '23',
};

interface StoreFiscal {
  storeCode: string;
  cnpj: string;
  ie: string;
  razaoSocial: string;
  fantasia: string;
  /** true = emitindo pela identidade de OUTRA empresa (matchRaiz) — a
   *  sequência legada da loja física NÃO vale pra esse CNPJ. */
  identidadeEmprestada?: boolean;
  uf: string;
  ambiente: '1' | '2';
  regime: string;
  certPfxB64: string;
  certPfxPass: string;
  ender: {
    logradouro: string; numero: string; complemento?: string; bairro: string;
    municipio: string; cep: string; uf: string; codMunicipio: string; fone?: string;
  };
}

@Injectable()
export class NfeTransferService {
  private readonly logger = new Logger(NfeTransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: WincredCatalogService,
    private readonly seq: NfeSequenceService,
  ) {}

  // ── público ───────────────────────────────────────────────────────────

  /**
   * Emite a NF-e modelo 55 de transferência de UM RealignmentShipment.
   * Idempotente: se já existe NfeDoc autorizada pra esse shipment, devolve ela.
   * Fase 1: homologação (ambiente vem do NfceConfig da loja de origem).
   */
  async emitForShipment(
    shipmentId: string,
    opts: { userId?: string | null; serie?: string; startNumero?: number } = {},
  ) {
    const shipment = await this.prisma.realignmentShipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    this.checarLojaBloqueada(shipment);

    // Idempotência: não reemitir o que já foi autorizado.
    const jaAutorizada = await this.prisma.nfeDoc.findFirst({
      where: { shipmentId, status: 'authorized' },
    });
    if (jaAutorizada) {
      return { ok: true, jaEmitida: true, doc: this.publicDoc(jaAutorizada) };
    }

    const data = await this.buildTransferData(shipment, { requireCert: true });
    const { origem, destino, items, warnings, cfop, interestadual } = data;
    const valorTotal = data.valorTotal;

    this.checarMesmaEmpresa(origem, destino);

    const ambiente = origem.ambiente;
    const tpAmb = ambiente;
    const serie = opts.serie || '1';
    await this.garantirContinuacao(this.digits(origem.cnpj), origem.cnpj, serie);
    // NUMERAÇÃO POR CNPJ EMITENTE (dono 29/07): T.O. e LURDS têm sequências
    // PRÓPRIAS — chavear pela loja física misturava as duas matrizes de
    // Itanhaém no mesmo contador (2332 LURDS → 2334 T.O.).
    let numero = await this.seq.next(this.digits(origem.cnpj), serie, {
      start: opts.startNumero ?? this.startPadraoPara(origem.cnpj, serie),
      // herda o contador legado da loja — só quando a identidade é a DELA
      legacyKey: origem.identidadeEmprestada ? undefined : origem.storeCode,
    });
    const valorTotalCents = Math.round(valorTotal * 100);
    const cUF = CUF_BY_UF[origem.ender.uf] || origem.ender.codMunicipio.slice(0, 2);
    const natOp = 'TRANSFERENCIA DE MERC ADQ TERCEIROS';
    const endpoint = SEFAZ_SP_NFE_ENDPOINTS[tpAmb].autorizacao;

    // Registra o doc ANTES de transmitir (rastreabilidade mesmo se a SEFAZ cair).
    const doc = await this.prisma.nfeDoc.create({
      data: {
        shipmentId, fromStoreCode: origem.storeCode, toStoreCode: destino.storeCode,
        modelo: '55', serie, numero, cNF: '', chave: '', tpAmb, natOp, cfop, valorTotalCents,
        status: 'pending', emittedByUserId: opts.userId ?? null,
      },
    });

    // AUTO-DESCOBERTA DO NÚMERO REAL (dono 24/07): a filial já emitiu notas pelo
    // GigaNFe, então nºs antigos JÁ EXISTEM na SEFAZ. Se cair num nº usado, a
    // SEFAZ rejeita com cStat 539/204 (duplicidade) — aí pulamos pro próximo e
    // tentamos de novo até autorizar. Número rejeitado por duplicidade NÃO cria
    // lacuna (ele já existia como outra nota). Limite via NFE_539_MAX_RETRY.
    const MAX_DUP_RETRY = Number(process.env.NFE_539_MAX_RETRY ?? 30);
    let res: any = null;
    let chave = '';
    let cNF = '';
    for (let tentativa = 0; ; tentativa++) {
      const dhEmi = this.dhEmiNow();
      cNF = crypto.randomInt(10_000_000, 99_999_999).toString();
      chave = this.buildChave({ cUF, cnpj: origem.cnpj, serie, numero, cNF, dataEmissao: new Date() });
      const xml = this.buildXml({
        chave, cUF, cNF, serie, numero, dhEmi, tpAmb, natOp,
        origem, destino, interestadual, items, valorTotal, remCode: shipment.code,
        // Transporte da remessa (dono 29/07): Correios → modFrete 9; próprio → default (3)
        modFrete: this.transporteDaRemessa(shipment, items) === 'correios' ? '9' : undefined,
      });
      const xmlMin = xml.replace(/>\s+</g, '><').trim();
      let xmlAssinado: string;
      try {
        xmlAssinado = signXmlNfeWithA1({ xml: xmlMin, pfxBase64: origem.certPfxB64, pfxPassword: origem.certPfxPass });
      } catch (e: any) {
        await this.prisma.nfeDoc.update({
          where: { id: doc.id },
          data: { status: 'error', numero, cNF, chave, erro: `Assinatura: ${e?.message || e}` },
        });
        throw new BadRequestException(`Falha ao assinar NF-e: ${e?.message || e}`);
      }
      await this.prisma.nfeDoc.update({
        where: { id: doc.id },
        data: { numero, cNF, chave, status: 'signed', xmlEnviado: xmlAssinado },
      });

      res = await transmitNfeSefazSp({
        xmlAssinado, ambiente: tpAmb,
        pfxBase64: origem.certPfxB64, pfxPassword: origem.certPfxPass,
        endpointOverride: endpoint,
      });
      const ok = res.success && (res.cStat === '100' || res.cStat === '150');
      if (ok) break;
      // 539/204 = número JÁ USADO no GigaNFe → avança e re-tenta o próximo.
      const duplicado = res.cStat === '539' || res.cStat === '204';
      if (duplicado && tentativa < MAX_DUP_RETRY) {
        this.logger.warn(
          `[nfe] ${origem.storeCode} nº ${numero} já existe na SEFAZ (cStat ${res.cStat}) → tentando ${numero + 1}`,
        );
        numero = await this.seq.next(this.digits(origem.cnpj), serie);
        continue;
      }
      // 778 = NCM inexistente [nItem:X] → troca o NCM ruim por um válido
      // (vestuário) e re-tenta com o MESMO número (não foi duplicidade).
      if (res.cStat === '778' && tentativa < MAX_DUP_RETRY) {
        if (this.corrigirNcmInvalido(items, res.xMotivo)) continue;
      }
      // 225 = Falha no Schema — loga o XML inteiro pra diagnóstico no Railway
      if (res.cStat === '225') this.logger.error(`[nfe] 225 schema (${chave}): ${res.xMotivo} · XML: ${xmlAssinado}`);
      break;
    }

    const autorizada = res.success && (res.cStat === '100' || res.cStat === '150');
    const updated = await this.prisma.nfeDoc.update({
      where: { id: doc.id },
      data: {
        status: autorizada ? 'authorized' : 'rejected',
        cStat: res.cStat,
        xMotivo: res.xMotivo,
        protocolo: res.protocolo ?? null,
        dhRecbto: res.dhRecbto ?? null,
        xmlAutorizado: res.xmlAutorizado ?? null,
        xmlResposta: res.xmlResposta ?? null,
        erro: autorizada ? null : res.xMotivo || res.error || 'Rejeitada',
      },
    });

    return {
      ok: autorizada,
      jaEmitida: false,
      doc: this.publicDoc(updated),
      warnings,
    };
  }

  /** Notas AUTORIZADAS do período pro DOWNLOAD EM LOTE (ZIP do contador).
   *  De/Até em YYYY-MM-DD (fuso -03); sem datas = todas (cap 1000). */
  async listDocsParaLote(p: { de?: string; ate?: string; storeCode?: string; emitRaiz?: string }) {
    const where: any = { status: 'authorized' };
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const faixa: any = {};
    if (p.de && iso.test(p.de)) faixa.gte = new Date(`${p.de}T00:00:00-03:00`);
    if (p.ate && iso.test(p.ate)) faixa.lte = new Date(`${p.ate}T23:59:59.999-03:00`);
    if (faixa.gte || faixa.lte) where.createdAt = faixa;
    if (p.storeCode) where.fromStoreCode = p.storeCode;
    let docs = await this.prisma.nfeDoc.findMany({ where, orderBy: { createdAt: 'asc' }, take: 1000 });
    const raiz = String(p.emitRaiz || '').replace(/\D/g, '');
    if (raiz.length === 8) {
      docs = docs.filter((d: any) => String(d.chave || '').slice(6, 14) === raiz);
    }
    return docs;
  }

  /** Documento por id (com XMLs, pra download/DANFE). */
  async getDoc(id: string) {
    const doc = await this.prisma.nfeDoc.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('NF-e não encontrada');
    return doc;
  }

  /**
   * BLOQUEIO (dono 24/07): transferência é SÓ dentro da MESMA empresa.
   * Raiz 20.104.813 (T.O. RISSUTTO) e 30.246.592 (LURDS PLUS SIZE) são CNPJs
   * de empresas DIFERENTES — origem↔destino entre elas é VENDA, não
   * transferência (CFOP 5152/6152 indevido). Kill-switch: NFE_ALLOW_INTER_EMPRESA=1.
   */
  private checarMesmaEmpresa(origem: StoreFiscal, destino: StoreFiscal) {
    if (String(process.env.NFE_ALLOW_INTER_EMPRESA ?? '') === '1') return;
    const raizO = origem.cnpj.slice(0, 8);
    const raizD = destino.cnpj.slice(0, 8);
    if (raizO !== raizD) {
      throw new BadRequestException(
        `NF-e de transferência SÓ entre lojas da MESMA empresa. Origem (${origem.razaoSocial || raizO}) e destino (${destino.razaoSocial || raizD}) têm CNPJs de empresas diferentes — juridicamente isso é VENDA, não transferência. Emissão bloqueada.`,
      );
    }
  }

  /**
   * CANCELAMENTO de NF-e autorizada (evento 110111) — reusa a camada de evento
   * do NFC-e apontando pro host da NF-e mod 55. Prazo SEFAZ-SP: 24h após a
   * autorização (fora do prazo a SEFAZ recusa). Exige justificativa 15-255.
   */
  async cancelDoc(id: string, justificativa: string, userId?: string | null) {
    const doc = await this.prisma.nfeDoc.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('NF-e não encontrada');
    if (doc.status === 'cancelled') {
      return { ok: true, jaCancelada: true, doc: this.publicDoc(doc) };
    }
    if (doc.status !== 'authorized') {
      throw new BadRequestException('Só é possível cancelar NF-e AUTORIZADA.');
    }
    if (!doc.chave || !doc.protocolo) {
      throw new BadRequestException('NF-e sem chave/protocolo gravados — não dá pra cancelar.');
    }
    const just = String(justificativa || '').trim();
    if (just.length < 15 || just.length > 255) {
      throw new BadRequestException('Justificativa do cancelamento precisa ter entre 15 e 255 caracteres.');
    }

    // O AUTOR do evento tem que ser o EMITENTE da chave — transferência pode
    // ter sido emitida pela raiz do DESTINO (matchRaiz), não pela identidade
    // primária da loja origem. Sem isso a SEFAZ recusa com cStat 574 (29/07).
    const cnpjEmitente = String(doc.chave).slice(6, 20);
    const origem = await this.loadStoreFiscal(doc.fromStoreCode, {
      requireCert: true,
      matchRaiz: cnpjEmitente.slice(0, 8),
    });
    const amb: '1' | '2' = doc.tpAmb === '1' ? '1' : '2';
    const endpoint = SEFAZ_SP_NFE_ENDPOINTS[amb].eventos;

    const res = await cancelNfceSefazSp({
      chave: doc.chave,
      protocolo: doc.protocolo,
      justificativa: just,
      cnpj: cnpjEmitente,
      ambiente: amb,
      pfxBase64: origem.certPfxB64,
      pfxPassword: origem.certPfxPass,
      endpointOverride: endpoint,
    });

    // cStat de sucesso do evento: 135 (registrado+vinculado) ou 155 (idem c/ ressalva)
    const cancelada = res.success && (res.cStat === '135' || res.cStat === '155');
    const updated = await this.prisma.nfeDoc.update({
      where: { id },
      data: {
        status: cancelada ? 'cancelled' : doc.status,
        cStat: res.cStat,
        xMotivo: res.xMotivo,
        xmlResposta: res.xmlResposta || doc.xmlResposta,
        erro: cancelada
          ? `Cancelada${res.nProtCancelamento ? ` · prot ${res.nProtCancelamento}` : ''} · ${just}`
          : (res.error || res.xMotivo || doc.erro),
        emittedByUserId: userId || doc.emittedByUserId,
      },
    });
    if (!cancelada) {
      throw new BadRequestException(
        `SEFAZ recusou o cancelamento: cStat ${res.cStat} — ${res.xMotivo || res.error || 'erro'}`,
      );
    }
    return {
      ok: true,
      doc: this.publicDoc(updated),
      cStat: res.cStat,
      xMotivo: res.xMotivo,
      protocoloCancelamento: res.nProtCancelamento || null,
    };
  }

  /** Lista NF-e emitidas (filtro por loja/status). */
  async list(params: { storeCode?: string; status?: string; limit?: number; emitRaiz?: string }) {
    const where: any = {};
    if (params.storeCode) where.fromStoreCode = params.storeCode;
    if (params.status) where.status = params.status;
    let docs = await this.prisma.nfeDoc.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, params.limit || 100),
    });
    // Filtro pelo EMITENTE (dono 29/07): a raiz do CNPJ está na CHAVE
    // (posições 6–13) — separa T.O. × LURDS × MDD mesmo quando a loja física
    // é a mesma (ex.: 01 Itanhaém emite pelas duas empresas).
    const raiz = String(params.emitRaiz || '').replace(/\D/g, '');
    if (raiz.length === 8) {
      docs = docs.filter((d: any) => String(d.chave || '').slice(6, 14) === raiz);
    }
    // EMITENTE REAL na lista (dono 29/07: "01→Anália deveria mostrar SUZANO"):
    // resolve o CNPJ da CHAVE pra loja/empresa que assinou — a loja física
    // (fromStoreCode) pode ter emitido pela identidade de outra (matchRaiz).
    const cfgs = await this.prisma.nfceConfig.findMany({
      select: { storeCode: true, cnpj: true, nfeCnpj: true, razaoSocial: true, fantasia: true },
    });
    const porCnpj = new Map<string, { storeCode: string; nome: string }>();
    for (const c of cfgs as any[]) {
      const nome = String(c.fantasia || c.razaoSocial || '').trim();
      for (const doc of [c.nfeCnpj, c.cnpj]) {
        const d14 = String(doc || '').replace(/\D/g, '');
        if (d14.length === 14 && !porCnpj.has(d14)) porCnpj.set(d14, { storeCode: c.storeCode, nome });
      }
    }
    return docs.map((d: any) => {
      const emitCnpj = String(d.chave || '').slice(6, 20);
      const cfg = emitCnpj.length === 14 ? porCnpj.get(emitCnpj) : undefined;
      return {
        ...this.publicDoc(d),
        emitCnpj: emitCnpj.length === 14 ? emitCnpj : null,
        emitStoreCode: cfg?.storeCode ?? null,
        emitNome: cfg?.nome ?? null,
      };
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private publicDoc(d: any) {
    return {
      id: d.id,
      shipmentId: d.shipmentId,
      fromStoreCode: d.fromStoreCode,
      toStoreCode: d.toStoreCode,
      modelo: d.modelo,
      serie: d.serie,
      numero: d.numero,
      chave: d.chave,
      tpAmb: d.tpAmb,
      cfop: d.cfop,
      valorTotalCents: d.valorTotalCents,
      status: d.status,
      cStat: d.cStat,
      xMotivo: d.xMotivo,
      protocolo: d.protocolo,
      createdAt: d.createdAt,
    };
  }

  /** CONTINUAÇÃO DA NUMERAÇÃO do GigaNFe (mapeado 23/07 nas pastas locais):
   *    C:\NFe_LURDS → LURDS matriz 30.246.592/0001-97: última 518 (jun/26) → 519
   *    C:\NFe_TO    → RISSUTTO matriz 20.104.813/0001-39: última 2297 (abr/26,
   *                   cStat 100 produção) → 2298
   *  CNPJ que nunca emitiu mod 55 começa em 1 (ou via POST /nfe/sequence). */
  private startPadraoPara(cnpj: string, serie: string): number | undefined {
    // Varredura 23/07 de TODAS as instalações GigaNFe locais (última nNF
    // emitida por CNPJ, série 1, mod 55):
    // Só CNPJs ATIVOS na rede (dono 23/07: não listar loja encerrada).
    // Históricos achados na varredura, se algum dia voltarem: Jundiaí
    // 30246592000278 → 8 · Búzios/RJ 20104813000724 → 103 ·
    // raiz 28.110.859: 000253 → 30, 000415 → 31.
    const CONTINUACAO_GIGANFE: Record<string, number> = {
      '30246592000197': 519,  // LURDS matriz Itanhaém-1 — última 518 (jun/26)
      '20104813000139': 2298, // RISSUTTO matriz Itanhaém-2 — última 2297 (abr/26)
    };
    return CONTINUACAO_GIGANFE[cnpj] && serie === '1' ? CONTINUACAO_GIGANFE[cnpj] : undefined;
  }

  /** Garante que a sequência NUNCA fique ABAIXO da continuação do GigaNFe —
   *  conserta sequência criada antes do mapeamento (loja 01 nasceu em 1/2).
   *  Nunca REBAIXA número. */
  private async garantirContinuacao(storeCode: string, cnpj: string, serie: string) {
    const startPadrao = this.startPadraoPara(cnpj, serie);
    if (!startPadrao) return;
    const row = await this.prisma.nfeSequence.findUnique({
      where: { storeCode_modelo_serie: { storeCode, modelo: '55', serie } },
    });
    if (row && row.proximo < startPadrao) {
      await this.seq.setProximo(storeCode, serie, startPadrao);
      this.logger.warn(
        `[nfe] sequência ${storeCode}/55/${serie} corrigida: ${row.proximo} → ${startPadrao} (continuação GigaNFe do CNPJ ${cnpj})`,
      );
    }
  }

  /** Monta os dados da nota (fiscal origem/destino + itens a custo) — usado
   *  pela EMISSÃO (requireCert) e pela PRÉVIA (sem cert, sem numeração). */
  private async buildTransferData(
    shipment: any,
    opts: { requireCert: boolean },
  ): Promise<{
    origem: StoreFiscal;
    destino: StoreFiscal;
    items: Array<{ sku: string; ean: string; xProd: string; ncm: string; cfop: string; qty: number; vUn: number; vProd: number }>;
    valorTotal: number;
    warnings: string[];
    interestadual: boolean;
    cfop: string;
  }> {
    // Carrega o DESTINO primeiro; a ORIGEM escolhe a identidade cuja RAIZ casa
    // com a do destino (Itanhaém multi-empresa emite como LURDS 30 pra loja 30).
    const destino = await this.loadStoreFiscal(shipment.toStoreCode, { requireCert: false });
    const origem = await this.loadStoreFiscal(shipment.fromStoreCode, {
      ...opts,
      matchRaiz: destino.cnpj.slice(0, 8),
      // Raiz sem matriz cadastrada (MDD): emite pela config da PRÓPRIA loja destino
      preferStoreCode: String(shipment.toStoreCode || ''),
    });

    // Itens da remessa (uma linha por unidade) → agrupa por SKU.
    const rows = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id, realignmentStatus: { not: 'cancelled' } },
    });
    if (!rows.length) throw new BadRequestException('Remessa sem itens pra faturar');

    const grouped = new Map<string, { sku: string; qty: number; row: any }>();
    for (const r of rows as any[]) {
      const sku = String(r.codigoBipado || '').trim();
      if (!sku) continue; // sem código do ERP não dá pra faturar essa linha
      const g = grouped.get(sku) || { sku, qty: 0, row: r };
      g.qty += r.qtyOrigem || 1;
      grouped.set(sku, g);
    }
    if (!grouped.size) {
      throw new BadRequestException('Nenhum item com código do ERP (codigoBipado) pra faturar');
    }

    // Monta itens com custo + NCM do espelho.
    const warnings: string[] = [];
    const items: Array<{
      sku: string; ean: string; xProd: string; ncm: string; cfop: string;
      qty: number; vUn: number; vProd: number;
    }> = [];
    const interestadual = origem.ender.uf !== destino.ender.uf;
    const cfop = interestadual ? '6152' : '5152';

    for (const g of grouped.values()) {
      const info = await this.catalog.getPdvProductInfo(g.sku).catch(() => null);
      // Valor = CUSTO UNITÁRIO real (sem fator). Fallback base/2.5 só se sem custo.
      let vUn = Number(info?.custo) || 0;
      if (vUn <= 0) {
        const alt = (Number(info?.preco) || 0) / 2.5;
        vUn = Math.round(alt * 100) / 100;
        warnings.push(`SKU ${g.sku} sem custo cadastrado — usei base÷2,5 (R$ ${vUn.toFixed(2)})`);
      }
      vUn = Math.round(vUn * 100) / 100;
      const vProd = Math.round(vUn * g.qty * 100) / 100;
      const ncm = this.normNcm(info?.ncm, g.sku, warnings);
      items.push({
        sku: g.sku,
        // GTIN do schema aceita SÓ 8/12/13/14 dígitos — EAN torto do espelho
        // (7/9/11 díg, letra, espaço) derruba o LOTE inteiro com cStat 225.
        ean: this.gtinValido((info?.ean || '').trim()),
        xProd: (info?.descricao || g.row.descricao || g.sku).trim().slice(0, 120),
        ncm,
        cfop,
        qty: g.qty,
        vUn,
        vProd,
      });
    }

    const valorTotal = items.reduce((s, i) => s + i.vProd, 0);
    return { origem, destino, items, valorTotal, warnings, interestadual, cfop };
  }

  /**
   * PRÉVIA da NF-e (dono 23/07): tudo que a nota vai ter — SEM consumir
   * numeração, SEM assinar, SEM transmitir e SEM exigir certificado.
   */
  async previewForShipment(shipmentId: string) {
    const shipment = await this.prisma.realignmentShipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    this.checarLojaBloqueada(shipment);

    const jaAutorizada = await this.prisma.nfeDoc.findFirst({
      where: { shipmentId, status: 'authorized' },
    });

    const data = await this.buildTransferData(shipment, { requireCert: false });
    const { origem, destino } = data;

    // Espia o próximo número SEM incrementar (respeitando a continuação
    // do GigaNFe — nunca mostra número abaixo da última nota real)
    const serie = '1';
    const seqRow = await this.prisma.nfeSequence.findUnique({
      where: { storeCode_modelo_serie: { storeCode: this.digits(origem.cnpj), modelo: '55', serie } },
    });
    const startPadrao = this.startPadraoPara(origem.cnpj, serie);
    const proximoNumero = Math.max(seqRow?.proximo ?? 0, startPadrao ?? 0) || 1;

    const icmsMode = String(process.env.NFE_TRANSFER_ICMS ?? 'destacado').trim();
    const crt3 = String(origem.regime || '1') === '3';
    const interEmpresa = origem.cnpj.slice(0, 8) !== destino.cnpj.slice(0, 8);

    return {
      ok: true,
      jaEmitida: !!jaAutorizada,
      docAutorizado: jaAutorizada ? this.publicDoc(jaAutorizada) : null,
      remessa: { code: shipment.code, de: shipment.fromStoreCode, para: shipment.toStoreCode },
      emitente: { cnpj: origem.cnpj, razaoSocial: origem.razaoSocial, ie: origem.ie, uf: origem.ender.uf, ambiente: origem.ambiente, regime: origem.regime },
      destinatario: { cnpj: destino.cnpj, razaoSocial: destino.razaoSocial, ie: destino.ie, uf: destino.ender.uf },
      serie,
      proximoNumero,
      cfop: data.cfop,
      interestadual: data.interestadual,
      icms: crt3
        ? (icmsMode === 'destacado'
          ? { modo: 'destacado', descricao: `ICMS destacado (CST 00, ${data.interestadual ? '12' : '18'}%) — modelo das notas antigas do GigaNFe` }
          : { modo: 'sem', descricao: 'SEM destaque de ICMS (CST 41 — operação não tributada)' })
        : { modo: 'simples', descricao: 'Simples Nacional — CSOSN 400' },
      interEmpresa,
      avisoInterEmpresa: interEmpresa
        ? `ATENÇÃO: origem (raiz ${origem.cnpj.slice(0, 8)}) e destino (raiz ${destino.cnpj.slice(0, 8)}) são EMPRESAS DIFERENTES — juridicamente não é transferência (CFOP 5152/6152 pode ser indevido). Confirme a natureza da operação com o contador antes de emitir.`
        : null,
      items: data.items,
      valorTotal: Math.round(data.valorTotal * 100) / 100,
      warnings: data.warnings,
    };
  }

  private async loadStoreFiscal(
    storeCode: string,
    opts: { requireCert: boolean; identidade?: 'nfe' | 'base'; matchRaiz?: string; preferStoreCode?: string } = { requireCert: true },
  ): Promise<StoreFiscal> {
    const cfg = await this.prisma.nfceConfig.findUnique({ where: { storeCode } });
    if (!cfg) {
      throw new BadRequestException(`Loja ${storeCode} sem config fiscal (NfceConfig). Configure CNPJ/IE/endereço/certificado.`);
    }

    // IDENTIDADE DA NF-e (dono 24/07). Regra CRÍTICA (bug 24/07: Praia Grande
    // saiu com endereço da MATRIZ): CNPJ, razão social e endereço de um
    // estabelecimento NÃO se misturam. Se a NF-e sai sob um CNPJ DIFERENTE da
    // NFC-e (alinhamento de máquina de cartão), a identidade INTEIRA tem que ser
    // a da NF-e — razão/IE/endereço NÃO caem nos dados da NFC-e (é outro CNPJ).
    // Loja normal (NF-e == NFC-e) não preenche os campos nfe* e usa os principais.
    // identidade='base' (VENDA no PDV): usa SEMPRE os dados da NFC-e (mesmo
    // estabelecimento que vendeu). Só a TRANSFERÊNCIA usa a identidade própria.
    const nfeCnpjD = this.digits(String(cfg.nfeCnpj || ''));
    const baseCnpjD = this.digits(String(cfg.cnpj || ''));
    const identidadePropria =
      opts.identidade !== 'base' && nfeCnpjD.length === 14 && nfeCnpjD !== baseCnpjD;

    let cnpjSrc: string;
    let ieSrc: string;
    let razaoSrc: string;
    let fantasiaSrc: string;
    let regimeSrc: string;
    let enderecoSrc: string;
    let identidadeEmprestada = false;
    if (identidadePropria) {
      cnpjSrc = String(cfg.nfeCnpj);
      ieSrc = String(cfg.nfeIe || '');
      razaoSrc = String(cfg.nfeRazaoSocial || '');
      fantasiaSrc = String(cfg.nfeFantasia || cfg.nfeRazaoSocial || '');
      regimeSrc = String(cfg.nfeRegime || cfg.regime || '1');
      enderecoSrc = String(cfg.nfeEndereco || '');
      // Identidade da NF-e TEM que ser completa — sem herdar da NFC-e.
      const faltaNfe: string[] = [];
      if (this.digits(ieSrc).length < 2) faltaNfe.push('Inscrição Estadual');
      if (razaoSrc.trim().length < 2) faltaNfe.push('Razão Social');
      if (!enderecoSrc.trim()) faltaNfe.push('Endereço');
      if (faltaNfe.length) {
        throw new BadRequestException(
          `Loja ${storeCode}: a NF-e sai sob o CNPJ ${cnpjSrc} (diferente da NFC-e), então precisa da IDENTIDADE COMPLETA da NF-e. Faltou: ${faltaNfe.join(', ')}. Preencha em Config → NFC-e → seção "Dados da NF-e". A NF-e NÃO pode usar razão/endereço da NFC-e (é outro estabelecimento).`,
        );
      }
    } else {
      cnpjSrc = String(cfg.cnpj || '');
      ieSrc = String(cfg.ie || '');
      razaoSrc = String(cfg.razaoSocial || '');
      fantasiaSrc = String(cfg.fantasia || cfg.razaoSocial || '');
      regimeSrc = String(cfg.regime || '1');
      enderecoSrc = String(cfg.endereco || '');
    }

    // IDENTIDADE POR DESTINO (dono 24/07): loja com mais de uma empresa (ex.:
    // Itanhaém = RISSUTTO 20 + LURDS 30). Se pediram matchRaiz (a raiz do
    // DESTINO da transferência) e a identidade primária NÃO é dessa raiz,
    // procura nas EXTRAS uma cujo CNPJ seja dessa raiz — e emite por ela, pra
    // origem e destino serem a MESMA empresa (transferência de verdade).
    if (opts.matchRaiz && opts.matchRaiz.length === 8 && this.digits(cnpjSrc).slice(0, 8) !== opts.matchRaiz) {
      const extras = this.parseIdentidadesExtras(cfg.nfeIdentidadesExtras);
      let alt: any = extras.find((e) => this.digits(String(e.cnpj || '')).slice(0, 8) === opts.matchRaiz) || null;

      // REGRA DO DONO (28/07): se a PRÓPRIA loja origem não tem identidade da
      // raiz do destino (ex.: Sorocaba raiz 20 → Limeira raiz 30), procura no
      // GRUPO INTEIRO e emite pela empresa dessa raiz (ex.: LURDS Itanhaém).
      // Preferência: config primária da matriz (/0001) da raiz → primária de
      // qualquer irmã → identidade extra cadastrada em qualquer loja.
      // SÓ A NOTA muda de emitente — etiqueta/transferência física seguem iguais.
      if (!alt) {
        const todas = await this.prisma.nfceConfig.findMany({
          select: { storeCode: true, cnpj: true, ie: true, razaoSocial: true, fantasia: true, regime: true, endereco: true, nfeIdentidadesExtras: true },
        });
        const daRaiz = todas.filter((c) => this.digits(String(c.cnpj || '')).slice(0, 8) === opts.matchRaiz);
        // ORDEM (dono 29/07: "remetente EXATO — 01→Anália saiu como Suzano"):
        // 1º matriz /0001 da raiz (regra LURDS) · 2º a config da PRÓPRIA LOJA
        // DESTINO (raiz sem matriz cadastrada, ex. MDD) · 3º qualquer irmã.
        const prim =
          daRaiz.find((c) => this.digits(String(c.cnpj)).slice(8, 12) === '0001') ||
          (opts.preferStoreCode ? daRaiz.find((c) => c.storeCode === opts.preferStoreCode) : undefined) ||
          daRaiz[0];
        if (prim) {
          alt = { cnpj: prim.cnpj, ie: prim.ie, razaoSocial: prim.razaoSocial, fantasia: prim.fantasia, regime: prim.regime, endereco: prim.endereco };
          this.logger.log(`[nfe] transferência ${storeCode} → raiz ${opts.matchRaiz}: nota emitida pela identidade da loja ${prim.storeCode} (mesma raiz do destino)`);
        } else {
          for (const c of todas) {
            const ex = this.parseIdentidadesExtras(c.nfeIdentidadesExtras).find((e2: any) => this.digits(String(e2.cnpj || '')).slice(0, 8) === opts.matchRaiz);
            if (ex) {
              alt = ex;
              this.logger.log(`[nfe] transferência ${storeCode} → raiz ${opts.matchRaiz}: nota emitida pela identidade extra cadastrada na loja ${c.storeCode}`);
              break;
            }
          }
        }
      }

      if (alt) {
        identidadeEmprestada = true;
        cnpjSrc = this.digits(String(alt.cnpj || ''));
        ieSrc = this.digits(String(alt.ie || ''));
        razaoSrc = String(alt.razaoSocial || '').trim();
        fantasiaSrc = String(alt.fantasia || alt.razaoSocial || '').trim();
        regimeSrc = String(alt.regime || cfg.regime || '1');
        enderecoSrc = typeof alt.endereco === 'string' ? alt.endereco : JSON.stringify(alt.endereco || {});
        const falta: string[] = [];
        if (cnpjSrc.length !== 14) falta.push('CNPJ');
        if (ieSrc.length < 2) falta.push('IE');
        if (razaoSrc.length < 2) falta.push('Razão Social');
        if (!enderecoSrc || enderecoSrc === '{}') falta.push('Endereço');
        if (falta.length) {
          throw new BadRequestException(
            `Loja ${storeCode}: a identidade extra (raiz ${opts.matchRaiz}) pra emitir ao destino está incompleta. Faltou: ${falta.join(', ')}. Complete em Config → NFC-e → "Outras razões da loja".`,
          );
        }
      }
      // Sem extra dessa raiz → segue com a primária (o bloqueio inter-empresa avisa).
    }

    const raizNfe = this.digits(cnpjSrc).slice(0, 8);

    // CERTIFICADO POR EMPRESA: um A1 por RAIZ de CNPJ. O cert precisa bater com
    // a raiz do CNPJ que VAI EMITIR (cnpjSrc) — não com o CNPJ da NFC-e. Loja
    // com CNPJ-NFC-e de outra raiz NÃO usa o próprio cert pra NF-e.
    let certPfxB64: string | null = null;
    let certPfxPass: string | null = null;
    // 1. cert próprio, SÓ se a raiz dele (= raiz do cnpj do config) casar com a raiz da NF-e
    if (cfg.certPfxB64 && cfg.certPfxPass && this.digits(String(cfg.cnpj)).slice(0, 8) === raizNfe) {
      certPfxB64 = cfg.certPfxB64 as string;
      certPfxPass = cfg.certPfxPass as string;
    }
    // 2. senão, herda o A1 da MATRIZ (/0001) da raiz da NF-e (qualquer irmã com cert)
    if ((!certPfxB64 || !certPfxPass) && raizNfe.length === 8) {
      const irmas = await this.prisma.nfceConfig.findMany({
        where: { certPfxB64: { not: null }, certPfxPass: { not: null }, cnpj: { not: null } },
        select: { storeCode: true, cnpj: true, certPfxB64: true, certPfxPass: true },
      });
      const daRaiz = irmas.filter((c) => this.digits(String(c.cnpj)).slice(0, 8) === raizNfe);
      const doadora =
        daRaiz.find((c) => this.digits(String(c.cnpj)).slice(8, 12) === '0001') || daRaiz[0];
      if (doadora) {
        certPfxB64 = doadora.certPfxB64 as string;
        certPfxPass = doadora.certPfxPass as string;
        this.logger?.log?.(
          `[nfe] loja ${storeCode} usando certificado da loja ${doadora.storeCode} (matriz da raiz ${raizNfe})`,
        );
      }
    }

    const faltando: string[] = [];
    if (!cnpjSrc) faltando.push('CNPJ');
    if (!ieSrc) faltando.push('IE');
    if (opts.requireCert && (!certPfxB64 || !certPfxPass)) faltando.push('certificado A1 (nem próprio, nem da matriz da mesma raiz de CNPJ)');
    if (!enderecoSrc) faltando.push('endereço');
    if (faltando.length) {
      throw new BadRequestException(`Loja ${storeCode} sem ${faltando.join(', ')} na config fiscal da NF-e`);
    }
    let ender: any;
    try {
      ender = JSON.parse(enderecoSrc);
    } catch {
      throw new BadRequestException(`Endereço fiscal da NF-e da loja ${storeCode} inválido (JSON)`);
    }
    if (!ender?.codMunicipio) {
      throw new BadRequestException(`Loja ${storeCode} sem codMunicipio (IBGE) no endereço fiscal da NF-e`);
    }
    // PRÉ-VALIDAÇÃO dos padrões do schema — erro aqui rejeitava o LOTE com
    // cStat 225 genérico e queimava número (23/07: CEP de Itanhaém com 9
    // dígitos "117466694" rejeitou 2298–2304). Agora a PRÉVIA já acusa o
    // campo errado em português, antes de numerar/assinar.
    const problemas: string[] = [];
    const cnpjD = this.digits(cnpjSrc);
    if (cnpjD.length !== 14) problemas.push(`CNPJ "${cnpjSrc}" inválido (precisa de 14 dígitos)`);
    const ieD = this.digits(ieSrc);
    if (ieD.length < 2 || ieD.length > 14) problemas.push(`IE "${ieSrc}" inválida (2–14 dígitos)`);
    const cepD = this.digits(String(ender.cep || ''));
    if (cepD.length !== 8) problemas.push(`CEP "${ender.cep}" inválido (precisa de 8 dígitos — está com ${cepD.length})`);
    if (!/^\d{7}$/.test(String(ender.codMunicipio).trim())) {
      problemas.push(`código IBGE do município "${ender.codMunicipio}" inválido (7 dígitos)`);
    }
    if (problemas.length) {
      throw new BadRequestException(
        `Config fiscal da NF-e da loja ${storeCode} com dados inválidos: ${problemas.join(' · ')}. Corrija no cadastro fiscal e tente de novo.`,
      );
    }
    return {
      storeCode,
      cnpj: this.digits(cnpjSrc),
      ie: this.digits(ieSrc),
      razaoSocial: razaoSrc.trim(),
      fantasia: fantasiaSrc.trim(),
      identidadeEmprestada,
      uf: (cfg.uf || ender.uf || 'SP').toUpperCase(),
      ambiente: (cfg.ambiente === '1' ? '1' : '2') as '1' | '2',
      regime: regimeSrc,
      certPfxB64: certPfxB64 as string,
      certPfxPass: certPfxPass as string,
      ender: {
        logradouro: String(ender.logradouro || '').trim(),
        numero: String(ender.numero || 'S/N').trim(),
        complemento: ender.complemento ? String(ender.complemento).trim() : undefined,
        bairro: String(ender.bairro || '').trim(),
        municipio: String(ender.municipio || '').trim(),
        cep: this.digits(String(ender.cep || '')),
        uf: String(ender.uf || cfg.uf || 'SP').toUpperCase(),
        codMunicipio: String(ender.codMunicipio).trim(),
        fone: ender.fone ? this.digits(String(ender.fone)) : undefined,
      },
    };
  }

  private digits(s: string): string {
    return String(s || '').replace(/\D/g, '');
  }

  /** Lê o JSON de identidades fiscais extras da loja (multi-empresa). */
  private parseIdentidadesExtras(raw: any): Array<{
    cnpj?: string; ie?: string; razaoSocial?: string; fantasia?: string; regime?: string; endereco?: any;
  }> {
    if (!raw) return [];
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** Lojas fora da NF-e por enquanto (dono 23/07: Sorocaba tem CNPJ errado na
   *  config fiscal — consumiu numeração da LURDS matriz). Ajuste via env
   *  NFE_LOJAS_BLOQUEADAS (lista separada por vírgula; vazio = nenhuma). */
  private checarLojaBloqueada(shipment: { fromStoreCode: string; toStoreCode: string }) {
    // Dono 24/07: liberar emissão de TODAS as unidades (default vazio). O
    // bloqueio por loja fica só como válvula manual via NFE_LOJAS_BLOQUEADAS.
    const bloqueadas = String(process.env.NFE_LOJAS_BLOQUEADAS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    for (const code of [shipment.fromStoreCode, shipment.toStoreCode]) {
      if (bloqueadas.includes(String(code))) {
        throw new BadRequestException(
          `Loja ${code} está FORA da NF-e por enquanto (config fiscal em revisão — CNPJ). Corrija o cadastro fiscal e remova da env NFE_LOJAS_BLOQUEADAS.`,
        );
      }
    }
  }

  /** cEAN/cEANTrib: pattern do XSD é "SEM GTIN" ou 8/12/13/14 dígitos. */
  private gtinValido(ean: string): string {
    return /^(\d{8}|\d{12,14})$/.test(ean) ? ean : 'SEM GTIN';
  }

  private normNcm(ncm: any, sku: string, warnings: string[]): string {
    const n = this.digits(String(ncm || ''));
    if (n.length === 8) return n;
    warnings.push(`SKU ${sku} sem NCM válido — usei ${NfeTransferService.NCM_FALLBACK} (vestuário) provisório`);
    return NfeTransferService.NCM_FALLBACK;
  }

  // NCM de vestuário genérico e VÁLIDO na tabela oficial — fallback quando o
  // cadastro tem NCM inexistente. 6217.90.00 = "outras partes/acessórios de
  // vestuário". Como é transferência a custo (CSOSN 400, imposto zero), o NCM
  // exato não muda tributação — só precisa EXISTIR pra SEFAZ aceitar.
  private static readonly NCM_FALLBACK = '62179000';

  /**
   * cStat 778 (NCM inexistente [nItem:X]): troca o NCM ruim do item apontado —
   * e de TODOS os itens com o MESMO NCM errado — pelo fallback válido, pra a
   * emissão auto-corrigir e re-tentar. Retorna true se corrigiu algo.
   */
  private corrigirNcmInvalido(
    items: Array<{ ncm: string; sku: string }>,
    xMotivo: string | undefined,
  ): boolean {
    const m = String(xMotivo || '').match(/nItem:\s*(\d+)/i);
    if (!m) return false;
    const idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= items.length) return false;
    const ruim = items[idx].ncm;
    if (!ruim || ruim === NfeTransferService.NCM_FALLBACK) return false; // já é o fallback
    let n = 0;
    for (const it of items) {
      if (it.ncm === ruim) { it.ncm = NfeTransferService.NCM_FALLBACK; n++; }
    }
    this.logger.warn(
      `[nfe] NCM inexistente "${ruim}" corrigido pra ${NfeTransferService.NCM_FALLBACK} em ${n} item(ns) → re-tentando`,
    );
    return n > 0;
  }

  private dhEmiNow(): string {
    // ISO com offset -03:00 (Brasília sem DST). SEFAZ 4.00 rejeita 'Z'.
    const now = new Date();
    const local = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    return local.toISOString().slice(0, 19) + '-03:00';
  }

  private calcDV(chave43: string): string {
    const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
    let soma = 0;
    for (let i = chave43.length - 1, p = 0; i >= 0; i--, p = (p + 1) % pesos.length) {
      soma += parseInt(chave43[i], 10) * pesos[p];
    }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    return String(dv);
  }

  private buildChave(input: {
    cUF: string; cnpj: string; serie: string; numero: number; cNF: string; dataEmissao: Date;
  }): string {
    const aamm =
      String(input.dataEmissao.getFullYear()).slice(-2) +
      String(input.dataEmissao.getMonth() + 1).padStart(2, '0');
    const semDv =
      input.cUF.padStart(2, '0') +
      aamm +
      input.cnpj.padStart(14, '0') +
      '55' +
      String(input.serie).padStart(3, '0') +
      String(input.numero).padStart(9, '0') +
      '1' + // tpEmis normal
      input.cNF.padStart(8, '0');
    return semDv + this.calcDV(semDv);
  }

  private money(v: number): string {
    return (Math.round(v * 100) / 100).toFixed(2);
  }

  private buildEnder(e: StoreFiscal['ender']): string {
    return (
      `<xLgr>${this.esc(e.logradouro)}</xLgr>` +
      `<nro>${this.esc(e.numero)}</nro>` +
      (e.complemento ? `<xCpl>${this.esc(e.complemento)}</xCpl>` : '') +
      `<xBairro>${this.esc(e.bairro)}</xBairro>` +
      `<cMun>${e.codMunicipio}</cMun>` +
      `<xMun>${this.esc(e.municipio)}</xMun>` +
      `<UF>${e.uf}</UF>` +
      `<CEP>${e.cep}</CEP>` +
      `<cPais>1058</cPais><xPais>BRASIL</xPais>` +
      (e.fone ? `<fone>${e.fone}</fone>` : '')
    );
  }

  private esc(s: string): string {
    return String(s || '')
      // caractere de controle (lixo de cadastro) é XML inválido → fora
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Descrição do item NA NOTA (dono 29/07): só a PRIMEIRA palavra — "BLUSA"
   *  em vez de "BLUSA FEMININA MANGA CURTA...". A SEFAZ aceita (campo livre
   *  1-120); a identificação fina segue no cProd/cEAN + NCM. Kill-switch:
   *  NFE_XPROD=completo volta ao texto inteiro. */
  private xProdNota(desc: string): string {
    if (String(process.env.NFE_XPROD || '').trim() === 'completo') {
      return String(desc || 'MERCADORIA');
    }
    return (String(desc || '').trim().split(/\s+/)[0] || 'MERCADORIA').slice(0, 120);
  }

  /** Alíquotas PIS/COFINS do Lucro Presumido (cumulativo) — destaque exigido
   *  pelo contador (29/07): PIS 0,65% e COFINS 3% sobre o valor do item. */
  private aliqPisCofins() {
    return {
      pPIS: Number(process.env.NFE_ALIQ_PIS ?? 0.65),
      pCOFINS: Number(process.env.NFE_ALIQ_COFINS ?? 3.0),
    };
  }

  /** Reforma Tributária (NT 2025.002): grupo IBS/CBS da NF-e — MESMO molde do
   *  NFC-e (validado em produção). CRT 3 desde 2026; alíquotas de teste da LC
   *  214/2025 (IBS UF 0,10 + Mun 0,00 + CBS 0,90), POR FORA — não somam no
   *  vNF. Kill-switch: NFE_IBSCBS=0. */
  private ibscbsCfg(crt3: boolean) {
    return {
      on: crt3 && process.env.NFE_IBSCBS !== '0',
      pIBSUF: Number(process.env.NFE_ALIQ_IBSUF ?? 0.10),
      pIBSMun: Number(process.env.NFE_ALIQ_IBSMUN ?? 0.0),
      pCBS: Number(process.env.NFE_ALIQ_CBS ?? 0.90),
      cst: String(process.env.NFE_IBSCBS_CST || '000'),
      cClassTrib: String(process.env.NFE_IBSCBS_CCLASSTRIB || '000001'),
    };
  }

  private ibscbsItem(cfg: ReturnType<NfeTransferService['ibscbsCfg']>, vBC: number) {
    if (!cfg.on) return { xml: '', vIBSUF: 0, vIBSMun: 0, vCBS: 0 };
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const vIBSUF = r2(vBC * (cfg.pIBSUF / 100));
    const vIBSMun = r2(vBC * (cfg.pIBSMun / 100));
    const vCBS = r2(vBC * (cfg.pCBS / 100));
    const xml =
      `<IBSCBS><CST>${cfg.cst}</CST><cClassTrib>${cfg.cClassTrib}</cClassTrib>` +
      `<gIBSCBS><vBC>${vBC.toFixed(2)}</vBC>` +
      `<gIBSUF><pIBSUF>${cfg.pIBSUF.toFixed(4)}</pIBSUF><vIBSUF>${vIBSUF.toFixed(2)}</vIBSUF></gIBSUF>` +
      `<gIBSMun><pIBSMun>${cfg.pIBSMun.toFixed(4)}</pIBSMun><vIBSMun>${vIBSMun.toFixed(2)}</vIBSMun></gIBSMun>` +
      `<vIBS>${(vIBSUF + vIBSMun).toFixed(2)}</vIBS>` +
      `<gCBS><pCBS>${cfg.pCBS.toFixed(4)}</pCBS><vCBS>${vCBS.toFixed(2)}</vCBS></gCBS>` +
      `</gIBSCBS></IBSCBS>`;
    return { xml, vIBSUF, vIBSMun, vCBS };
  }

  private ibscbsTot(
    cfg: ReturnType<NfeTransferService['ibscbsCfg']>,
    t: { vBC: number; vIBSUF: number; vIBSMun: number; vCBS: number },
    vNF: string,
  ) {
    if (!cfg.on) return '';
    return (
      `<IBSCBSTot><vBCIBSCBS>${t.vBC.toFixed(2)}</vBCIBSCBS>` +
      `<gIBS><gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>${t.vIBSUF.toFixed(2)}</vIBSUF></gIBSUF>` +
      `<gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>${t.vIBSMun.toFixed(2)}</vIBSMun></gIBSMun>` +
      `<vIBS>${(t.vIBSUF + t.vIBSMun).toFixed(2)}</vIBS><vCredPres>0.00</vCredPres><vCredPresCondSus>0.00</vCredPresCondSus></gIBS>` +
      `<gCBS><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vCBS>${t.vCBS.toFixed(2)}</vCBS><vCredPres>0.00</vCredPres><vCredPresCondSus>0.00</vCredPresCondSus></gCBS>` +
      `</IBSCBSTot><vNFTot>${vNF}</vNFTot>`
    );
  }

  /** Regra do transporte da remessa (dono 29/07): escolhido na tela
   *  (transportMode) ou automático — até 10 peças → Correios; acima → próprio. */
  private transporteDaRemessa(shipment: any, items: Array<{ qty: number }>): 'correios' | 'proprio' {
    const m = String(shipment?.transportMode || '');
    if (m === 'correios' || m === 'proprio') return m as any;
    const pecas = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    return pecas <= 10 ? 'correios' : 'proprio';
  }

  private buildXml(p: {
    chave: string; cUF: string; cNF: string; serie: string; numero: number;
    dhEmi: string; tpAmb: '1' | '2'; natOp: string;
    origem: StoreFiscal; destino: StoreFiscal; interestadual: boolean;
    items: Array<{ sku: string; ean: string; xProd: string; ncm: string; cfop: string; qty: number; vUn: number; vProd: number }>;
    valorTotal: number; remCode: string;
    /** Override do modFrete (regra do transporte da remessa: correios → '9'). */
    modFrete?: string;
  }): string {
    const homolog = p.tpAmb === '2';
    const destNome = homolog ? HOMOLOG_FRASE : (p.destino.razaoSocial || 'DESTINATARIO');
    const idDest = p.interestadual ? '2' : '1';

    const ide =
      `<ide>` +
      `<cUF>${p.cUF}</cUF>` +
      `<cNF>${p.cNF.padStart(8, '0')}</cNF>` +
      `<natOp>${this.esc(p.natOp)}</natOp>` +
      `<mod>55</mod>` +
      `<serie>${p.serie}</serie>` +
      `<nNF>${p.numero}</nNF>` +
      `<dhEmi>${p.dhEmi}</dhEmi>` +
      `<dhSaiEnt>${p.dhEmi}</dhSaiEnt>` +
      `<tpNF>1</tpNF>` +
      `<idDest>${idDest}</idDest>` +
      `<cMunFG>${p.origem.ender.codMunicipio}</cMunFG>` +
      `<tpImp>1</tpImp>` +
      `<tpEmis>1</tpEmis>` +
      `<cDV>${p.chave.slice(-1)}</cDV>` +
      `<tpAmb>${p.tpAmb}</tpAmb>` +
      `<finNFe>1</finNFe>` +
      `<indFinal>0</indFinal>` +
      `<indPres>0</indPres>` +
      `<procEmi>0</procEmi>` +
      `<verProc>FlowOps-NFe-1.0</verProc>` +
      `</ide>`;

    const emit =
      `<emit>` +
      `<CNPJ>${p.origem.cnpj}</CNPJ>` +
      `<xNome>${this.esc(p.origem.razaoSocial)}</xNome>` +
      (p.origem.fantasia ? `<xFant>${this.esc(p.origem.fantasia)}</xFant>` : '') +
      `<enderEmit>${this.buildEnder(p.origem.ender)}</enderEmit>` +
      `<IE>${p.origem.ie}</IE>` +
      `<CRT>${p.origem.regime || '1'}</CRT>` +
      `</emit>`;

    const dest =
      `<dest>` +
      `<CNPJ>${p.destino.cnpj}</CNPJ>` +
      `<xNome>${this.esc(destNome)}</xNome>` +
      `<enderDest>${this.buildEnder(p.destino.ender)}</enderDest>` +
      `<indIEDest>1</indIEDest>` +
      `<IE>${p.destino.ie}</IE>` +
      `</dest>`;

    // Contador autorizado a baixar o XML — presente em TODAS as notas reais
    // do GigaNFe (mapeado em C:\NFe_LURDS, 23/07). Override via env.
    const autXmlCnpj = String(process.env.NFE_AUTXML_CNPJ ?? '11145597000189').replace(/\D/g, '');
    const autXML = autXmlCnpj ? `<autXML><CNPJ>${autXmlCnpj}</CNPJ></autXML>` : '';

    // ICMS DA TRANSFERÊNCIA (dono 23/07: "transferência não pode gerar
    // imposto") — NFE_TRANSFER_ICMS:
    //   'sem' (DEFAULT): CST 41 (não tributada) — sem destaque, totais zerados
    //   'destacado': ICMS00 CST 00 (18% interna / 12% interestadual) — modelo
    //     das notas antigas do GigaNFe (nº 518). Confirmar com o contador.
    //   CRT 1 (Simples): CSOSN 400 sempre.
    // LUCRO PRESUMIDO (contador 29/07): DESTACAR ICMS 18% (transferência de
    // crédito — Anexo XI Port. SRE 41/2023), PIS 0,65% e COFINS 3%.
    // Kill-switch do destaque: NFE_TRANSFER_ICMS=sem (volta CST 90 + cBenef).
    const crt3 = String(p.origem.regime || '1') === '3';
    const icmsDestacado = crt3 && String(process.env.NFE_TRANSFER_ICMS ?? 'destacado').trim() === 'destacado';
    const aliqInterna = Number(process.env.NFE_ICMS_ALIQ_INTERNA ?? 18);
    const aliqInter = Number(process.env.NFE_ICMS_ALIQ_INTERESTADUAL ?? 12);
    const { pPIS, pCOFINS } = this.aliqPisCofins();
    // IBS/CBS SÓ NAS VENDAS (contador 29/07): transferência entre mesmo
    // titular NÃO leva o grupo (é zero) — as notas 2332/2334 autorizaram sem
    // ele. Grupo desligado aqui; a VENDA (buildVendaXml) continua com ele.
    const ib = this.ibscbsCfg(false);

    // cBenef (SEFAZ-SP exige com CST 40/41 desde 04/2026 — cStat 930 sem ele;
    // "SEM CBENEF" foi DESATIVADO em 01/07/2026 → cStat 946). Vai no <prod>,
    // entre NCM e CFOP. Default SP099000 = "Remessas de mercadorias entre
    // estabelecimentos do mesmo titular" (Tabela cBenef SP v2026-06-26;
    // observar Anexo XI da Portaria SRE 41/2023). Override: NFE_CBENEF_TRANSFERENCIA.
    const cBenefTransf = String(process.env.NFE_CBENEF_TRANSFERENCIA ?? 'SP099000').trim();
    const usaCBenef = crt3 && !icmsDestacado && cBenefTransf !== '0';

    let totBC = 0;
    let totICMS = 0;
    let totPIS = 0;
    let totCOFINS = 0;
    const ibTot = { vBC: 0, vIBSUF: 0, vIBSMun: 0, vCBS: 0 };
    const det = p.items
      .map((it, idx) => {
        const xProd = homolog ? HOMOLOG_FRASE : this.xProdNota(it.xProd);
        const prod =
          `<prod>` +
          `<cProd>${this.esc(it.sku)}</cProd>` +
          `<cEAN>${it.ean}</cEAN>` +
          `<xProd>${this.esc(xProd)}</xProd>` +
          `<NCM>${it.ncm}</NCM>` +
          (usaCBenef ? `<cBenef>${this.esc(cBenefTransf)}</cBenef>` : '') +
          `<CFOP>${it.cfop}</CFOP>` +
          `<uCom>UN</uCom>` +
          `<qCom>${it.qty.toFixed(4)}</qCom>` +
          `<vUnCom>${this.money(it.vUn)}</vUnCom>` +
          `<vProd>${this.money(it.vProd)}</vProd>` +
          `<cEANTrib>${it.ean}</cEANTrib>` +
          `<uTrib>UN</uTrib>` +
          `<qTrib>${it.qty.toFixed(4)}</qTrib>` +
          `<vUnTrib>${this.money(it.vUn)}</vUnTrib>` +
          `<indTot>1</indTot>` +
          `</prod>`;
        let icms: string;
        if (icmsDestacado) {
          const interestadual = String(it.cfop).startsWith('6');
          const pIcms = interestadual ? aliqInter : aliqInterna;
          const vBC = Math.round(it.vProd * 100) / 100;
          const vIcms = Math.round(vBC * pIcms) / 100;
          totBC += vBC;
          totICMS += vIcms;
          icms =
            `<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC>` +
            `<vBC>${this.money(vBC)}</vBC><pICMS>${pIcms.toFixed(4)}</pICMS><vICMS>${this.money(vIcms)}</vICMS>` +
            `</ICMS00></ICMS>`;
        } else if (crt3) {
          // Transferência SEM destaque: CST 90 + cBenef SP099000. A tabela
          // cBenef de SP (v2026-06-26) só aceita o código de "remessas entre
          // estabelecimentos do mesmo titular" com CST 90 — com CST 41 a SEFAZ
          // rejeitava com cStat 931 (incompatível com CST e UF).
          icms = `<ICMS><ICMS90><orig>0</orig><CST>90</CST></ICMS90></ICMS>`;
        } else {
          icms = `<ICMS><ICMSSN102><orig>0</orig><CSOSN>400</CSOSN></ICMSSN102></ICMS>`;
        }
        // Presumido: PIS 0,65% e COFINS 3% destacados sobre o item (contador 29/07)
        const vBCItem = Math.round(it.vProd * 100) / 100;
        const vPisItem = crt3 ? Math.round(vBCItem * pPIS) / 100 : 0;
        const vCofItem = crt3 ? Math.round(vBCItem * pCOFINS) / 100 : 0;
        totPIS += vPisItem;
        totCOFINS += vCofItem;
        const pisCofins = crt3
          ? `<PIS><PISAliq><CST>01</CST><vBC>${this.money(vBCItem)}</vBC><pPIS>${pPIS.toFixed(4)}</pPIS><vPIS>${this.money(vPisItem)}</vPIS></PISAliq></PIS>` +
            `<COFINS><COFINSAliq><CST>01</CST><vBC>${this.money(vBCItem)}</vBC><pCOFINS>${pCOFINS.toFixed(4)}</pCOFINS><vCOFINS>${this.money(vCofItem)}</vCOFINS></COFINSAliq></COFINS>`
          : `<PIS><PISOutr><CST>99</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>` +
            `<COFINS><COFINSOutr><CST>99</CST><vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>`;
        const ibi = this.ibscbsItem(ib, vBCItem);
        if (ib.on) {
          ibTot.vBC += vBCItem;
          ibTot.vIBSUF += ibi.vIBSUF;
          ibTot.vIBSMun += ibi.vIBSMun;
          ibTot.vCBS += ibi.vCBS;
        }
        const imposto =
          `<imposto>` +
          icms +
          `<IPI><cEnq>999</cEnq><IPITrib><CST>99</CST><vBC>0.00</vBC><pIPI>0.0000</pIPI><vIPI>0.00</vIPI></IPITrib></IPI>` +
          pisCofins +
          ibi.xml +
          `</imposto>`;
        // vItem (grupo VB, NT 2025.002): OBRIGATÓRIO junto do IBSCBS — sem
        // ele o lote caía com cStat 225 "Falha no Schema XML" (29/07).
        const vItemTag = ib.on ? `<vItem>${vBCItem.toFixed(2)}</vItem>` : '';
        return `<det nItem="${idx + 1}">${prod}${imposto}${vItemTag}</det>`;
      })
      .join('');

    const vTot = this.money(p.valorTotal);
    const total =
      `<total><ICMSTot>` +
      `<vBC>${this.money(totBC)}</vBC><vICMS>${this.money(totICMS)}</vICMS><vICMSDeson>0.00</vICMSDeson>` +
      `<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>` +
      `<vProd>${vTot}</vProd>` +
      `<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII>` +
      `<vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>${this.money(totPIS)}</vPIS><vCOFINS>${this.money(totCOFINS)}</vCOFINS>` +
      `<vOutro>0.00</vOutro><vNF>${vTot}</vNF>` +
      `</ICMSTot>${this.ibscbsTot(ib, ibTot, vTot)}</total>`;

    // TRANSPORTE PRÓPRIO por conta do remetente (modFrete=3, "veículo próprio"
    // — dono 24/07) + VOLUME(S). Peso TOTAL = nº peças × 0,25 kg. Nº de volumes
    // = 1 a cada 40 peças (dono 24/07: 40→1, 80→2, 120→3). Envs:
    // NFE_MODFRETE, NFE_PESO_POR_PECA_KG, NFE_PECAS_POR_VOLUME.
    const totalPecas = p.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    const pesoPorPeca = Number(process.env.NFE_PESO_POR_PECA_KG ?? 0.25) || 0.25;
    const pecasPorVol = Number(process.env.NFE_PECAS_POR_VOLUME ?? 40) || 40;
    const pesoKg = (totalPecas * pesoPorPeca).toFixed(3);
    const qVol = Math.max(1, Math.ceil(totalPecas / pecasPorVol));
    const modFrete = String(p.modFrete || process.env.NFE_MODFRETE || '3').trim();
    const transp =
      `<transp><modFrete>${modFrete}</modFrete>` +
      `<vol><qVol>${qVol}</qVol><esp>VOLUME</esp><pesoL>${pesoKg}</pesoL><pesoB>${pesoKg}</pesoB></vol>` +
      `</transp>`;
    // Transferência não tem pagamento → tPag 90 (sem pagamento), vPag 0.
    const pag = `<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>`;
    const infAdic = `<infAdic><infCpl>${this.esc(`Transferencia de mercadoria - Remessa ${p.remCode}`)}</infCpl></infAdic>`;

    const infNFe =
      `<infNFe versao="4.00" Id="NFe${p.chave}">` +
      ide + emit + dest + autXML + det + total + transp + pag + infAdic +
      `</infNFe>`;

    return `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe}</NFe>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NF-e de VENDA no PDV (mod 55) — CASO EXTREMO: a cliente precisa da nota
  // grande no lugar do cupom (dono 24/07). NUNCA os dois. Identidade = a MESMA
  // da NFC-e (mesmo estabelecimento vendeu). Valores a PREÇO DE VENDA.
  // ══════════════════════════════════════════════════════════════════════════
  async emitVendaForSale(
    saleId: string,
    opts: {
      userId?: string | null;
      customer?: {
        cpfCnpj?: string; nome?: string; endereco?: string; numero?: string;
        bairro?: string; cidade?: string; uf?: string; cep?: string; codMunicipio?: string;
      };
    } = {},
  ) {
    const sale: any = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'finalized') throw new BadRequestException('A venda precisa estar finalizada.');

    const linkId = `venda:${saleId}`;
    const ja = await this.prisma.nfeDoc.findFirst({ where: { shipmentId: linkId, status: 'authorized' } });
    if (ja) return { ok: true, jaEmitida: true, doc: this.publicDoc(ja) };

    // Destinatário (obrigatório na mod 55) — request tem prioridade, cai no snapshot da venda.
    const c = opts.customer || {};
    const cpfCnpj = this.digits(c.cpfCnpj || sale.customerCpf || '');
    const nome = String(c.nome || sale.customerName || '').trim();
    const endereco = String(c.endereco || sale.customerEndereco || '').trim();
    const custNumero = String(c.numero || sale.customerNumero || 'S/N').trim();
    const bairro = String(c.bairro || sale.customerBairro || '').trim();
    const cidade = String(c.cidade || sale.customerCidade || '').trim();
    const uf = String(c.uf || sale.customerUf || '').trim().toUpperCase().slice(0, 2);
    const cep = this.digits(c.cep || sale.customerCep || '');
    const codMun = this.digits(c.codMunicipio || '');
    const faltam: string[] = [];
    if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) faltam.push('CPF/CNPJ');
    if (nome.length < 2) faltam.push('nome');
    if (!endereco) faltam.push('logradouro');
    if (!bairro) faltam.push('bairro');
    if (!cidade) faltam.push('cidade');
    if (uf.length !== 2) faltam.push('UF');
    if (cep.length !== 8) faltam.push('CEP');
    if (codMun.length !== 7) faltam.push('código IBGE do município (vem do CEP)');
    if (faltam.length) throw new BadRequestException(`Dados da cliente incompletos pra NF-e: ${faltam.join(', ')}.`);

    // Identidade fiscal = a da NFC-e (mesmo CNPJ que vendeu). NÃO usa nfe* de transferência.
    const origem = await this.loadStoreFiscal(sale.storeCode, { requireCert: true, identidade: 'base' });
    const tpAmb = origem.ambiente;
    const serie = '1';

    // GUARD "NUNCA OS 2": se a venda tem NFC-e autorizada, cancela — só dentro
    // dos 30 min que a SEFAZ permite. Fora do prazo, ABORTA (evita duplicidade).
    if (sale.nfceStatus === 'authorized' && sale.nfceChave && sale.nfceProtocolo) {
      const emitidaEm = sale.nfceAutorizadaEm ? new Date(sale.nfceAutorizadaEm).getTime() : 0;
      const min = emitidaEm ? (Date.now() - emitidaEm) / 60000 : 999;
      if (min > 30) {
        throw new BadRequestException('O cupom (NFC-e) desta venda já passou dos 30 min pra cancelar na SEFAZ. Não dá pra emitir a NF-e sem duplicar — fale com o contador.');
      }
      const canc = await cancelNfceSefazSp({
        chave: sale.nfceChave, protocolo: sale.nfceProtocolo,
        justificativa: 'Substituicao do cupom fiscal por NF-e a pedido do cliente',
        cnpj: origem.cnpj, ambiente: tpAmb,
        pfxBase64: origem.certPfxB64, pfxPassword: origem.certPfxPass,
      });
      const okc = canc.success && (canc.cStat === '135' || canc.cStat === '155');
      if (!okc) {
        throw new BadRequestException(`Não cancelei o cupom pra emitir a NF-e (cStat ${canc.cStat}: ${canc.xMotivo || canc.error}). Abortado pra não duplicar.`);
      }
      await (this.prisma as any).pdvSale.update({
        where: { id: saleId },
        data: { nfceStatus: 'cancelled', nfceCanceladaEm: new Date(), nfceCancelamentoMotivo: 'Substituida por NF-e (nota grande)' },
      });
    }

    // Itens a PREÇO DE VENDA (não custo).
    // CFOP pela regra central do contador (28/07): cliente de venda direta não
    // tem IE cadastrada → interestadual vira 6108 (consumidor final + DIFAL).
    const interestadual = origem.ender.uf !== uf;
    const { cfop, natOp: natOpRegra } = cfopVenda(origem.ender.uf, uf, false);
    const items = (sale.items as any[]).map((it) => ({
      sku: String(it.sku || '').trim(),
      ean: this.gtinValido(String(it.ean || '').trim()),
      xProd: String(it.descricao || it.sku).trim().slice(0, 120),
      ncm: this.normNcm(it.ncm, it.sku, []),
      cfop, qty: it.qty || 1,
      vUn: Math.round((it.precoUnit || 0) * 100) / 100,
      vProd: Math.round((it.total || 0) * 100) / 100,
    }));
    const valorTotal = items.reduce((s, i) => s + i.vProd, 0);

    await this.garantirContinuacao(this.digits(origem.cnpj), origem.cnpj, serie);
    let numero = await this.seq.next(this.digits(origem.cnpj), serie, { start: this.startPadraoPara(origem.cnpj, serie), legacyKey: origem.identidadeEmprestada ? undefined : origem.storeCode });
    const cUF = CUF_BY_UF[origem.ender.uf] || origem.ender.codMunicipio.slice(0, 2);
    const natOp = natOpRegra;
    const dest = { cpfCnpj, nome, endereco, numero: custNumero, bairro, cidade, uf, cep, codMun };

    const doc = await this.prisma.nfeDoc.create({
      data: {
        shipmentId: linkId, fromStoreCode: sale.storeCode, toStoreCode: sale.storeCode,
        modelo: '55', serie, numero, cNF: '', chave: '', tpAmb, natOp, cfop,
        valorTotalCents: Math.round(valorTotal * 100), status: 'pending',
        emittedByUserId: opts.userId ?? null,
      },
    });

    const MAX = Number(process.env.NFE_539_MAX_RETRY ?? 30);
    let res: any = null;
    let chave = '';
    let cNF = '';
    for (let t = 0; ; t++) {
      const dhEmi = this.dhEmiNow();
      cNF = crypto.randomInt(10_000_000, 99_999_999).toString();
      chave = this.buildChave({ cUF, cnpj: origem.cnpj, serie, numero, cNF, dataEmissao: new Date() });
      const xml = this.buildVendaXml({ chave, cUF, cNF, serie, numero, dhEmi, tpAmb, natOp, cfop, origem, dest, interestadual, items, valorTotal, saleRef: String(sale.id).slice(0, 8) });
      const xmlMin = xml.replace(/>\s+</g, '><').trim();
      let xmlAssinado: string;
      try {
        xmlAssinado = signXmlNfeWithA1({ xml: xmlMin, pfxBase64: origem.certPfxB64, pfxPassword: origem.certPfxPass });
      } catch (e: any) {
        await this.prisma.nfeDoc.update({ where: { id: doc.id }, data: { status: 'error', numero, cNF, chave, erro: `Assinatura: ${e?.message || e}` } });
        throw new BadRequestException(`Falha ao assinar NF-e: ${e?.message || e}`);
      }
      await this.prisma.nfeDoc.update({ where: { id: doc.id }, data: { numero, cNF, chave, status: 'signed', xmlEnviado: xmlAssinado } });
      res = await transmitNfeSefazSp({ xmlAssinado, ambiente: tpAmb, pfxBase64: origem.certPfxB64, pfxPassword: origem.certPfxPass, endpointOverride: SEFAZ_SP_NFE_ENDPOINTS[tpAmb].autorizacao });
      const okk = res.success && (res.cStat === '100' || res.cStat === '150');
      if (okk) break;
      if ((res.cStat === '539' || res.cStat === '204') && t < MAX) { numero = await this.seq.next(this.digits(origem.cnpj), serie); continue; }
      if (res.cStat === '778' && t < MAX && this.corrigirNcmInvalido(items, res.xMotivo)) continue;
      // 225 = Falha no Schema — loga o XML inteiro pra diagnóstico no Railway
      if (res.cStat === '225') this.logger.error(`[nfe] 225 schema (${chave}): ${res.xMotivo} · XML: ${xmlAssinado}`);
      break;
    }
    const autorizada = res.success && (res.cStat === '100' || res.cStat === '150');
    const updated = await this.prisma.nfeDoc.update({
      where: { id: doc.id },
      data: {
        status: autorizada ? 'authorized' : 'rejected', cStat: res.cStat, xMotivo: res.xMotivo,
        protocolo: res.protocolo ?? null, dhRecbto: res.dhRecbto ?? null,
        xmlAutorizado: res.xmlAutorizado ?? null, xmlResposta: res.xmlResposta ?? null,
        erro: autorizada ? null : res.xMotivo || res.error || 'Rejeitada',
      },
    });
    return { ok: autorizada, doc: this.publicDoc(updated), cStat: res.cStat, xMotivo: res.xMotivo };
  }

  /**
   * NF-e de VENDA pro ENVIO (pick-order do "Gerar envio" — live/site).
   * Mesmo motor da "nota grande" do PDV, mas alimentado pelos dados do envio:
   * remetente = loja (identidade da NFC-e), destinatário = cliente, CFOP pela
   * regra central do contador (5102/6102/6108 + DIFAL automático).
   * Idempotente por pick (linkId `envio:<pickId>`). `ambienteOverride='2'`
   * força homologação na fase de validação.
   */
  async emitVendaForEnvio(input: {
    pickOrderId: string;
    storeCode: string;
    dest: { cpfCnpj: string; nome: string; endereco: string; numero: string; bairro: string; cidade: string; uf: string; cep: string; codMun: string };
    items: Array<{ sku?: string; ean?: string; descricao: string; ncm?: string; qty: number; vUn: number }>;
    ambienteOverride?: '1' | '2';
    /** Emitir pela identidade DESSA raiz de CNPJ (ex.: site = LURDS matriz), buscada na config da loja/grupo. */
    emitirPorRaiz?: string;
  }) {
    const linkId = `envio:${input.pickOrderId}`;

    const d = input.dest;
    const cpfCnpj = this.digits(d.cpfCnpj || '');
    const faltam: string[] = [];
    if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) faltam.push('CPF/CNPJ');
    if (!String(d.nome || '').trim()) faltam.push('nome');
    if (!String(d.endereco || '').trim()) faltam.push('logradouro');
    if (this.digits(d.cep).length !== 8) faltam.push('CEP');
    if (this.digits(d.codMun).length !== 7) faltam.push('código IBGE do município');
    if (d.uf?.length !== 2) faltam.push('UF');
    if (faltam.length) throw new BadRequestException(`Dados da cliente incompletos pra NF-e do envio: ${faltam.join(', ')}.`);

    const origem = await this.loadStoreFiscal(input.storeCode, {
      requireCert: true,
      identidade: 'base',
      // Venda do SITE: a nota sai pela empresa do site (LURDS matriz) — a
      // identidade da raiz pedida é buscada na loja e no grupo (mesma máquina
      // da transferência). Etiqueta/separação NÃO mudam.
      matchRaiz: input.emitirPorRaiz && input.emitirPorRaiz.length === 8 ? input.emitirPorRaiz : undefined,
    });
    const tpAmb = input.ambienteOverride || origem.ambiente;

    // Idempotência POR AMBIENTE: nota de homologação do mesmo pick NÃO conta
    // quando a emissão agora é produção (senão o teste de homolog "grudava"
    // pra sempre no envio — visto 28/07).
    const ja = await this.prisma.nfeDoc.findFirst({ where: { shipmentId: linkId, status: 'authorized', tpAmb } });
    if (ja) return { ok: true, jaEmitida: true, doc: this.publicDoc(ja) };

    const serie = '1';
    const interestadual = origem.ender.uf !== d.uf;
    // Cliente de envio não tem IE cadastrada → árvore do contador decide (6108 interestadual)
    const { cfop, natOp } = cfopVenda(origem.ender.uf, d.uf, false);

    const items = input.items.map((it) => ({
      sku: String(it.sku || 'ITEM').trim().slice(0, 60),
      ean: this.gtinValido(String(it.ean || '').trim()),
      xProd: String(it.descricao || it.sku || 'Vestuário').trim().slice(0, 120),
      ncm: this.normNcm(it.ncm, String(it.sku || ''), []),
      cfop,
      qty: it.qty || 1,
      vUn: Math.round((it.vUn || 0) * 100) / 100,
      vProd: Math.round((it.qty || 1) * (it.vUn || 0) * 100) / 100,
    }));
    const valorTotal = items.reduce((s, i) => s + i.vProd, 0);
    if (valorTotal <= 0) throw new BadRequestException('NF-e do envio sem valor (itens zerados).');

    await this.garantirContinuacao(this.digits(origem.cnpj), origem.cnpj, serie);
    let numero = await this.seq.next(this.digits(origem.cnpj), serie, { start: this.startPadraoPara(origem.cnpj, serie), legacyKey: origem.identidadeEmprestada ? undefined : origem.storeCode });
    const cUF = CUF_BY_UF[origem.ender.uf] || origem.ender.codMunicipio.slice(0, 2);
    const dest = { cpfCnpj, nome: d.nome, endereco: d.endereco, numero: d.numero || 'S/N', bairro: d.bairro || 'CENTRO', cidade: d.cidade, uf: d.uf, cep: this.digits(d.cep), codMun: this.digits(d.codMun) };

    const doc = await this.prisma.nfeDoc.create({
      data: {
        shipmentId: linkId, fromStoreCode: input.storeCode, toStoreCode: input.storeCode,
        modelo: '55', serie, numero, cNF: '', chave: '', tpAmb, natOp, cfop,
        valorTotalCents: Math.round(valorTotal * 100), status: 'pending',
      },
    });

    const MAX = Number(process.env.NFE_539_MAX_RETRY ?? 30);
    let res: any = null;
    let chave = '';
    let cNF = '';
    for (let t = 0; ; t++) {
      const dhEmi = this.dhEmiNow();
      cNF = crypto.randomInt(10_000_000, 99_999_999).toString();
      chave = this.buildChave({ cUF, cnpj: origem.cnpj, serie, numero, cNF, dataEmissao: new Date() });
      const xml = this.buildVendaXml({ chave, cUF, cNF, serie, numero, dhEmi, tpAmb, natOp, cfop, origem, dest, interestadual, items, valorTotal, saleRef: `envio ${String(input.pickOrderId).slice(0, 8)}` });
      const xmlMin = xml.replace(/>\s+</g, '><').trim();
      let xmlAssinado: string;
      try {
        xmlAssinado = signXmlNfeWithA1({ xml: xmlMin, pfxBase64: origem.certPfxB64, pfxPassword: origem.certPfxPass });
      } catch (e: any) {
        await this.prisma.nfeDoc.update({ where: { id: doc.id }, data: { status: 'error', numero, cNF, chave, erro: `Assinatura: ${e?.message || e}` } });
        throw new BadRequestException(`Falha ao assinar NF-e do envio: ${e?.message || e}`);
      }
      await this.prisma.nfeDoc.update({ where: { id: doc.id }, data: { numero, cNF, chave, status: 'signed', xmlEnviado: xmlAssinado } });
      res = await transmitNfeSefazSp({ xmlAssinado, ambiente: tpAmb, pfxBase64: origem.certPfxB64, pfxPassword: origem.certPfxPass, endpointOverride: SEFAZ_SP_NFE_ENDPOINTS[tpAmb].autorizacao });
      const okk = res.success && (res.cStat === '100' || res.cStat === '150');
      if (okk) break;
      if ((res.cStat === '539' || res.cStat === '204') && t < MAX) { numero = await this.seq.next(this.digits(origem.cnpj), serie); continue; }
      if (res.cStat === '778' && t < MAX && this.corrigirNcmInvalido(items, res.xMotivo)) continue;
      // 225 = Falha no Schema — loga o XML inteiro pra diagnóstico no Railway
      if (res.cStat === '225') this.logger.error(`[nfe] 225 schema (${chave}): ${res.xMotivo} · XML: ${xmlAssinado}`);
      break;
    }
    const autorizada = res.success && (res.cStat === '100' || res.cStat === '150');
    const updated = await this.prisma.nfeDoc.update({
      where: { id: doc.id },
      data: {
        status: autorizada ? 'authorized' : 'rejected', cStat: res.cStat, xMotivo: res.xMotivo,
        protocolo: res.protocolo ?? null, dhRecbto: res.dhRecbto ?? null,
        xmlAutorizado: res.xmlAutorizado ?? null, xmlResposta: res.xmlResposta ?? null,
        erro: autorizada ? null : res.xMotivo || res.error || 'Rejeitada',
      },
    });
    return { ok: autorizada, doc: this.publicDoc(updated), cStat: res.cStat, xMotivo: res.xMotivo };
  }

  /** Última NF-e de envio de um pick-order (Reimprimir DANFE na loja). */
  async findEnvioDoc(pickOrderId: string) {
    return this.prisma.nfeDoc.findFirst({
      where: { shipmentId: `envio:${pickOrderId}` },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, cStat: true, xMotivo: true, chave: true, tpAmb: true, numero: true },
    });
  }

  private buildVendaXml(p: {
    chave: string; cUF: string; cNF: string; serie: string; numero: number;
    dhEmi: string; tpAmb: '1' | '2'; natOp: string; cfop: string;
    origem: StoreFiscal;
    dest: { cpfCnpj: string; nome: string; endereco: string; numero: string; bairro: string; cidade: string; uf: string; cep: string; codMun: string };
    interestadual: boolean;
    /** IE do destinatário quando CONTRIBUINTE (CFOP 6102) — sem ela, consumidor final (indIEDest 9 + DIFAL). */
    destIE?: string;
    items: Array<{ sku: string; ean: string; xProd: string; ncm: string; cfop: string; qty: number; vUn: number; vProd: number }>;
    valorTotal: number; saleRef: string;
  }): string {
    const homolog = p.tpAmb === '2';
    const destNome = homolog ? HOMOLOG_FRASE : (p.dest.nome || 'CONSUMIDOR');
    const idDest = p.interestadual ? '2' : '1';
    const crt3 = String(p.origem.regime || '1') === '3';

    const ide =
      `<ide><cUF>${p.cUF}</cUF><cNF>${p.cNF.padStart(8, '0')}</cNF><natOp>${this.esc(p.natOp)}</natOp>` +
      `<mod>55</mod><serie>${p.serie}</serie><nNF>${p.numero}</nNF><dhEmi>${p.dhEmi}</dhEmi><dhSaiEnt>${p.dhEmi}</dhSaiEnt>` +
      `<tpNF>1</tpNF><idDest>${idDest}</idDest><cMunFG>${p.origem.ender.codMunicipio}</cMunFG><tpImp>1</tpImp>` +
      `<tpEmis>1</tpEmis><cDV>${p.chave.slice(-1)}</cDV><tpAmb>${p.tpAmb}</tpAmb><finNFe>1</finNFe>` +
      `<indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>FlowOps-NFe-1.0</verProc></ide>`;

    const emit =
      `<emit><CNPJ>${p.origem.cnpj}</CNPJ><xNome>${this.esc(p.origem.razaoSocial)}</xNome>` +
      (p.origem.fantasia ? `<xFant>${this.esc(p.origem.fantasia)}</xFant>` : '') +
      `<enderEmit>${this.buildEnder(p.origem.ender)}</enderEmit><IE>${p.origem.ie}</IE><CRT>${p.origem.regime || '1'}</CRT></emit>`;

    const isCnpj = p.dest.cpfCnpj.length === 14;
    const docTag = isCnpj ? `<CNPJ>${p.dest.cpfCnpj}</CNPJ>` : `<CPF>${p.dest.cpfCnpj}</CPF>`;
    const enderDest =
      `<enderDest><xLgr>${this.esc(p.dest.endereco)}</xLgr><nro>${this.esc(p.dest.numero || 'S/N')}</nro>` +
      `<xBairro>${this.esc(p.dest.bairro)}</xBairro><cMun>${p.dest.codMun}</cMun><xMun>${this.esc(p.dest.cidade)}</xMun>` +
      `<UF>${p.dest.uf}</UF><CEP>${p.dest.cep}</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderDest>`;
    const destIE = String(p.destIE || '').replace(/\D/g, '');
    const dest = `<dest>${docTag}<xNome>${this.esc(destNome)}</xNome>${enderDest}<indIEDest>${destIE ? '1' : '9'}</indIEDest>${destIE ? `<IE>${destIE}</IE>` : ''}</dest>`;

    const autXmlCnpj = String(process.env.NFE_AUTXML_CNPJ ?? '11145597000189').replace(/\D/g, '');
    const autXML = autXmlCnpj ? `<autXML><CNPJ>${autXmlCnpj}</CNPJ></autXML>` : '';

    const aliqInterna = Number(process.env.NFE_ICMS_ALIQ_INTERNA ?? 18);
    // Interestadual por UF DESTINO (tabela do contador): 7% N/NE/CO+ES · 12% S/SE
    const aliqInter = p.interestadual ? aliqInterSaidaSP(p.dest.uf) : 0;
    // DIFAL (EC 87/15): interestadual pra CONSUMIDOR FINAL não contribuinte
    // (CFOP 6108) → 100% da diferença pro estado destino + FCP quando houver.
    const temDifal = crt3 && p.interestadual && !destIE;
    const pIcmsUfDest = temDifal ? aliqInternaUF(p.dest.uf) : 0;
    const pFcpDest = temDifal ? fcpUF(p.dest.uf) : 0;
    // Presumido (contador 29/07): PIS 0,65 + COFINS 3 destacados + grupo IBS/CBS
    const { pPIS, pCOFINS } = this.aliqPisCofins();
    const ib = this.ibscbsCfg(crt3);
    let totBC = 0;
    let totICMS = 0;
    let totIcmsUfDest = 0;
    let totFcpUfDest = 0;
    let totPIS = 0;
    let totCOFINS = 0;
    const ibTot = { vBC: 0, vIBSUF: 0, vIBSMun: 0, vCBS: 0 };
    const det = p.items
      .map((it, idx) => {
        const xProd = homolog ? HOMOLOG_FRASE : this.xProdNota(it.xProd);
        const prod =
          `<prod><cProd>${this.esc(it.sku)}</cProd><cEAN>${it.ean}</cEAN><xProd>${this.esc(xProd)}</xProd>` +
          `<NCM>${it.ncm}</NCM><CFOP>${it.cfop}</CFOP><uCom>UN</uCom><qCom>${it.qty.toFixed(4)}</qCom>` +
          `<vUnCom>${this.money(it.vUn)}</vUnCom><vProd>${this.money(it.vProd)}</vProd>` +
          `<cEANTrib>${it.ean}</cEANTrib><uTrib>UN</uTrib><qTrib>${it.qty.toFixed(4)}</qTrib>` +
          `<vUnTrib>${this.money(it.vUn)}</vUnTrib><indTot>1</indTot></prod>`;
        let icms: string;
        let icmsUfDest = '';
        if (crt3) {
          const pIcms = p.interestadual ? aliqInter : aliqInterna;
          const vBC = Math.round(it.vProd * 100) / 100;
          const vIcms = Math.round(vBC * pIcms) / 100;
          totBC += vBC;
          totICMS += vIcms;
          icms = `<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>${this.money(vBC)}</vBC><pICMS>${pIcms.toFixed(4)}</pICMS><vICMS>${this.money(vIcms)}</vICMS></ICMS00></ICMS>`;
          if (temDifal) {
            const vFcp = Math.round(vBC * pFcpDest) / 100;
            const vDifal = Math.round(vBC * Math.max(0, pIcmsUfDest - pIcms)) / 100;
            totFcpUfDest += vFcp;
            totIcmsUfDest += vDifal;
            icmsUfDest =
              `<ICMSUFDest><vBCUFDest>${this.money(vBC)}</vBCUFDest>` +
              (pFcpDest > 0 ? `<vBCFCPUFDest>${this.money(vBC)}</vBCFCPUFDest><pFCPUFDest>${pFcpDest.toFixed(4)}</pFCPUFDest>` : '') +
              `<pICMSUFDest>${pIcmsUfDest.toFixed(4)}</pICMSUFDest><pICMSInter>${pIcms.toFixed(2)}</pICMSInter>` +
              `<pICMSInterPart>100.00</pICMSInterPart>` +
              (pFcpDest > 0 ? `<vFCPUFDest>${this.money(vFcp)}</vFCPUFDest>` : '') +
              `<vICMSUFDest>${this.money(vDifal)}</vICMSUFDest><vICMSUFRemet>0.00</vICMSUFRemet></ICMSUFDest>`;
          }
        } else {
          // Simples Nacional — CSOSN 102 (tributada, sem crédito), igual à NFC-e.
          icms = `<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>`;
        }
        const vBCItem = Math.round(it.vProd * 100) / 100;
        const vPisItem = crt3 ? Math.round(vBCItem * pPIS) / 100 : 0;
        const vCofItem = crt3 ? Math.round(vBCItem * pCOFINS) / 100 : 0;
        totPIS += vPisItem;
        totCOFINS += vCofItem;
        const pisCofins = crt3
          ? `<PIS><PISAliq><CST>01</CST><vBC>${this.money(vBCItem)}</vBC><pPIS>${pPIS.toFixed(4)}</pPIS><vPIS>${this.money(vPisItem)}</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>01</CST><vBC>${this.money(vBCItem)}</vBC><pCOFINS>${pCOFINS.toFixed(4)}</pCOFINS><vCOFINS>${this.money(vCofItem)}</vCOFINS></COFINSAliq></COFINS>`
          : `<PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>`;
        const ibi = this.ibscbsItem(ib, vBCItem);
        if (ib.on) {
          ibTot.vBC += vBCItem;
          ibTot.vIBSUF += ibi.vIBSUF;
          ibTot.vIBSMun += ibi.vIBSMun;
          ibTot.vCBS += ibi.vCBS;
        }
        // vItem (grupo VB): obrigatório junto do IBSCBS — cStat 225 sem ele
        return `<det nItem="${idx + 1}">${prod}<imposto>${icms}${pisCofins}${icmsUfDest}${ibi.xml}</imposto>${ib.on ? `<vItem>${vBCItem.toFixed(2)}</vItem>` : ''}</det>`;
      })
      .join('');

    const vTot = this.money(p.valorTotal);
    // ICMSTot: os campos do DIFAL (vFCPUFDest/vICMSUFDest/vICMSUFRemet) entram
    // logo após vICMSDeson quando a partilha existe.
    const difalTot = temDifal
      ? `<vFCPUFDest>${this.money(totFcpUfDest)}</vFCPUFDest><vICMSUFDest>${this.money(totIcmsUfDest)}</vICMSUFDest><vICMSUFRemet>0.00</vICMSUFRemet>`
      : '';
    const total =
      `<total><ICMSTot><vBC>${this.money(totBC)}</vBC><vICMS>${this.money(totICMS)}</vICMS><vICMSDeson>0.00</vICMSDeson>` +
      difalTot +
      `<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>` +
      `<vProd>${vTot}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII>` +
      `<vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>${this.money(totPIS)}</vPIS><vCOFINS>${this.money(totCOFINS)}</vCOFINS><vOutro>0.00</vOutro><vNF>${vTot}</vNF></ICMSTot>${this.ibscbsTot(ib, ibTot, vTot)}</total>`;

    const transp = `<transp><modFrete>9</modFrete></transp>`;
    // cStat 441: tPag 99 (outros) exige a descrição <xPag> junto.
    const pag = `<pag><detPag><tPag>99</tPag><xPag>OUTROS</xPag><vPag>${vTot}</vPag></detPag></pag>`;
    const cpl = crt3
      ? `Venda ref ${p.saleRef}.`
      : `Venda ref ${p.saleRef}. DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL.`;
    const infAdic = `<infAdic><infCpl>${this.esc(cpl)}</infCpl></infAdic>`;

    const infNFe = `<infNFe versao="4.00" Id="NFe${p.chave}">${ide}${emit}${dest}${autXML}${det}${total}${transp}${pag}${infAdic}</infNFe>`;
    return `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe}</NFe>`;
  }
}
