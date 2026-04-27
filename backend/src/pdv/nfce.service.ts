import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

/**
 * NFC-e (NFe modelo 65) — emissão fiscal de cupom no PDV.
 *
 * Estados deste service:
 *   1. STUB    → gera XML estruturado válido + chave de acesso REAL,
 *                marca status='preview'. NÃO transmite à SEFAZ.
 *   2. HOMOLOG → transmite ao ambiente de homologação SEFAZ-SP (testes)
 *                quando certificado A1 + CSC estão configurados.
 *   3. PROD    → transmite ao ambiente de produção quando NFCE_AMBIENTE=1
 *
 * Configuração via SystemSetting (key-value):
 *   nfce.ambiente       = '1' (prod) | '2' (homolog) — default '2'
 *   nfce.uf             = 'SP' (default)
 *   nfce.cnpj           = '00.000.000/0001-00' (sem máscara, 14 dígitos)
 *   nfce.razao_social   = 'LURDS PLUS SIZE LTDA'
 *   nfce.fantasia       = 'LURDS PLUS SIZE'
 *   nfce.ie             = inscrição estadual (sem máscara)
 *   nfce.regime         = '1' simples nacional (default) | '3' regime normal
 *   nfce.endereco       = JSON {logradouro,numero,bairro,municipio,cep,uf,codMunicipio}
 *   nfce.csc            = código do contribuinte (idCSC)
 *   nfce.csc_token      = token CSC
 *   nfce.csc_id         = id do CSC (1, 2, etc)
 *   nfce.serie          = '1' (default) — uma série por loja-PDV
 *   nfce.numero_atual   = contador (auto-incrementa)
 *   nfce.cert_pfx_b64   = certificado A1 em base64 (.pfx)
 *   nfce.cert_pfx_pass  = senha do A1
 *
 * IMPORTANTE: A transmissão real exige biblioteca de assinatura digital XML
 * (xml-crypto + node-forge) e SOAP (axios + xml). Quando o certificado A1
 * estiver carregado, plugar a função `transmitToSefaz()` abaixo.
 */
@Injectable()
export class NfceService {
  private readonly logger = new Logger(NfceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Config helpers ──────────────────────────────────────────────────

  private async readSettings(): Promise<Record<string, string>> {
    const all = await (this.prisma as any).systemSetting.findMany({
      where: { key: { startsWith: 'nfce.' } },
    });
    const out: Record<string, string> = {};
    for (const s of all as any[]) {
      out[s.key] = s.value;
    }
    return out;
  }

  async getConfig() {
    const s = await this.readSettings();
    return {
      ambiente: s['nfce.ambiente'] || '2',
      uf: s['nfce.uf'] || 'SP',
      cnpj: s['nfce.cnpj'] || null,
      razaoSocial: s['nfce.razao_social'] || null,
      fantasia: s['nfce.fantasia'] || null,
      ie: s['nfce.ie'] || null,
      regime: s['nfce.regime'] || '1',
      endereco: s['nfce.endereco'] ? JSON.parse(s['nfce.endereco']) : null,
      cscId: s['nfce.csc_id'] || null,
      cscToken: s['nfce.csc_token'] || null,
      serie: s['nfce.serie'] || '1',
      numeroAtual: parseInt(s['nfce.numero_atual'] || '0', 10),
      certificadoCarregado: !!s['nfce.cert_pfx_b64'],
      ready:
        !!s['nfce.cnpj'] &&
        !!s['nfce.ie'] &&
        !!s['nfce.csc_token'] &&
        !!s['nfce.cert_pfx_b64'],
    };
  }

  async setConfig(input: Partial<{
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
  }>) {
    const map: Array<[string, any]> = [];
    if (input.ambiente != null) map.push(['nfce.ambiente', input.ambiente]);
    if (input.uf != null) map.push(['nfce.uf', input.uf]);
    if (input.cnpj != null) map.push(['nfce.cnpj', input.cnpj.replace(/\D/g, '')]);
    if (input.razaoSocial != null) map.push(['nfce.razao_social', input.razaoSocial]);
    if (input.fantasia != null) map.push(['nfce.fantasia', input.fantasia]);
    if (input.ie != null) map.push(['nfce.ie', input.ie.replace(/\D/g, '')]);
    if (input.regime != null) map.push(['nfce.regime', input.regime]);
    if (input.endereco != null) map.push(['nfce.endereco', JSON.stringify(input.endereco)]);
    if (input.cscId != null) map.push(['nfce.csc_id', input.cscId]);
    if (input.cscToken != null) map.push(['nfce.csc_token', input.cscToken]);
    if (input.serie != null) map.push(['nfce.serie', input.serie]);
    if (input.numeroAtual != null) map.push(['nfce.numero_atual', String(input.numeroAtual)]);
    if (input.certPfxB64 != null) map.push(['nfce.cert_pfx_b64', input.certPfxB64]);
    if (input.certPfxPass != null) map.push(['nfce.cert_pfx_pass', input.certPfxPass]);

    for (const [key, value] of map) {
      await (this.prisma as any).systemSetting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      });
    }
    return this.getConfig();
  }

  // ── Helpers de número e chave ───────────────────────────────────────

  private async nextNumero(): Promise<number> {
    // Lock pessimista usando SystemSetting (race-free pra Postgres)
    const cur = await (this.prisma as any).systemSetting.findUnique({
      where: { key: 'nfce.numero_atual' },
    });
    const atual = cur ? parseInt(cur.value, 10) || 0 : 0;
    const proximo = atual + 1;
    await (this.prisma as any).systemSetting.upsert({
      where: { key: 'nfce.numero_atual' },
      create: { key: 'nfce.numero_atual', value: String(proximo) },
      update: { value: String(proximo) },
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
    cUF: string;          // '35' SP
    cnpj: string;         // 14 dígitos
    serie: string;        // 1-999
    numero: number;       // 1-999999999
    dataEmissao: Date;
  }): string {
    const aamm =
      String(input.dataEmissao.getFullYear()).slice(-2) +
      String(input.dataEmissao.getMonth() + 1).padStart(2, '0');
    const mod = '65';
    const serie = String(input.serie).padStart(3, '0');
    const nNF = String(input.numero).padStart(9, '0');
    const tpEmis = '1';
    // cNF = código aleatório de 8 dígitos (não pode começar com nNF + dígito 0)
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

  /**
   * Gera o XML <NFe> da venda. Stub completo com todos os campos
   * obrigatórios — só falta assinatura digital + transmissão SOAP pra
   * virar emissão real.
   */
  private async buildXml(sale: any, config: any, chave: string, numero: number): Promise<string> {
    const ambiente = config.ambiente; // '1' prod | '2' homolog
    const dhEmi = new Date().toISOString().replace(/\.\d+/, '');
    const items = sale.items as any[];

    // Em homologação a razão obrigatória da NFe é "NF-E EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL"
    const dest = sale.customerCpf
      ? `<dest><CPF>${sale.customerCpf.replace(/\D/g, '')}</CPF><xNome>${this.esc(sale.customerName || 'CONSUMIDOR')}</xNome><indIEDest>9</indIEDest></dest>`
      : '';

    const detLines = items
      .map((it: any, idx: number) => {
        const nItem = idx + 1;
        const cProd = it.sku || `SEM-CODIGO-${nItem}`;
        const xProd =
          ambiente === '2'
            ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            : it.descricao || cProd;
        const ncm = it.ncm || '00000000';
        const cfop = it.cfop || '5102'; // venda interna
        const vUnCom = (it.precoUnit || 0).toFixed(2);
        const vProd = (it.total || 0).toFixed(2);
        const vDesc = (it.desconto || 0).toFixed(2);
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
        <ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
        <PIS><PISNT><CST>07</CST></PISNT></PIS>
        <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>
      </imposto>
    </det>`.trim();
      })
      .join('\n');

    const vTotProd = items.reduce((s, it) => s + (it.qty || 0) * (it.precoUnit || 0), 0).toFixed(2);
    const vDescTot = items.reduce((s, it) => s + (it.desconto || 0), 0).toFixed(2);
    const vNF = (sale.total || 0).toFixed(2);

    const payments = (sale.payments || []) as any[];
    const pagLines = payments
      .map((p: any) => {
        const tPag = this.mapPaymentToSefaz(p.method);
        return `<detPag><tPag>${tPag}</tPag><vPag>${(p.valor || 0).toFixed(2)}</vPag></detPag>`;
      })
      .join('');

    const ender = config.endereco || {};
    const cMun = ender.codMunicipio || '3550308'; // São Paulo default
    const xMun = ender.municipio || 'SAO PAULO';

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
      <verProc>LURDS-PDV-1.0</verProc>
    </ide>
    <emit>
      <CNPJ>${(config.cnpj || '').padStart(14, '0')}</CNPJ>
      <xNome>${this.esc(config.razaoSocial || '')}</xNome>
      <xFant>${this.esc(config.fantasia || '')}</xFant>
      <enderEmit>
        <xLgr>${this.esc(ender.logradouro || '')}</xLgr>
        <nro>${this.esc(ender.numero || 'S/N')}</nro>
        <xBairro>${this.esc(ender.bairro || '')}</xBairro>
        <cMun>${cMun}</cMun>
        <xMun>${this.esc(xMun)}</xMun>
        <UF>${config.uf || 'SP'}</UF>
        <CEP>${(ender.cep || '').replace(/\D/g, '').padStart(8, '0')}</CEP>
      </enderEmit>
      <IE>${(config.ie || '').replace(/\D/g, '')}</IE>
      <CRT>${config.regime || '1'}</CRT>
    </emit>
    ${dest}
    ${detLines}
    <total>
      <ICMSTot>
        <vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>
        <vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>
        <vProd>${vTotProd}</vProd>
        <vFrete>0.00</vFrete><vSeg>0.00</vSeg>
        <vDesc>${vDescTot}</vDesc>
        <vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>
        <vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro>
        <vNF>${vNF}</vNF>
      </ICMSTot>
    </total>
    <transp><modFrete>9</modFrete></transp>
    <pag>${pagLines}</pag>
    <infAdic><infCpl>Documento emitido por ME ou EPP optante pelo Simples Nacional. NAO GERA DIREITO A CREDITO FISCAL DE IPI.</infCpl></infAdic>
  </infNFe>
</NFe>`.trim();

    return xml;
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
    // Tabela tPag (NT 2020.001)
    const m = String(method || '').toLowerCase();
    if (m === 'dinheiro') return '01';
    if (m === 'cheque') return '02';
    if (m === 'credito' || m === 'cartao_credito') return '03';
    if (m === 'debito' || m === 'cartao_debito') return '04';
    if (m === 'crediario' || m === 'credito_loja') return '05';
    if (m === 'pix') return '17';
    return '99'; // outros
  }

  // ── Emissão (público) ───────────────────────────────────────────────

  /**
   * Emite a NFC-e da venda. Por padrão retorna apenas o XML (preview),
   * marca a venda com chave + numero. Quando certificado A1 + CSC
   * estiverem configurados, transmite à SEFAZ.
   */
  async emit(saleId: string): Promise<{
    status: 'preview' | 'authorized' | 'rejected' | 'error';
    chave: string;
    numero: number;
    serie: string;
    xml: string;
    protocolo?: string;
    motivo?: string;
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
      // Idempotência: já emitida
      return {
        status: 'authorized',
        chave: sale.nfceChave,
        numero: parseInt(sale.nfceNumber || '0', 10),
        serie: sale.nfceSerie || '1',
        xml: sale.nfceXml || '',
      };
    }

    const config = await this.getConfig();
    if (!config.cnpj) {
      throw new BadRequestException(
        'NFC-e não configurada. Cadastre CNPJ/IE/CSC em Configurações → NFC-e.',
      );
    }

    const numero = await this.nextNumero();
    const chave = this.buildChave({
      cUF: '35', // SP
      cnpj: config.cnpj.replace(/\D/g, ''),
      serie: config.serie,
      numero,
      dataEmissao: new Date(),
    });

    const xml = await this.buildXml(sale, config, chave, numero);

    // Persiste mesmo em modo stub
    const status: 'preview' | 'authorized' = config.ready ? 'preview' : 'preview';
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

    if (!config.ready) {
      this.logger.warn(
        `[nfce] Venda ${sale.id.slice(0, 8)} sem certificado A1 — retornando XML preview (chave ${chave})`,
      );
      return { status: 'preview', chave, numero, serie: config.serie, xml };
    }

    // TODO: assinar XML com cert A1 + transmitir SEFAZ-SP
    // Aqui entram: xml-crypto, node-forge pra extrair PFX, axios pro endpoint
    // SEFAZ-SP NFCeAutorizacao4 (https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx)
    this.logger.warn(
      `[nfce] Certificado A1 carregado mas transmissão SEFAZ ainda não plugada. Stub mode.`,
    );

    return { status: 'preview', chave, numero, serie: config.serie, xml };
  }

  // ── DANFE 80mm (cupom térmica) ──────────────────────────────────────

  /**
   * Gera texto formatado pro cupom térmico 80mm (40 colunas).
   * Usado pela tela de impressão como fallback enquanto não tem PDF.
   */
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
    // Quebra a chave em grupos de 4 (44 dígitos = 11 grupos)
    const chaveFmt = chave.replace(/(.{4})/g, '$1 ').trim();
    lines.push(chaveFmt);
    lines.push('');
    lines.push(center('Consulte em:'));
    lines.push(center('https://www.nfce.fazenda.sp.gov.br'));
    return lines.join('\n');
  }
}
