import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NfeSequenceService } from '../nfe/nfe-sequence.service';
import { DCE_NS, DCE_VERSAO, buildDceQrUrl, signXmlDceWithA1, transmitDceSvd } from './dce-svrs';

/**
 * Emissão da DC-e (modelo 99) — Declaração de Conteúdo eletrônica.
 *
 * Remetente = a LOJA (identidade fiscal do NfceConfig, mesmo certificado A1
 * da NFC-e). Destinatário = cliente do envio. Cada pacote/envio gera a SUA
 * DC-e com só os itens daquela loja (regra do dono 28/07).
 *
 * Fluxo: numera (NfeSequence mod 99) → monta XML → assina → transmite ao SVD
 * → grava DceDoc (authorized/rejected). A DACE (PDF com QR) sai do
 * DacePdfService a partir do XML autorizado.
 *
 * ⚠️ HOMOLOGAÇÃO PENDENTE: campos com dúvida de layout são ajustáveis por env
 * (DCE_NSITE, DCE_XOBS1/2, DCE_QR_FORMAT, DCE_SOAP_* no dce-svrs) pra iterar
 * contra a homologação sem deploy. NÃO ligar em produção sem o OK do contador.
 */

export interface DceItemInput { descricao: string; ncm?: string; quantidade: number; valorUnit: number }
export interface DceDestInput {
  nome: string; cpfCnpj?: string;
  logradouro: string; numero: string; complemento?: string; bairro: string;
  cidade: string; codMunicipio?: string; uf: string; cep: string; fone?: string; email?: string;
}

@Injectable()
export class DceEmitService {
  private readonly logger = new Logger(DceEmitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: NfeSequenceService,
  ) {}

  /** Emite uma DC-e pra um envio. Idempotente por pickOrderId (se autorizada, devolve a existente). */
  async emitir(input: {
    storeCode: string;
    dest: DceDestInput;
    itens: DceItemInput[];
    pickOrderId?: string | null;
    ambienteOverride?: '1' | '2';
  }) {
    if (!input.itens?.length) throw new BadRequestException('DC-e sem itens');
    if (!input.dest?.nome || !input.dest?.logradouro) throw new BadRequestException('DC-e sem destinatário completo');

    // Idempotência: envio já tem DC-e autorizada → devolve ela (não duplica).
    if (input.pickOrderId) {
      const existente = await this.prisma.dceDoc.findFirst({
        where: { pickOrderId: input.pickOrderId, status: 'authorized' },
      });
      if (existente) return existente;
    }

    const fiscal = await this.loadStoreFiscal(input.storeCode);
    const tpAmb = input.ambienteOverride || fiscal.ambiente;
    const serie = '1';
    const numero = await this.seq.next(input.storeCode, serie, { modelo: '99' });

    // cDC: código numérico aleatório de 8 dígitos (compõe a chave, como o cNF)
    const cDC = String(Math.floor(Math.random() * 99999999)).padStart(8, '0');
    const agora = new Date();
    const chave = this.buildChave({ cUF: '35', cnpj: fiscal.cnpj, serie, numero, cDC, dataEmissao: agora });
    const dhEmi = this.dhEmiNow();

    const valorTotal = input.itens.reduce((s, it) => s + it.quantidade * it.valorUnit, 0);

    const doc = await this.prisma.dceDoc.create({
      data: {
        pickOrderId: input.pickOrderId || null,
        storeCode: input.storeCode,
        serie, numero, cDC, chave, tpAmb,
        destNome: input.dest.nome.slice(0, 60),
        destCpfCnpj: (input.dest.cpfCnpj || '').replace(/\D/g, '') || null,
        valorCents: Math.round(valorTotal * 100),
        status: 'pending',
      },
    });

    try {
      const xml = this.buildXml({ chave, cDC, serie, numero, dhEmi, tpAmb, fiscal, dest: input.dest, itens: input.itens, valorTotal });
      const xmlMin = xml.replace(/>\s+</g, '><').trim();
      const assinado = signXmlDceWithA1({ xml: xmlMin, pfxBase64: fiscal.certPfxB64, pfxPassword: fiscal.certPfxPass });
      await this.prisma.dceDoc.update({ where: { id: doc.id }, data: { status: 'signed', xmlEnviado: assinado } });

      const ret = await transmitDceSvd({ xmlAssinado: assinado, ambiente: tpAmb, pfxBase64: fiscal.certPfxB64, pfxPassword: fiscal.certPfxPass });

      const qrCodeUrl = ret.success ? buildDceQrUrl(chave, tpAmb) : null;
      const atualizado = await this.prisma.dceDoc.update({
        where: { id: doc.id },
        data: {
          status: ret.success ? 'authorized' : 'rejected',
          cStat: ret.cStat, xMotivo: ret.xMotivo?.slice(0, 500) || null,
          protocolo: ret.protocolo || null, dhRecbto: ret.dhRecbto || null,
          qrCodeUrl,
          xmlAutorizado: ret.xmlAutorizado || null,
          xmlResposta: ret.xmlResposta?.slice(0, 100000) || null,
          erro: ret.success ? null : (ret.error || ret.xMotivo || null),
        },
      });
      this.logger.log(`[dce] loja ${input.storeCode} nº ${numero} → cStat ${ret.cStat} (${ret.xMotivo})`);
      return atualizado;
    } catch (e: any) {
      await this.prisma.dceDoc.update({
        where: { id: doc.id },
        data: { status: 'error', erro: String(e?.message || e).slice(0, 2000) },
      });
      throw e;
    }
  }

  async get(id: string) {
    const doc = await this.prisma.dceDoc.findUnique({ where: { id } });
    if (!doc) throw new BadRequestException('DC-e não encontrada');
    return doc;
  }

  async list(opts: { storeCode?: string; limit?: number } = {}) {
    return this.prisma.dceDoc.findMany({
      where: opts.storeCode ? { storeCode: opts.storeCode } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, opts.limit || 50),
      select: {
        id: true, pickOrderId: true, storeCode: true, serie: true, numero: true,
        chave: true, tpAmb: true, destNome: true, valorCents: true,
        status: true, cStat: true, xMotivo: true, protocolo: true, qrCodeUrl: true, createdAt: true,
      },
    });
  }

  // ── identidade fiscal da loja (NfceConfig; cert próprio ou da matriz da raiz) ──
  private async loadStoreFiscal(storeCode: string) {
    const cfg = await this.prisma.nfceConfig.findUnique({ where: { storeCode } });
    if (!cfg) throw new BadRequestException(`Loja ${storeCode} sem config fiscal (NfceConfig)`);
    const digits = (s: string) => String(s || '').replace(/\D/g, '');
    const cnpj = digits(String(cfg.cnpj || ''));
    if (cnpj.length !== 14) throw new BadRequestException(`Loja ${storeCode} sem CNPJ válido na config fiscal`);

    let certPfxB64 = cfg.certPfxB64 as string | null;
    let certPfxPass = cfg.certPfxPass as string | null;
    if (!certPfxB64 || !certPfxPass) {
      // herda o A1 da matriz (/0001) da mesma raiz de CNPJ — padrão da NF-e
      const raiz = cnpj.slice(0, 8);
      const irmas = await this.prisma.nfceConfig.findMany({
        where: { certPfxB64: { not: null }, certPfxPass: { not: null }, cnpj: { not: null } },
        select: { storeCode: true, cnpj: true, certPfxB64: true, certPfxPass: true },
      });
      const daRaiz = irmas.filter((c) => digits(String(c.cnpj)).slice(0, 8) === raiz);
      const doadora = daRaiz.find((c) => digits(String(c.cnpj)).slice(8, 12) === '0001') || daRaiz[0];
      if (doadora) { certPfxB64 = doadora.certPfxB64 as string; certPfxPass = doadora.certPfxPass as string; }
    }
    if (!certPfxB64 || !certPfxPass) throw new BadRequestException(`Loja ${storeCode} sem certificado A1 (nem próprio, nem da matriz)`);

    let ender: any = {};
    try { ender = JSON.parse(String(cfg.endereco || '{}')); } catch { /* valida abaixo */ }
    if (!ender?.logradouro || !ender?.codMunicipio) {
      throw new BadRequestException(`Loja ${storeCode} sem endereço fiscal completo (logradouro/codMunicipio) na config`);
    }

    return {
      cnpj,
      razaoSocial: String(cfg.razaoSocial || cfg.fantasia || 'LOJA'),
      ambiente: (cfg.ambiente === '1' ? '1' : '2') as '1' | '2',
      ender,
      certPfxB64, certPfxPass,
    };
  }

  // ── helpers (mesmo padrão da NF-e) ──────────────────────────────────────
  private dhEmiNow(): string {
    const local = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return local.toISOString().slice(0, 19) + '-03:00';
  }

  private calcDV(chave43: string): string {
    const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
    let soma = 0;
    for (let i = chave43.length - 1, p = 0; i >= 0; i--, p = (p + 1) % pesos.length) {
      soma += parseInt(chave43[i], 10) * pesos[p];
    }
    const resto = soma % 11;
    return String(resto < 2 ? 0 : 11 - resto);
  }

  private buildChave(input: { cUF: string; cnpj: string; serie: string; numero: number; cDC: string; dataEmissao: Date }): string {
    const aamm = String(input.dataEmissao.getFullYear()).slice(-2) + String(input.dataEmissao.getMonth() + 1).padStart(2, '0');
    const semDv =
      input.cUF.padStart(2, '0') + aamm + input.cnpj.padStart(14, '0') +
      '99' + String(input.serie).padStart(3, '0') + String(input.numero).padStart(9, '0') +
      '1' + input.cDC.padStart(8, '0');
    return semDv + this.calcDV(semDv);
  }

  private esc(s: string): string {
    return String(s || '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private money(v: number): string { return (Math.round(v * 100) / 100).toFixed(2); }

  private buildXml(p: {
    chave: string; cDC: string; serie: string; numero: number; dhEmi: string; tpAmb: '1' | '2';
    fiscal: { cnpj: string; razaoSocial: string; ender: any };
    dest: DceDestInput; itens: DceItemInput[]; valorTotal: number;
  }): string {
    const e = this.esc.bind(this);
    const homolog = p.tpAmb === '2';
    const enderLoja = p.fiscal.ender;

    // nSiteAutoriz: site autorizador (SVD). Ajustável por env na homologação.
    const nSite = process.env.DCE_NSITE || '0';
    // Observações obrigatórias do leiaute (xObs1 ICMS / xObs2 tributária) —
    // TEXTO DEFINIDO PELO CONTADOR. Placeholders ajustáveis por env.
    const xObs1 = process.env.DCE_XOBS1 || 'DECLARO QUE O CONTEUDO DESTA DECLARACAO E VERDADEIRO E ASSUMO RESPONSABILIDADE';
    const xObs2 = process.env.DCE_XOBS2 || 'DOCUMENTO EMITIDO NOS TERMOS DO AJUSTE SINIEF 22/2025';

    const endereco = (x: { logradouro: string; numero: string; complemento?: string; bairro: string; cMun: string; cidade: string; uf: string; cep: string; fone?: string; email?: string }) =>
      `<xLgr>${e(x.logradouro)}</xLgr><nro>${e(x.numero || 'SN')}</nro>` +
      (x.complemento ? `<xCpl>${e(x.complemento)}</xCpl>` : '') +
      `<xBairro>${e(x.bairro || 'CENTRO')}</xBairro><cMun>${x.cMun}</cMun><xMun>${e(x.cidade)}</xMun>` +
      `<UF>${x.uf}</UF><CEP>${String(x.cep).replace(/\D/g, '').padStart(8, '0').slice(0, 8)}</CEP>` +
      `<cPais>1058</cPais><xPais>BRASIL</xPais>` +
      (x.fone ? `<fone>${String(x.fone).replace(/\D/g, '').slice(0, 12)}</fone>` : '');

    const destCpfCnpj = (p.dest.cpfCnpj || '').replace(/\D/g, '');
    const destDoc = destCpfCnpj.length === 14 ? `<CNPJ>${destCpfCnpj}</CNPJ>` : destCpfCnpj.length === 11 ? `<CPF>${destCpfCnpj}</CPF>` : '';
    const destNome = homolog ? 'DCE EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : (p.dest.nome || 'DESTINATARIO');
    // código IBGE do município do destinatário: se não veio, usa o da loja
    // (a homologação acusa se for obrigatório exato — ajustar depois)
    const destCMun = String(p.dest.codMunicipio || enderLoja.codMunicipio);

    const det = p.itens.map((it, i) =>
      `<det nItem="${i + 1}">` +
      `<xProd>${e(String(it.descricao || 'Vestuário').slice(0, 120))}</xProd>` +
      `<NCM>${String(it.ncm || '61').replace(/\D/g, '').slice(0, 8) || '61'}</NCM>` +
      `<qCom>${this.money(it.quantidade)}</qCom>` +
      `<vUnCom>${this.money(it.valorUnit)}</vUnCom>` +
      `<vProd>${this.money(it.quantidade * it.valorUnit)}</vProd>` +
      `</det>`,
    ).join('');

    return (
      `<DCe xmlns="${DCE_NS}" versao="${DCE_VERSAO}">` +
      `<infDCe Id="DCe${p.chave}" versao="${DCE_VERSAO}">` +
      `<ide>` +
      `<cUF>35</cUF><cDC>${p.cDC}</cDC><mod>99</mod><serie>${p.serie}</serie><nDC>${p.numero}</nDC>` +
      `<dhEmi>${p.dhEmi}</dhEmi><tpEmis>1</tpEmis><tpEmit>2</tpEmit><nSiteAutoriz>${nSite}</nSiteAutoriz>` +
      `<tpAmb>${p.tpAmb}</tpAmb><verProc>LurdsOrderOne-1.0</verProc>` +
      `</ide>` +
      `<emit><CNPJ>${p.fiscal.cnpj}</CNPJ><xNome>${e(p.fiscal.razaoSocial)}</xNome></emit>` +
      `<rem>` +
      `<CNPJ>${p.fiscal.cnpj}</CNPJ><xNome>${e(p.fiscal.razaoSocial)}</xNome>` +
      `<enderRem>${endereco({
        logradouro: enderLoja.logradouro, numero: enderLoja.numero, bairro: enderLoja.bairro,
        cMun: String(enderLoja.codMunicipio), cidade: enderLoja.municipio || enderLoja.cidade, uf: enderLoja.uf || 'SP', cep: enderLoja.cep,
      })}</enderRem>` +
      `</rem>` +
      `<dest>` +
      destDoc +
      `<xNome>${e(destNome)}</xNome>` +
      `<enderDest>${endereco({
        logradouro: p.dest.logradouro, numero: p.dest.numero, complemento: p.dest.complemento,
        bairro: p.dest.bairro, cMun: destCMun, cidade: p.dest.cidade, uf: p.dest.uf, cep: p.dest.cep, fone: p.dest.fone,
      })}</enderDest>` +
      `</dest>` +
      det +
      `<transp><modTrans>0</modTrans></transp>` + // 0 = Correios/ECT
      `<tot><vDC>${this.money(p.valorTotal)}</vDC></tot>` +
      `<infAdic><xObs1>${e(xObs1)}</xObs1><xObs2>${e(xObs2)}</xObs2></infAdic>` +
      `</infDCe>` +
      `</DCe>`
    );
  }
}
