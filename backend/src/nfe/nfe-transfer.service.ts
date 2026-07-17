import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { NfeSequenceService } from './nfe-sequence.service';
import { signXmlNfeWithA1, transmitNfeSefazSp } from '../pdv/nfce-sefaz';
import { SEFAZ_SP_NFE_ENDPOINTS, HOMOLOG_FRASE } from './nfe-sefaz-endpoints';

/** UF → código IBGE (cUF). Só os estados que a rede opera; expandir se preciso. */
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

    // Idempotência: não reemitir o que já foi autorizado.
    const jaAutorizada = await this.prisma.nfeDoc.findFirst({
      where: { shipmentId, status: 'authorized' },
    });
    if (jaAutorizada) {
      return { ok: true, jaEmitida: true, doc: this.publicDoc(jaAutorizada) };
    }

    const origem = await this.loadStoreFiscal(shipment.fromStoreCode);
    const destino = await this.loadStoreFiscal(shipment.toStoreCode);

    // Itens da remessa (uma linha por unidade) → agrupa por SKU.
    const rows = await this.prisma.transferOrder.findMany({
      where: { shipmentId, realignmentStatus: { not: 'cancelled' } },
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

    const ambiente = origem.ambiente;
    const tpAmb = ambiente;
    const serie = opts.serie || '1';
    const numero = await this.seq.next(origem.storeCode, serie, { start: opts.startNumero });

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
        ean: (info?.ean || '').trim() || 'SEM GTIN',
        xProd: (info?.descricao || g.row.descricao || g.sku).trim().slice(0, 120),
        ncm,
        cfop,
        qty: g.qty,
        vUn,
        vProd,
      });
    }

    const valorTotal = items.reduce((s, i) => s + i.vProd, 0);
    const valorTotalCents = Math.round(valorTotal * 100);

    const dhEmi = this.dhEmiNow();
    const cNF = crypto.randomInt(10_000_000, 99_999_999).toString();
    const cUF = CUF_BY_UF[origem.ender.uf] || origem.ender.codMunicipio.slice(0, 2);
    const chave = this.buildChave({ cUF, cnpj: origem.cnpj, serie, numero, cNF, dataEmissao: new Date() });

    const natOp = 'TRANSFERENCIA DE MERC ADQ TERCEIROS';
    // Registra o doc ANTES de transmitir (rastreabilidade mesmo se a SEFAZ cair).
    const doc = await this.prisma.nfeDoc.create({
      data: {
        shipmentId,
        fromStoreCode: origem.storeCode,
        toStoreCode: destino.storeCode,
        modelo: '55',
        serie,
        numero,
        cNF,
        chave,
        tpAmb,
        natOp,
        cfop,
        valorTotalCents,
        status: 'pending',
        emittedByUserId: opts.userId ?? null,
      },
    });

    // Monta + assina + transmite.
    const xml = this.buildXml({
      chave, cUF, cNF, serie, numero, dhEmi, tpAmb, natOp,
      origem, destino, interestadual, items, valorTotal, remCode: shipment.code,
    });
    const xmlMin = xml.replace(/>\s+</g, '><').trim();

    let xmlAssinado: string;
    try {
      xmlAssinado = signXmlNfeWithA1({
        xml: xmlMin,
        pfxBase64: origem.certPfxB64,
        pfxPassword: origem.certPfxPass,
      });
    } catch (e: any) {
      await this.prisma.nfeDoc.update({
        where: { id: doc.id },
        data: { status: 'error', erro: `Assinatura: ${e?.message || e}` },
      });
      throw new BadRequestException(`Falha ao assinar NF-e: ${e?.message || e}`);
    }
    await this.prisma.nfeDoc.update({
      where: { id: doc.id },
      data: { status: 'signed', xmlEnviado: xmlAssinado },
    });

    const endpoint = SEFAZ_SP_NFE_ENDPOINTS[tpAmb].autorizacao;
    const res = await transmitNfeSefazSp({
      xmlAssinado,
      ambiente: tpAmb,
      pfxBase64: origem.certPfxB64,
      pfxPassword: origem.certPfxPass,
      endpointOverride: endpoint,
    });

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

  /** Documento por id (com XMLs, pra download/DANFE). */
  async getDoc(id: string) {
    const doc = await this.prisma.nfeDoc.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('NF-e não encontrada');
    return doc;
  }

  /** Lista NF-e emitidas (filtro por loja/status). */
  async list(params: { storeCode?: string; status?: string; limit?: number }) {
    const where: any = {};
    if (params.storeCode) where.fromStoreCode = params.storeCode;
    if (params.status) where.status = params.status;
    const docs = await this.prisma.nfeDoc.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, params.limit || 100),
    });
    return docs.map((d) => this.publicDoc(d));
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

  private async loadStoreFiscal(storeCode: string): Promise<StoreFiscal> {
    const cfg = await this.prisma.nfceConfig.findUnique({ where: { storeCode } });
    if (!cfg) {
      throw new BadRequestException(`Loja ${storeCode} sem config fiscal (NfceConfig). Configure CNPJ/IE/endereço/certificado.`);
    }
    const faltando: string[] = [];
    if (!cfg.cnpj) faltando.push('CNPJ');
    if (!cfg.ie) faltando.push('IE');
    if (!cfg.certPfxB64 || !cfg.certPfxPass) faltando.push('certificado A1');
    if (!cfg.endereco) faltando.push('endereço');
    if (faltando.length) {
      throw new BadRequestException(`Loja ${storeCode} sem ${faltando.join(', ')} na config fiscal`);
    }
    let ender: any;
    try {
      ender = JSON.parse(cfg.endereco as string);
    } catch {
      throw new BadRequestException(`Endereço fiscal da loja ${storeCode} inválido (JSON)`);
    }
    if (!ender?.codMunicipio) {
      throw new BadRequestException(`Loja ${storeCode} sem codMunicipio (IBGE) no endereço fiscal`);
    }
    return {
      storeCode,
      cnpj: this.digits(cfg.cnpj as string),
      ie: this.digits(cfg.ie as string),
      razaoSocial: (cfg.razaoSocial || '').trim(),
      fantasia: (cfg.fantasia || cfg.razaoSocial || '').trim(),
      uf: (cfg.uf || ender.uf || 'SP').toUpperCase(),
      ambiente: (cfg.ambiente === '1' ? '1' : '2') as '1' | '2',
      regime: cfg.regime || '1',
      certPfxB64: cfg.certPfxB64 as string,
      certPfxPass: cfg.certPfxPass as string,
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

  private normNcm(ncm: any, sku: string, warnings: string[]): string {
    const n = this.digits(String(ncm || ''));
    if (n.length === 8) return n;
    warnings.push(`SKU ${sku} sem NCM válido — usei 62179000 (vestuário) provisório`);
    return '62179000';
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
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private buildXml(p: {
    chave: string; cUF: string; cNF: string; serie: string; numero: number;
    dhEmi: string; tpAmb: '1' | '2'; natOp: string;
    origem: StoreFiscal; destino: StoreFiscal; interestadual: boolean;
    items: Array<{ sku: string; ean: string; xProd: string; ncm: string; cfop: string; qty: number; vUn: number; vProd: number }>;
    valorTotal: number; remCode: string;
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

    const det = p.items
      .map((it, idx) => {
        const xProd = homolog ? HOMOLOG_FRASE : it.xProd;
        const prod =
          `<prod>` +
          `<cProd>${this.esc(it.sku)}</cProd>` +
          `<cEAN>${it.ean}</cEAN>` +
          `<xProd>${this.esc(xProd)}</xProd>` +
          `<NCM>${it.ncm}</NCM>` +
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
        // Simples Nacional (CRT=1) transferência: ICMS CSOSN 400 (não tributada),
        // IPI/PIS/COFINS CST 99 zerados — igual ao que a GigaNFe emitia.
        const imposto =
          `<imposto>` +
          `<ICMS><ICMSSN102><orig>0</orig><CSOSN>400</CSOSN></ICMSSN102></ICMS>` +
          `<IPI><cEnq>999</cEnq><IPITrib><CST>99</CST><vBC>0.00</vBC><pIPI>0.0000</pIPI><vIPI>0.00</vIPI></IPITrib></IPI>` +
          `<PIS><PISOutr><CST>99</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>` +
          `<COFINS><COFINSOutr><CST>99</CST><vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>` +
          `</imposto>`;
        return `<det nItem="${idx + 1}">${prod}${imposto}</det>`;
      })
      .join('');

    const vTot = this.money(p.valorTotal);
    const total =
      `<total><ICMSTot>` +
      `<vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>` +
      `<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>` +
      `<vProd>${vTot}</vProd>` +
      `<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII>` +
      `<vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>` +
      `<vOutro>0.00</vOutro><vNF>${vTot}</vNF>` +
      `</ICMSTot></total>`;

    const transp = `<transp><modFrete>9</modFrete></transp>`;
    // Transferência não tem pagamento → tPag 90 (sem pagamento), vPag 0.
    const pag = `<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>`;
    const infAdic = `<infAdic><infCpl>${this.esc(`Transferencia de mercadoria - Remessa ${p.remCode}`)}</infCpl></infAdic>`;

    const infNFe =
      `<infNFe versao="4.00" Id="NFe${p.chave}">` +
      ide + emit + dest + det + total + transp + pag + infAdic +
      `</infNFe>`;

    return `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe}</NFe>`;
  }
}
