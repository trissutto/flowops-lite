import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import * as QRCode from 'qrcode';
import {
  signXmlNfeWithA1,
  buildQrCodeUrlNfce,
  buildUrlConsultaNfce,
  transmitNfeSefazSp,
  cancelNfceSefazSp,
} from './nfce-sefaz';

/**
 * NFC-e (NFe modelo 65) — emissão fiscal de cupom no PDV.
 *
 * Multi-loja: cada loja tem CNPJ/IE/CSC/A1 próprios, então a config é
 * persistida por `storeCode` (model NfceConfig). O PDV usa a config da
 * loja onde a venda foi feita (PdvSale.storeCode).
 *
 * Estados deste service:
 *   1. STUB    → gera XML estruturado válido + chave de acesso REAL,
 *                marca status='preview'. NÃO transmite à SEFAZ.
 *   2. HOMOLOG → transmite ao ambiente de homologação SEFAZ-SP (testes)
 *                quando certificado A1 + CSC estão configurados.
 *   3. PROD    → transmite ao ambiente de produção quando ambiente='1'
 *
 * IMPORTANTE: A transmissão real exige biblioteca de assinatura digital XML
 * (xml-crypto + node-forge) e SOAP (axios + xml). Quando o certificado A1
 * estiver carregado, plugar a função `transmitToSefaz()` abaixo.
 */
@Injectable()
export class NfceService {
  private readonly logger = new Logger(NfceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Config CRUD por loja ────────────────────────────────────────────

  /**
   * Lê config de UMA loja específica. Cria registro vazio se não existir
   * (pra retornar status "não configurado" sem quebrar).
   */
  async getConfig(storeCode: string) {
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');

    let cfg = await (this.prisma as any).nfceConfig.findUnique({
      where: { storeCode },
    });

    if (!cfg) {
      // Sem registro: retorna estrutura vazia (não persiste)
      return {
        storeCode,
        storeName: null,
        ambiente: '2',
        uf: 'SP',
        cnpj: null,
        razaoSocial: null,
        fantasia: null,
        ie: null,
        regime: '1',
        endereco: null,
        cscId: null,
        cscToken: '',
        serie: '1',
        numeroAtual: 0,
        certificadoCarregado: false,
        ready: false,
      };
    }

    return {
      storeCode: cfg.storeCode,
      storeName: cfg.storeName,
      ambiente: cfg.ambiente || '2',
      uf: cfg.uf || 'SP',
      cnpj: cfg.cnpj,
      razaoSocial: cfg.razaoSocial,
      fantasia: cfg.fantasia,
      ie: cfg.ie,
      regime: cfg.regime || '1',
      endereco: cfg.endereco ? JSON.parse(cfg.endereco) : null,
      cscId: cfg.cscId,
      // NÃO retorna o token pra cliente — só status
      cscToken: cfg.cscToken ? '••••••••' : '',
      serie: cfg.serie || '1',
      numeroAtual: cfg.numeroAtual || 0,
      certificadoCarregado: !!cfg.certPfxB64,
      ready:
        !!cfg.cnpj && !!cfg.ie && !!cfg.cscToken && !!cfg.certPfxB64,
    };
  }

  /**
   * Lista status de TODAS as lojas (pra dashboard / seletor).
   */
  async listAllStatus() {
    const stores = await this.prisma.store.findMany({
      where: { active: true } as any,
      select: { code: true, name: true } as any,
      orderBy: { code: 'asc' } as any,
    });
    const configs = await (this.prisma as any).nfceConfig.findMany();
    const cfgByCode = new Map<string, any>();
    for (const c of configs as any[]) cfgByCode.set(c.storeCode, c);

    return (stores as any[]).map((s: any) => {
      const c = cfgByCode.get(s.code);
      const ready = !!(c?.cnpj && c?.ie && c?.cscToken && c?.certPfxB64);
      return {
        storeCode: s.code,
        storeName: s.name,
        configured: !!c,
        ready,
        ambiente: c?.ambiente || null,
        cnpj: c?.cnpj || null,
        certificadoCarregado: !!c?.certPfxB64,
      };
    });
  }

  /**
   * Salva config de uma loja (upsert). Campos sensíveis (cscToken, certPfxB64,
   * certPfxPass) só são alterados se vierem preenchidos no body.
   */
  async setConfig(
    storeCode: string,
    input: Partial<{
      ambiente: '1' | '2';
      uf: string;
      cnpj: string;
      razaoSocial: string;
      fantasia: string;
      ie: string;
      regime: string;
      endereco: any;
      cscId: string;
      cscToken: string;
      serie: string;
      numeroAtual: number;
      certPfxB64: string;
      certPfxPass: string;
    }>,
  ) {
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');

    // Resolve nome da loja (snapshot)
    const store = await this.prisma.store.findUnique({
      where: { code: storeCode },
      select: { code: true, name: true } as any,
    });
    if (!store) throw new BadRequestException(`Loja ${storeCode} não cadastrada`);

    const existing = await (this.prisma as any).nfceConfig.findUnique({
      where: { storeCode },
    });

    const data: any = {
      storeName: (store as any).name,
    };
    if (input.ambiente != null) data.ambiente = input.ambiente;
    if (input.uf != null) data.uf = input.uf;
    if (input.cnpj != null) data.cnpj = input.cnpj.replace(/\D/g, '');
    if (input.razaoSocial != null) data.razaoSocial = input.razaoSocial;
    if (input.fantasia != null) data.fantasia = input.fantasia;
    if (input.ie != null) data.ie = input.ie.replace(/\D/g, '');
    if (input.regime != null) data.regime = input.regime;
    if (input.endereco != null) data.endereco = JSON.stringify(input.endereco);
    if (input.cscId != null) data.cscId = input.cscId;
    if (input.serie != null) data.serie = input.serie;
    if (input.numeroAtual != null && input.numeroAtual > 0) {
      data.numeroAtual = input.numeroAtual;
    }
    // Sensíveis: só sobrescreve se vier valor novo
    if (input.cscToken) data.cscToken = input.cscToken;
    if (input.certPfxB64) data.certPfxB64 = input.certPfxB64;
    if (input.certPfxPass) data.certPfxPass = input.certPfxPass;

    if (existing) {
      await (this.prisma as any).nfceConfig.update({
        where: { storeCode },
        data,
      });
    } else {
      await (this.prisma as any).nfceConfig.create({
        data: { storeCode, ...data },
      });
    }

    this.logger.log(`[nfce] config salva pra loja ${storeCode}`);
    return this.getConfig(storeCode);
  }

  // ── Helpers de número e chave ───────────────────────────────────────

  private async nextNumero(storeCode: string): Promise<number> {
    const cur = await (this.prisma as any).nfceConfig.findUnique({
      where: { storeCode },
      select: { numeroAtual: true },
    });
    const atual = cur?.numeroAtual || 0;
    const proximo = atual + 1;
    await (this.prisma as any).nfceConfig.update({
      where: { storeCode },
      data: { numeroAtual: proximo },
    });
    return proximo;
  }

  /**
   * Calcula o dígito verificador (módulo 11) da chave de acesso NFe.
   */
  private calcDV(chave43: string): string {
    if (chave43.length !== 43) throw new Error('Chave deve ter 43 dígitos antes do DV');
    const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
    let soma = 0;
    for (let i = chave43.length - 1, p = 0; i >= 0; i--, p = (p + 1) % pesos.length) {
      soma += parseInt(chave43[i], 10) * pesos[p];
    }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    return String(dv);
  }

  /**
   * Monta a chave de acesso NFe (44 dígitos):
   *   cUF(2) + AAMM(4) + CNPJ(14) + mod(2)=65 + serie(3) + nNF(9) + tpEmis(1)=1 + cNF(8) + DV(1)
   */
  private buildChave(input: {
    cUF: string;
    cnpj: string;
    serie: string;
    numero: number;
    dataEmissao: Date;
  }): string {
    const aamm =
      String(input.dataEmissao.getFullYear()).slice(-2) +
      String(input.dataEmissao.getMonth() + 1).padStart(2, '0');
    const mod = '65';
    const serie = String(input.serie).padStart(3, '0');
    const nNF = String(input.numero).padStart(9, '0');
    const tpEmis = '1';
    const cNF = crypto.randomInt(10_000_000, 99_999_999).toString();
    const sem_dv =
      input.cUF.padStart(2, '0') +
      aamm +
      input.cnpj.padStart(14, '0') +
      mod +
      serie +
      nNF +
      tpEmis +
      cNF;
    return sem_dv + this.calcDV(sem_dv);
  }

  // ── Geração XML ─────────────────────────────────────────────────────

  private async buildXml(sale: any, config: any, chave: string, numero: number): Promise<string> {
    const ambiente = config.ambiente;
    // dhEmi precisa estar no formato ISO com timezone OFFSET (-03:00),
    // NÃO com Z. SEFAZ NF-e 4.00 (TDateTimeUTC) só aceita os offsets
    // -01:00, -02:00, -03:00, -04:00, -05:00 ou +00:00. Usar Z resulta
    // em rejeição cStat 225 (Falha no Schema XML).
    const dhEmi = (() => {
      const now = new Date();
      // Brasília UTC-3 (sem horário de verão desde 2019)
      const local = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      return local.toISOString().slice(0, 19) + '-03:00';
    })();
    const items = sale.items as any[];

    // CPF tem 11 digitos, CNPJ tem 14. SEFAZ rejeita CNPJ na tag <CPF>.
    const docDest = (sale.customerCpf || '').replace(/\D/g, '');
    let dest = '';
    if (docDest.length === 11) {
      dest = `<dest><CPF>${docDest}</CPF><xNome>${this.esc(sale.customerName || 'CONSUMIDOR')}</xNome><indIEDest>9</indIEDest></dest>`;
    } else if (docDest.length === 14) {
      dest = `<dest><CNPJ>${docDest}</CNPJ><xNome>${this.esc(sale.customerName || 'CONSUMIDOR')}</xNome><indIEDest>9</indIEDest></dest>`;
    } else if (docDest.length > 0) {
      this.logger.warn(`[nfce] customerCpf com ${docDest.length} digitos invalidos: ${docDest}. Emitindo sem destinatario.`);
    }

    // ─── Distribuição de desconto nos itens ───
    // SEFAZ exige que vDesc(total) = SOMA dos vDesc(por item) (cStat 537).
    // E vNF = vProd − vDesc (cStat 610).
    //
    // Cenários cobertos:
    //   1. Promoção desconta NO ITEM (it.desconto > 0, sale.desconto = 0)
    //      → usa it.desconto direto, não distribui nada extra
    //   2. Vendedora aplica desconto NA VENDA TODA (sale.desconto > 0)
    //      → distribui proporcionalmente entre os itens
    //   3. Misto (promoção + desconto venda)
    //      → soma os dois corretamente sem duplicar
    //
    // Lógica: o desconto EFETIVO total = brutoTotal − sale.total. Subtrai a
    // soma dos descontos JÁ aplicados nos itens — o que sobra é o desconto
    // adicional na venda toda, que distribuímos proporcionalmente.
    const brutoTotal = items.reduce(
      (s: number, it: any) => s + (it.qty || 0) * (it.precoUnit || 0),
      0,
    );
    const totalLiquido = Number(sale.total || 0);
    const descontoEfetivoTotal = Math.max(0, brutoTotal - totalLiquido);
    const somaDescontosItens = items.reduce(
      (s: number, it: any) => s + Number(it.desconto || 0),
      0,
    );
    const descontoVendaExtra = Math.max(
      0,
      descontoEfetivoTotal - somaDescontosItens,
    );

    const descontoPorItem = new Map<number, number>();
    let descAcumulado = 0;
    items.forEach((it: any, idx: number) => {
      const bruto = (it.qty || 0) * (it.precoUnit || 0);
      const descItemOriginal = Number(it.desconto || 0);
      let parcelaExtra: number;
      if (idx === items.length - 1) {
        // Último item: pega o resíduo pra fechar o total exato (anti-rounding)
        parcelaExtra = Math.max(0, descontoVendaExtra - descAcumulado);
      } else if (brutoTotal > 0) {
        parcelaExtra = Number(
          ((bruto / brutoTotal) * descontoVendaExtra).toFixed(2),
        );
        descAcumulado += parcelaExtra;
      } else {
        parcelaExtra = 0;
      }
      descontoPorItem.set(idx, descItemOriginal + parcelaExtra);
    });

    // Regime tributário define que tipo de bloco ICMS/PIS/COFINS gera:
    //   CRT=1: Simples Nacional       → CSOSN/PISNT/COFINSNT
    //   CRT=3: Lucro Real/Presumido   → CST/PIS Cumulativo/COFINS Cumulativo
    // Alíquotas configuráveis com defaults padrão SP varejo de vestuário.
    const crt = String(config.regime || '1');
    const isSimples = crt === '1' || crt === '2' || crt === '4';
    const pICMS = Number(config.aliqICMS || 18.0);  // 18% SP padrão
    const pPIS = Number(config.aliqPIS || 0.65);    // 0.65% Lucro Presumido cumulativo
    const pCOFINS = Number(config.aliqCOFINS || 3.0); // 3% Lucro Presumido cumulativo

    // Acumuladores pros totais (preenchidos em loop pra Lucro Presumido)
    let vBCTot = 0;
    let vICMSTot = 0;
    let vPISTot = 0;
    let vCOFINSTot = 0;

    const detLines = items
      .map((it: any, idx: number) => {
        const nItem = idx + 1;
        const cProd = it.sku || `SEM-CODIGO-${nItem}`;
        // Em homologação, o PRIMEIRO item DEVE ter exatamente esta descrição
        // (regra fixa SEFAZ — cStat 373 se diferente).
        const xProd =
          ambiente === '2' && idx === 0
            ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            : it.descricao || cProd;
        // NCM: SEFAZ valida contra TIPI real em produção (cStat 778 se inválido).
        //   Simples Nacional pode usar 00000000 (genérico aceito).
        //   Lucro Presumido/Real PRECISA NCM real existente na TIPI.
        // Fallback 61099000 = "T-shirts, camisetas interiores e similares, de
        // malha" — NCM real válido na TIPI, comumente aceito como genérico pra
        // vestuário. Capítulos válidos pra vestuário: 61, 62, 63.
        const ncmFromErp = String(it.ncm || '').replace(/\D/g, '');
        const isValidNcm = (n: string): boolean => {
          if (n.length !== 8) return false;
          if (n === '00000000' || n === '99999999') return false;
          // Capítulo (2 primeiros dígitos) deve estar em 01-97 (range válido TIPI).
          // Capítulos 98/99 são reservados/inexistentes.
          const cap = parseInt(n.substring(0, 2), 10);
          if (isNaN(cap) || cap < 1 || cap > 97) return false;
          return true;
        };
        const ncm = isValidNcm(ncmFromErp)
          ? ncmFromErp
          : (isSimples ? '00000000' : '61099000');
        const cfop = it.cfop || '5102';
        const vUnCom = (it.precoUnit || 0).toFixed(2);
        // vProd = bruto sem descontos (qty × precoUnit). vDesc é separado.
        const brutoItem = (it.qty || 0) * (it.precoUnit || 0);
        const vProd = brutoItem.toFixed(2);
        const vDesc = (descontoPorItem.get(idx) || 0).toFixed(2);

        // Base de cálculo = valor líquido do item (vProd - vDesc)
        const baseCalc = Math.max(0, brutoItem - (descontoPorItem.get(idx) || 0));
        const vICMSItem = isSimples ? 0 : Math.round(baseCalc * (pICMS / 100) * 100) / 100;
        const vPISItem = isSimples ? 0 : Math.round(baseCalc * (pPIS / 100) * 100) / 100;
        const vCOFINSItem = isSimples ? 0 : Math.round(baseCalc * (pCOFINS / 100) * 100) / 100;
        vBCTot += isSimples ? 0 : baseCalc;
        vICMSTot += vICMSItem;
        vPISTot += vPISItem;
        vCOFINSTot += vCOFINSItem;

        // Bloco de imposto conforme regime
        const impostoBlock = isSimples
          ? `<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
        <PIS><PISNT><CST>07</CST></PISNT></PIS>
        <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>`
          : `<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>${baseCalc.toFixed(2)}</vBC><pICMS>${pICMS.toFixed(2)}</pICMS><vICMS>${vICMSItem.toFixed(2)}</vICMS></ICMS00></ICMS><PIS><PISAliq><CST>01</CST><vBC>${baseCalc.toFixed(2)}</vBC><pPIS>${pPIS.toFixed(2)}</pPIS><vPIS>${vPISItem.toFixed(2)}</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>01</CST><vBC>${baseCalc.toFixed(2)}</vBC><pCOFINS>${pCOFINS.toFixed(2)}</pCOFINS><vCOFINS>${vCOFINSItem.toFixed(2)}</vCOFINS></COFINSAliq></COFINS>`;

        return `
    <det nItem="${nItem}">
      <prod>
        <cProd>${this.esc(cProd)}</cProd>
        <cEAN>${this.esc(it.ean || 'SEM GTIN')}</cEAN>
        <xProd>${this.esc(xProd)}</xProd>
        <NCM>${ncm}</NCM>
        <CFOP>${cfop}</CFOP>
        <uCom>UN</uCom>
        <qCom>${(it.qty || 1).toFixed(4)}</qCom>
        <vUnCom>${vUnCom}</vUnCom>
        <vProd>${vProd}</vProd>
        <cEANTrib>${this.esc(it.ean || 'SEM GTIN')}</cEANTrib>
        <uTrib>UN</uTrib>
        <qTrib>${(it.qty || 1).toFixed(4)}</qTrib>
        <vUnTrib>${vUnCom}</vUnTrib>
        ${vDesc !== '0.00' ? `<vDesc>${vDesc}</vDesc>` : ''}
        <indTot>1</indTot>
      </prod>
      <imposto>
        ${impostoBlock}
      </imposto>
    </det>`.trim();
      })
      .join('\n');

    // vProd = soma dos (qty × precoUnit) sem descontos — bruto
    const vTotProdNum = items.reduce(
      (s, it) => s + (it.qty || 0) * (it.precoUnit || 0),
      0,
    );
    const vNFNum = Number(sale.total || 0);
    // SEFAZ valida: vNF = vProd - vDesc. Calcula vDesc TOTAL como diferença
    // entre o bruto e o que cliente realmente pagou. Cobre tanto descontos
    // por item quanto descontos aplicados na venda inteira (ex: -R$ 22,90
    // aplicados via /sales/:id/discount).
    const vDescTotNum = Math.max(0, vTotProdNum - vNFNum);
    const vTotProd = vTotProdNum.toFixed(2);
    const vDescTot = vDescTotNum.toFixed(2);
    const vNF = vNFNum.toFixed(2);

    const payments = (sale.payments || []) as any[];
    const pagLines = payments
      .map((p: any) => {
        const tPag = this.mapPaymentToSefaz(p.method);
        // FIX REJEIÇÃO 391: pra cartão crédito (03) ou débito (04),
        // SEFAZ exige o grupo <card> com CNPJ da credenciadora + bandeira.
        // Como não temos integração com TEF, usamos os dados padrão do
        // próprio CNPJ + bandeira "outros (99)" — válido em todas UFs.
        let cardBlock = '';
        if (tPag === '03' || tPag === '04') {
          // tBand=99 é "Outros" — aceito sem precisar identificar Visa/Master/etc
          // CNPJ credenciadora: usa o CNPJ do próprio emitente como fallback
          // genérico. Se Lurd's tiver TEF integrado depois, substitui pelo CNPJ
          // real da credenciadora (Cielo, Stone, Rede, etc).
          const cnpjCred = String(config.cnpj || '').replace(/\D/g, '').padStart(14, '0').slice(0, 14);
          cardBlock = `<card><tpIntegra>2</tpIntegra><CNPJ>${cnpjCred}</CNPJ><tBand>99</tBand><cAut>0</cAut></card>`;
        }
        // indPag=0 (à vista) é tecnicamente opcional, mas SEFAZ-SP PL_009
        // tem reportes de rejeição cStat 225 sem ele em algumas variantes
        // de venda. Adiciona pra garantir compatibilidade.
        return `<detPag><indPag>0</indPag><tPag>${tPag}</tPag><vPag>${(p.valor || 0).toFixed(2)}</vPag>${cardBlock}</detPag>`;
      })
      .join('');

    const ender = config.endereco || {};
    const cMun = ender.codMunicipio || '3550308';
    const xMun = ender.municipio || 'SAO PAULO';

    // ── Sanitização blindada (evita cStat 225 - falha de schema) ────────
    // CEP: SEFAZ exige EXATAMENTE 8 dígitos. Padding curto, truncamento longo.
    const sanitizeCep = (raw: string): string => {
      const onlyDigits = String(raw || '').replace(/\D/g, '');
      if (onlyDigits.length === 0) return '00000000';
      if (onlyDigits.length >= 8) return onlyDigits.slice(0, 8);
      return onlyDigits.padStart(8, '0');
    };
    const cepFinal = sanitizeCep(ender.cep);

    // CNPJ: 14 dígitos exatos
    const cnpjFinal = String(config.cnpj || '').replace(/\D/g, '').padStart(14, '0').slice(0, 14);
    // IE: só dígitos, max 14
    const ieFinal = String(config.ie || '').replace(/\D/g, '').slice(0, 14);
    // Strings de endereço/empresa: trim + max 60 chars (pattern xs:string da NFe)
    const trim60 = (s: string) => String(s || '').trim().slice(0, 60);
    const trim2to60 = (s: string, fb = 'NAO INFORMADO') => {
      const v = trim60(s);
      return v.length >= 2 ? v : fb;
    };

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe${chave}" versao="4.00">
    <ide>
      <cUF>35</cUF>
      <cNF>${chave.substring(35, 43)}</cNF>
      <natOp>VENDA AO CONSUMIDOR</natOp>
      <mod>65</mod>
      <serie>${parseInt(config.serie, 10)}</serie>
      <nNF>${numero}</nNF>
      <dhEmi>${dhEmi}</dhEmi>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>${cMun}</cMunFG>
      <tpImp>4</tpImp>
      <tpEmis>1</tpEmis>
      <cDV>${chave.substring(43, 44)}</cDV>
      <tpAmb>${ambiente}</tpAmb>
      <finNFe>1</finNFe>
      <indFinal>1</indFinal>
      <indPres>1</indPres>
      <procEmi>0</procEmi>
      <verProc>LurdsV3</verProc>
    </ide>
    <emit>
      <CNPJ>${cnpjFinal}</CNPJ>
      <xNome>${this.esc(trim2to60(config.razaoSocial))}</xNome>
      <xFant>${this.esc(trim2to60(config.fantasia, trim2to60(config.razaoSocial)))}</xFant>
      <enderEmit>
        <xLgr>${this.esc(trim2to60(ender.logradouro))}</xLgr>
        <nro>${this.esc(String(ender.numero || 'S/N').trim().slice(0, 60))}</nro>
        <xBairro>${this.esc(trim2to60(ender.bairro))}</xBairro>
        <cMun>${cMun}</cMun>
        <xMun>${this.esc(trim2to60(xMun))}</xMun>
        <UF>${(config.uf || 'SP').trim().toUpperCase().slice(0, 2)}</UF>
        <CEP>${cepFinal}</CEP>
      </enderEmit>
      <IE>${ieFinal}</IE>
      <CRT>${config.regime || '1'}</CRT>
    </emit>
    ${dest}
    ${detLines}
    <total>
      <ICMSTot>
        <vBC>${vBCTot.toFixed(2)}</vBC><vICMS>${vICMSTot.toFixed(2)}</vICMS><vICMSDeson>0.00</vICMSDeson>
        <vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>
        <vProd>${vTotProd}</vProd>
        <vFrete>0.00</vFrete><vSeg>0.00</vSeg>
        <vDesc>${vDescTot}</vDesc>
        <vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>
        <vPIS>${vPISTot.toFixed(2)}</vPIS><vCOFINS>${vCOFINSTot.toFixed(2)}</vCOFINS><vOutro>0.00</vOutro>
        <vNF>${vNF}</vNF>
      </ICMSTot>
    </total>
    <transp><modFrete>9</modFrete></transp>
    <pag>${pagLines}</pag>
    <infAdic><infCpl>${isSimples ? 'Documento emitido por ME ou EPP optante pelo Simples Nacional. NAO GERA DIREITO A CREDITO FISCAL DE IPI.' : 'Valor aproximado dos tributos Federais/Estaduais/Municipais conforme Lei 12.741/2012.'}</infCpl></infAdic>
    <infRespTec><CNPJ>20104813000139</CNPJ><xContato>THIAGO RISSUTTO</xContato><email>atendimento@lurds.com.br</email><fone>1132331004</fone></infRespTec>
  </infNFe><infNFeSupl><qrCode><![CDATA[${buildQrCodeUrlNfce({chave,ambiente:ambiente as '1'|'2',idCSC:config.cscId||'1',cscToken:config.cscToken||''})}]]></qrCode><urlChave>${buildUrlConsultaNfce(ambiente as '1'|'2')}</urlChave></infNFeSupl></NFe>`.trim();
    this.logger.log(`[NFCe-V3-SUPL] XML gerado tamanho=${xml.length} contemSupl=${xml.includes('infNFeSupl')}`);

    // ═══════════════════════════════════════════════════════════════════
    // MINIFICA: SEFAZ NFC-e rejeita whitespace entre tags (cStat 588).
    // Remove whitespace entre `>` e `<` mas preserva conteúdo de elementos.
    // Isso DEVE ser feito ANTES da assinatura — caso contrário o digest
    // calculado não baterá com o XML transmitido.
    // ═══════════════════════════════════════════════════════════════════
    const xmlMinificado = xml.replace(/>\s+</g, '><').trim();

    return xmlMinificado;
  }

  /**
   * Monta <infNFeSupl> — elemento OBRIGATÓRIO em NFC-e (mod=65).
   * Contém o QR Code e a URL pública de consulta da nota.
   * Posição: depois de </infNFe> e antes de <Signature> (cStat 394 sem isso).
   */
  private buildInfNFeSupl(
    chave: string,
    ambiente: string,
    cscId: string,
    cscToken: string,
  ): string {
    const qrUrl = buildQrCodeUrlNfce({
      chave,
      ambiente: ambiente as '1' | '2',
      idCSC: cscId || '1',
      cscToken: cscToken || '',
    });
    const urlChave = buildUrlConsultaNfce(ambiente as '1' | '2');
    // CDATA pra escapar `&` da URL (SEFAZ exige)
    return `<infNFeSupl><qrCode><![CDATA[${qrUrl}]]></qrCode><urlChave>${urlChave}</urlChave></infNFeSupl>`;
  }

  private esc(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private mapPaymentToSefaz(method: string): string {
    const m = String(method || '').toLowerCase();
    if (m === 'dinheiro') return '01';
    if (m === 'cheque') return '02';
    if (m === 'credito' || m === 'cartao_credito') return '03';
    if (m === 'debito' || m === 'cartao_debito') return '04';
    if (m === 'crediario' || m === 'credito_loja') return '05';
    if (m === 'pix') return '17';
    return '99';
  }

  // ── Emissão (público) ───────────────────────────────────────────────

  /**
   * Emite NFC-e da venda usando a config DA LOJA onde a venda foi feita.
   */
  async emit(saleId: string): Promise<{
    status: 'preview' | 'authorized' | 'rejected' | 'error';
    chave: string;
    numero: number;
    serie: string;
    xml: string;
    protocolo?: string;
    motivo?: string;
    qrUrl?: string;
    urlConsulta?: string;
  }> {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      include: { items: true, payments: true },
    });
    if (!sale) throw new BadRequestException('Venda não encontrada');
    if (sale.status !== 'finalized') {
      throw new BadRequestException('Venda precisa estar finalizada');
    }
    if (sale.nfceStatus === 'authorized') {
      return {
        status: 'authorized',
        chave: sale.nfceChave,
        numero: parseInt(sale.nfceNumber || '0', 10),
        serie: sale.nfceSerie || '1',
        xml: sale.nfceXml || '',
      };
    }

    const cfgRaw = await (this.prisma as any).nfceConfig.findUnique({
      where: { storeCode: sale.storeCode },
    });
    if (!cfgRaw) {
      throw new BadRequestException(
        `NFC-e não configurada pra loja ${sale.storeCode}. Cadastre em Retaguarda → NFC-e.`,
      );
    }
    if (!cfgRaw.cnpj) {
      throw new BadRequestException(
        `Loja ${sale.storeCode} sem CNPJ cadastrado pra NFC-e.`,
      );
    }

    const config = {
      ambiente: cfgRaw.ambiente || '2',
      uf: cfgRaw.uf || 'SP',
      cnpj: cfgRaw.cnpj,
      razaoSocial: cfgRaw.razaoSocial || '',
      fantasia: cfgRaw.fantasia || '',
      ie: cfgRaw.ie || '',
      regime: cfgRaw.regime || '1',
      endereco: cfgRaw.endereco ? JSON.parse(cfgRaw.endereco) : {},
      serie: cfgRaw.serie || '1',
      cscId: cfgRaw.cscId || '1',
      cscToken: cfgRaw.cscToken || '',
    };
    const ready = !!(cfgRaw.cnpj && cfgRaw.ie && cfgRaw.cscToken && cfgRaw.certPfxB64);

    const numero = await this.nextNumero(sale.storeCode);
    const chave = this.buildChave({
      cUF: '35',
      cnpj: config.cnpj.replace(/\D/g, ''),
      serie: config.serie,
      numero,
      dataEmissao: new Date(),
    });

    const xml = await this.buildXml(sale, config, chave, numero);

    const status: 'preview' | 'authorized' = 'preview';
    await (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        nfceStatus: status,
        nfceNumber: String(numero),
        nfceSerie: config.serie,
        nfceChave: chave,
        nfceXml: xml,
      },
    });

    if (!ready) {
      this.logger.warn(
        `[nfce] Venda ${sale.id.slice(0, 8)} loja=${sale.storeCode} sem certificado/CSC — XML preview (chave ${chave})`,
      );
      return { status: 'preview', chave, numero, serie: config.serie, xml };
    }

    // ── EMISSÃO REAL: assinar + transmitir SEFAZ-SP ──
    let xmlAssinado: string;
    try {
      xmlAssinado = signXmlNfeWithA1({
        xml,
        pfxBase64: cfgRaw.certPfxB64,
        pfxPassword: cfgRaw.certPfxPass || '',
      });
    } catch (e: any) {
      this.logger.error(`[nfce] FALHA assinatura: ${e?.message}`);
      await (this.prisma as any).pdvSale.update({
        where: { id: sale.id },
        data: { nfceStatus: 'rejected', nfceMotivo: `Erro assinatura: ${e?.message}` },
      });
      return {
        status: 'rejected',
        chave,
        numero,
        serie: config.serie,
        xml,
        motivo: `Erro ao assinar XML: ${e?.message}`,
      };
    }

    const transmit = await transmitNfeSefazSp({
      xmlAssinado,
      ambiente: config.ambiente as '1' | '2',
      pfxBase64: cfgRaw.certPfxB64,
      pfxPassword: cfgRaw.certPfxPass || '',
    });

    if (!transmit.success) {
      this.logger.error(
        `[nfce] SEFAZ rejeitou: cStat=${transmit.cStat} ${transmit.xMotivo}`,
      );
      await (this.prisma as any).pdvSale.update({
        where: { id: sale.id },
        data: {
          nfceStatus: 'rejected',
          nfceXml: xmlAssinado,
          nfceMotivo: `${transmit.cStat}: ${transmit.xMotivo}`,
        },
      });
      return {
        status: 'rejected',
        chave,
        numero,
        serie: config.serie,
        xml: xmlAssinado,
        motivo: `${transmit.cStat}: ${transmit.xMotivo}`,
      };
    }

    // AUTORIZADA — gera QR Code + salva XML autorizado (procNFe)
    const qrUrl = buildQrCodeUrlNfce({
      chave,
      ambiente: config.ambiente as '1' | '2',
      idCSC: cfgRaw.cscId || '1',
      cscToken: cfgRaw.cscToken,
    });
    const urlConsulta = buildUrlConsultaNfce(config.ambiente as '1' | '2');

    await (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        nfceStatus: 'authorized',
        nfceXml: transmit.xmlAutorizado || xmlAssinado,
        nfceProtocolo: transmit.protocolo,
        nfceQrUrl: qrUrl,
        nfceUrlConsulta: urlConsulta,
        nfceAutorizadaEm: transmit.dhRecbto ? new Date(transmit.dhRecbto) : new Date(),
      },
    });

    this.logger.log(
      `[nfce] AUTORIZADA: chave=${chave} prot=${transmit.protocolo} loja=${sale.storeCode}`,
    );

    return {
      status: 'authorized',
      chave,
      numero,
      serie: config.serie,
      xml: transmit.xmlAutorizado || xmlAssinado,
      protocolo: transmit.protocolo,
      qrUrl,
      urlConsulta,
    };
  }

  /**
   * TESTE — emite NFC-e fictícia (1 item de R$1) pra validar config + cert + SEFAZ.
   * Não persiste no banco de vendas. Retorna tudo (XML, status, motivo, QR).
   */
  async testEmit(storeCode: string): Promise<{
    status: 'authorized' | 'rejected' | 'error';
    chave?: string;
    cStat?: string;
    motivo?: string;
    protocolo?: string;
    qrUrl?: string;
    urlConsulta?: string;
    xmlEnviado?: string;
    xmlResposta?: string;
    error?: string;
  }> {
    const cfgRaw: any = await (this.prisma as any).nfceConfig.findUnique({
      where: { storeCode },
    });
    if (!cfgRaw) {
      return { status: 'error', error: 'NFC-e não configurada pra essa loja' };
    }
    const ready = !!(cfgRaw.cnpj && cfgRaw.ie && cfgRaw.cscToken && cfgRaw.certPfxB64);
    if (!ready) {
      const faltam = [
        !cfgRaw.cnpj && 'CNPJ',
        !cfgRaw.ie && 'IE',
        !cfgRaw.cscToken && 'CSC Token',
        !cfgRaw.certPfxB64 && 'Certificado A1',
      ].filter(Boolean).join(', ');
      return { status: 'error', error: `Config incompleta. Faltam: ${faltam}` };
    }

    const config = {
      ambiente: cfgRaw.ambiente || '2',
      uf: cfgRaw.uf || 'SP',
      cnpj: cfgRaw.cnpj,
      razaoSocial: cfgRaw.razaoSocial || '',
      fantasia: cfgRaw.fantasia || '',
      ie: cfgRaw.ie || '',
      regime: cfgRaw.regime || '1',
      endereco: cfgRaw.endereco ? JSON.parse(cfgRaw.endereco) : {},
      serie: cfgRaw.serie || '1',
      cscId: cfgRaw.cscId || '1',
      cscToken: cfgRaw.cscToken || '',
    };

    // Venda fake R$ 1,00
    const fakeSale: any = {
      id: 'TEST' + Date.now().toString(36).toUpperCase(),
      storeCode,
      total: 1.0,
      desconto: 0,
      subtotal: 1.0,
      customerCpf: null,
      customerName: 'CONSUMIDOR TESTE',
      vendedorName: 'TESTE',
      finalizedAt: new Date(),
      items: [
        {
          id: 'item-1',
          sku: 'TESTE',
          descricao: 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL',
          qty: 1,
          precoUnit: 1.0,
          desconto: 0,
          total: 1.0,
        },
      ],
      payments: [
        { method: 'dinheiro', valor: 1.0, details: null },
      ],
    };

    const numero = await this.nextNumero(storeCode);
    const chave = this.buildChave({
      cUF: '35',
      cnpj: config.cnpj.replace(/\D/g, ''),
      serie: config.serie,
      numero,
      dataEmissao: new Date(),
    });

    let xml: string;
    try {
      xml = await this.buildXml(fakeSale, config, chave, numero);
    } catch (e: any) {
      return { status: 'error', error: `Erro ao montar XML: ${e?.message}` };
    }

    let xmlAssinado: string;
    try {
      xmlAssinado = signXmlNfeWithA1({
        xml,
        pfxBase64: cfgRaw.certPfxB64,
        pfxPassword: cfgRaw.certPfxPass || '',
      });
    } catch (e: any) {
      return {
        status: 'error',
        error: `Erro ao assinar (verifica senha do certificado): ${e?.message}`,
      };
    }

    const transmit = await transmitNfeSefazSp({
      xmlAssinado,
      ambiente: config.ambiente as '1' | '2',
      pfxBase64: cfgRaw.certPfxB64,
      pfxPassword: cfgRaw.certPfxPass || '',
    });

    if (!transmit.success) {
      return {
        status: 'rejected',
        chave,
        cStat: transmit.cStat,
        motivo: transmit.xMotivo,
        xmlEnviado: transmit.xmlEnviado,
        xmlResposta: transmit.xmlResposta,
        error: transmit.error,
      };
    }

    const qrUrl = buildQrCodeUrlNfce({
      chave,
      ambiente: config.ambiente as '1' | '2',
      idCSC: cfgRaw.cscId || '1',
      cscToken: cfgRaw.cscToken,
    });
    const urlConsulta = buildUrlConsultaNfce(config.ambiente as '1' | '2');

    return {
      status: 'authorized',
      chave,
      cStat: transmit.cStat,
      motivo: transmit.xMotivo,
      protocolo: transmit.protocolo,
      qrUrl,
      urlConsulta,
      xmlEnviado: transmit.xmlEnviado,
      xmlResposta: transmit.xmlResposta,
    };
  }

  /**
   * Cancela NFC-e via evento 110111 (até 30min após autorização).
   *
   * @param saleId    - ID da venda PDV
   * @param justificativa - 15-255 chars (regra SEFAZ)
   */
  async cancel(saleId: string, justificativa: string): Promise<{
    success: boolean;
    cStat: string;
    motivo: string;
    nProtCancelamento?: string;
    error?: string;
  }> {
    const sale: any = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
    });
    if (!sale) throw new BadRequestException('Venda não encontrada');
    if (sale.nfceStatus !== 'authorized') {
      throw new BadRequestException(
        `NFC-e dessa venda não está autorizada (status: ${sale.nfceStatus || '—'}). Não há nada pra cancelar.`,
      );
    }
    if (sale.nfceCanceladaEm) {
      throw new BadRequestException(
        `NFC-e já foi cancelada em ${new Date(sale.nfceCanceladaEm).toLocaleString('pt-BR')}.`,
      );
    }
    if (!sale.nfceChave || !sale.nfceProtocolo) {
      throw new BadRequestException(
        'Venda sem chave ou protocolo de NFC-e — impossível cancelar.',
      );
    }

    // Janela de 30min — checa antes de queimar request SEFAZ
    if (sale.nfceAutorizadaEm) {
      const minutosDesdeAutorizacao =
        (Date.now() - new Date(sale.nfceAutorizadaEm).getTime()) / 60000;
      if (minutosDesdeAutorizacao > 30) {
        throw new BadRequestException(
          `NFC-e autorizada há ${Math.floor(minutosDesdeAutorizacao)} minutos. ` +
          `Cancelamento permitido só até 30 minutos após autorização.`,
        );
      }
    }

    const cfgRaw: any = await (this.prisma as any).nfceConfig.findUnique({
      where: { storeCode: sale.storeCode },
    });
    if (!cfgRaw?.certPfxB64) {
      throw new BadRequestException(
        `Loja ${sale.storeCode} sem certificado A1 — impossível assinar cancelamento.`,
      );
    }

    const result = await cancelNfceSefazSp({
      chave: sale.nfceChave,
      protocolo: sale.nfceProtocolo,
      justificativa,
      cnpj: cfgRaw.cnpj || '',
      ambiente: (cfgRaw.ambiente || '2') as '1' | '2',
      pfxBase64: cfgRaw.certPfxB64,
      pfxPassword: cfgRaw.certPfxPass || '',
    });

    if (result.success) {
      await (this.prisma as any).pdvSale.update({
        where: { id: sale.id },
        data: {
          nfceCanceladaEm: new Date(),
          nfceCancelamentoProto: result.nProtCancelamento || null,
          nfceCancelamentoMotivo: justificativa,
          nfceCancelamentoXml: result.xmlResposta,
          nfceStatus: 'cancelled',
        },
      });
      return {
        success: true,
        cStat: result.cStat,
        motivo: result.xMotivo,
        nProtCancelamento: result.nProtCancelamento,
      };
    }

    return {
      success: false,
      cStat: result.cStat,
      motivo: result.xMotivo,
      error: result.error,
    };
  }

  /**
   * Gera PNG (base64) do QR Code NFC-e a partir da URL.
   * Usado pra incluir no DANFE.
   */
  async qrCodePng(url: string): Promise<string> {
    return QRCode.toDataURL(url, { width: 200, margin: 1 });
  }

  buildCupomText(sale: any, chave: string): string {
    const lines: string[] = [];
    const w = 40;
    const center = (s: string) => s.padStart((w + s.length) / 2).padEnd(w);
    const split = (l: string, r: string) => l + r.padStart(w - l.length);

    lines.push(center("LURD'S PLUS SIZE"));
    lines.push(center('CUPOM FISCAL ELETRONICO'));
    lines.push(center('NFC-e'));
    lines.push('-'.repeat(w));
    for (const it of sale.items as any[]) {
      lines.push(`${(it.descricao || it.sku).slice(0, w)}`);
      lines.push(
        split(
          `${it.qty}x R$${(it.precoUnit || 0).toFixed(2)}`,
          `R$${(it.total || 0).toFixed(2)}`,
        ),
      );
    }
    lines.push('-'.repeat(w));
    if ((sale.desconto || 0) > 0) {
      lines.push(split('Desconto', `-R$${sale.desconto.toFixed(2)}`));
    }
    lines.push(split('TOTAL', `R$${(sale.total || 0).toFixed(2)}`));
    lines.push('');
    lines.push(`Chave de acesso:`);
    const chaveFmt = chave.replace(/(.{4})/g, '$1 ').trim();
    lines.push(chaveFmt);
    lines.push('');
    lines.push(center('Consulte em:'));
    lines.push(center('https://www.nfce.fazenda.sp.gov.br'));
    return lines.join('\n');
  }
}
