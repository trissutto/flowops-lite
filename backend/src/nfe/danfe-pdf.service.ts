import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// pdfkit é CommonJS — require() evita problema de interop (mesmo padrão do
// ShipmentPdfService).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/**
 * DanfePdfService — DANFE (Documento Auxiliar da NF-e) em PDF A4 no LAYOUT
 * OFICIAL (Manual de Orientação do Contribuinte): canhoto de recebimento,
 * cabeçalho emitente/DANFE/chave, quadros de cálculo do imposto,
 * transportador/volumes, tabela de produtos e dados adicionais.
 *
 * Fonte = XML que NÓS montamos (NfeDoc.xmlEnviado/xmlAutorizado) — estrutura
 * conhecida, extração por regex. Código de barras da chave = CODE-128C
 * desenhado direto no PDF. Homologação / não-autorizada → tarja diagonal.
 */
@Injectable()
export class DanfePdfService {
  private readonly logger = new Logger(DanfePdfService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generateForDoc(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const doc = await this.prisma.nfeDoc.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('NF-e não encontrada');
    const xml = doc.xmlAutorizado || doc.xmlEnviado;
    if (!xml) throw new NotFoundException('NF-e sem XML gravado (falhou antes de assinar)');
    const buffer = await this.buildPdf(doc, xml);
    return { buffer, filename: `danfe-${doc.numero}.pdf` };
  }

  // ── extração do XML (estrutura nossa, conhecida) ─────────────────────────
  private tag(xml: string, name: string): string {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? this.unesc(m[1]) : '';
  }
  private block(xml: string, name: string): string {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1] : '';
  }
  private unesc(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }
  private fmtCnpj(c: string): string {
    const d = String(c || '').replace(/\D/g, '');
    return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : c;
  }
  private fmtCep(c: string): string {
    const d = String(c || '').replace(/\D/g, '');
    return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : c;
  }
  private fmtFone(c: string): string {
    const d = String(c || '').replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)})${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)})${d.slice(2, 6)}-${d.slice(6)}`;
    return c;
  }
  private money(v: string | number): string {
    return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  private fmtDate(iso: string): string {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }
  private fmtDh(iso: string): string {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : '';
  }

  // ── CODE-128C (só dígitos, pares) ───────────────────────────────────────
  private static readonly C128 = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112',
  ];
  private drawCode128C(doc: any, digits: string, x: number, y: number, width: number, height: number) {
    const codes: number[] = [105];
    for (let i = 0; i < digits.length; i += 2) codes.push(Number(digits.slice(i, i + 2)));
    let check = 105;
    for (let i = 1; i < codes.length; i++) check += codes[i] * i;
    codes.push(check % 103);
    codes.push(106);
    const totalModules = codes.reduce((s, c) => s + DanfePdfService.C128[c].split('').reduce((a, b) => a + Number(b), 0), 0);
    const mod = width / totalModules;
    let cx = x;
    doc.fillColor('#000');
    for (const code of codes) {
      const pattern = DanfePdfService.C128[code];
      for (let i = 0; i < pattern.length; i++) {
        const w = Number(pattern[i]) * mod;
        if (i % 2 === 0) doc.rect(cx, y, w, height).fill();
        cx += w;
      }
    }
  }

  // ── helpers de desenho ───────────────────────────────────────────────────
  /** Célula com borda: rótulo minúsculo em cima + valor embaixo. */
  private cell(doc: any, x: number, y: number, w: number, h: number, label: string, value?: any, o: any = {}) {
    doc.lineWidth(0.5).strokeColor('#000').rect(x, y, w, h).stroke();
    if (label) {
      doc.font('Helvetica').fontSize(4.6).fillColor('#000')
        .text(label, x + 2, y + 1.5, { width: w - 4, lineBreak: false, ellipsis: true });
    }
    if (value != null && value !== '') {
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.fs || 7).fillColor('#000')
        .text(String(value), x + 2, y + (o.vy ?? 8), { width: w - 4, align: o.align || 'left', lineBreak: false, ellipsis: true });
    }
  }
  /** Título de seção (texto bold minúsculo acima de uma faixa de células). */
  private section(doc: any, x: number, y: number, text: string) {
    doc.font('Helvetica-Bold').fontSize(5.5).fillColor('#000').text(text, x, y, { lineBreak: false });
  }

  // ── PDF ──────────────────────────────────────────────────────────────────
  private buildPdf(nfe: any, xml: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const ide = this.block(xml, 'ide');
        const emit = this.block(xml, 'emit');
        const dest = this.block(xml, 'dest');
        const enderE = this.block(emit, 'enderEmit');
        const enderD = this.block(dest, 'enderDest');
        const tot = this.block(xml, 'ICMSTot');
        const infCpl = this.tag(this.block(xml, 'infAdic'), 'infCpl');
        const chave = String(nfe.chave || '').replace(/\D/g, '');
        const homolog = String(nfe.tpAmb) === '2';
        const autorizada = nfe.status === 'authorized';
        const crt3 = false; // transferência da rede é Simples (CRT 1) — statement no rodapé

        // itens
        const dets: Array<any> = [];
        const detRe = /<det nItem="\d+">([\s\S]*?)<\/det>/g;
        let m: RegExpExecArray | null;
        while ((m = detRe.exec(xml))) {
          const p = this.block(m[1], 'prod');
          const icms = this.block(this.block(m[1], 'imposto'), 'ICMS');
          const orig = this.tag(icms, 'orig') || '0';
          const cst = this.tag(icms, 'CSOSN') || this.tag(icms, 'CST') || '';
          dets.push({
            cProd: this.tag(p, 'cProd'),
            xProd: this.tag(p, 'xProd'),
            ncm: this.tag(p, 'NCM'),
            oCst: `${orig}${cst}`,
            cfop: this.tag(p, 'CFOP'),
            uCom: this.tag(p, 'uCom') || 'UN',
            qtd: this.tag(p, 'qCom'),
            vUn: this.tag(p, 'vUnCom'),
            vProd: this.tag(p, 'vProd'),
            vBC: this.tag(icms, 'vBC') || '0.00',
            vICMS: this.tag(icms, 'vICMS') || '0.00',
            pICMS: this.tag(icms, 'pICMS') || '0.00',
          });
        }

        const M = 20;
        const doc = new (PDFDocument as any)({
          size: 'A4', margin: M,
          info: { Title: `DANFE ${nfe.numero}`, Author: "Lurd's Plus Size" },
        });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const W = doc.page.width;      // 595.28
        const IW = W - M * 2;          // 555.28
        const R = M + IW;              // right edge
        const nNF = String(nfe.numero).padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3');
        const serie = String(nfe.serie).padStart(3, '0');
        const emitNome = this.tag(emit, 'xNome');
        const enderTxtE =
          `${this.tag(enderE, 'xLgr')}, ${this.tag(enderE, 'nro')}` +
          `${this.tag(enderE, 'xCpl') ? ' ' + this.tag(enderE, 'xCpl') : ''} - ${this.tag(enderE, 'xBairro')}`;
        const cidadeE = `CEP: ${this.fmtCep(this.tag(enderE, 'CEP'))} - ${this.tag(enderE, 'xMun')}/${this.tag(enderE, 'UF')}`;

        let y = M;

        // ── CANHOTO ──────────────────────────────────────────────────────
        const canhH = 34;
        const nfBoxW = 78;
        const canhW = IW - nfBoxW;
        // topo: recebemos
        doc.lineWidth(0.5).strokeColor('#000').rect(M, y, canhW, 16).stroke();
        doc.font('Helvetica').fontSize(5).fillColor('#000').text(
          `RECEBEMOS DE ${emitNome} OS PRODUTOS / SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO`,
          M + 2, y + 1.5, { width: canhW - 4, lineBreak: true },
        );
        doc.font('Helvetica-Bold').fontSize(5.5).text(
          `EMISSÃO: ${this.fmtDate(this.tag(ide, 'dhEmi'))}   ·   DEST. / REM.: ${this.tag(dest, 'xNome')}   ·   VALOR TOTAL: R$ ${this.money(this.tag(tot, 'vNF'))}`,
          M + 2, y + 9.5, { width: canhW - 4, lineBreak: false, ellipsis: true },
        );
        // baixo: data recebimento | assinatura
        this.cell(doc, M, y + 16, 92, canhH - 16, 'DATA DE RECEBIMENTO');
        this.cell(doc, M + 92, y + 16, canhW - 92, canhH - 16, 'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR');
        // caixa NF-e à direita
        doc.lineWidth(0.5).rect(M + canhW, y, nfBoxW, canhH).stroke();
        doc.font('Helvetica-Bold').fontSize(11).text('NF-e', M + canhW, y + 3, { width: nfBoxW, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(7).text(`Nº ${nNF}`, M + canhW, y + 17, { width: nfBoxW, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(7).text(`SÉRIE ${serie}`, M + canhW, y + 25, { width: nfBoxW, align: 'center' });

        y += canhH + 3;
        // linha tracejada
        doc.dash(2, { space: 2 }).moveTo(M, y - 1.5).lineTo(R, y - 1.5).lineWidth(0.4).stroke();
        doc.undash();

        // ── CABEÇALHO: emitente | DANFE | chave ──────────────────────────
        const headH = 88;
        const cEmitW = IW * 0.42;
        const cDanfeW = IW * 0.20;
        const cChaveW = IW - cEmitW - cDanfeW;
        const cx1 = M, cx2 = M + cEmitW, cx3 = M + cEmitW + cDanfeW;
        doc.lineWidth(0.5).rect(cx1, y, cEmitW, headH).stroke();
        doc.rect(cx2, y, cDanfeW, headH).stroke();
        doc.rect(cx3, y, cChaveW, headH).stroke();

        // emitente
        doc.font('Helvetica').fontSize(4.6).text('IDENTIFICAÇÃO DO EMITENTE', cx1 + 3, y + 2);
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
          .text(emitNome, cx1 + 3, y + 16, { width: cEmitW - 6, align: 'center' });
        doc.font('Helvetica').fontSize(7).fillColor('#000')
          .text(enderTxtE, cx1 + 3, y + 40, { width: cEmitW - 6, align: 'center' })
          .text(cidadeE, cx1 + 3, doc.y + 1, { width: cEmitW - 6, align: 'center' })
          .text(
            `CNPJ: ${this.fmtCnpj(this.tag(emit, 'CNPJ'))}` +
            (this.tag(enderE, 'fone') ? `   ·   TEL: ${this.fmtFone(this.tag(enderE, 'fone'))}` : ''),
            cx1 + 3, doc.y + 1, { width: cEmitW - 6, align: 'center' },
          );

        // DANFE (centro)
        doc.font('Helvetica-Bold').fontSize(12).text('DANFE', cx2, y + 4, { width: cDanfeW, align: 'center' });
        doc.font('Helvetica').fontSize(5).text('DOCUMENTO AUXILIAR DA', cx2 + 2, y + 19, { width: cDanfeW - 4, align: 'center' });
        doc.text('NOTA FISCAL ELETRÔNICA', cx2 + 2, y + 25, { width: cDanfeW - 4, align: 'center' });
        // 0-entrada/1-saída + box
        doc.font('Helvetica').fontSize(6).text('0 - ENTRADA', cx2 + 4, y + 36, { lineBreak: false });
        doc.text('1 - SAÍDA', cx2 + 4, y + 44, { lineBreak: false });
        doc.lineWidth(0.5).rect(cx2 + cDanfeW - 20, y + 36, 15, 15).stroke();
        doc.font('Helvetica-Bold').fontSize(10).text(this.tag(ide, 'tpNF') || '1', cx2 + cDanfeW - 20, y + 38, { width: 15, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(7).text(`Nº ${nNF}`, cx2 + 2, y + 56, { width: cDanfeW - 4, align: 'center' });
        doc.text(`SÉRIE ${serie}`, cx2 + 2, y + 65, { width: cDanfeW - 4, align: 'center' });
        doc.font('Helvetica').fontSize(6).text('FOLHA 1/1', cx2 + 2, y + 74, { width: cDanfeW - 4, align: 'center' });

        // chave + barcode
        if (chave.length === 44) this.drawCode128C(doc, chave, cx3 + 8, y + 6, cChaveW - 16, 28);
        doc.font('Helvetica').fontSize(4.6).fillColor('#000').text('CHAVE DE ACESSO', cx3 + 4, y + 38);
        doc.font('Helvetica-Bold').fontSize(7.6).text(chave.replace(/(\d{4})/g, '$1 ').trim(), cx3 + 4, y + 46, { width: cChaveW - 8 });
        doc.font('Helvetica').fontSize(5.6).text(
          'Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora',
          cx3 + 4, y + 64, { width: cChaveW - 8, align: 'center' },
        );

        y += headH;

        // ── natOp | protocolo ────────────────────────────────────────────
        const natW = IW * 0.62;
        this.cell(doc, M, y, natW, 22, 'NATUREZA DA OPERAÇÃO', `${this.tag(ide, 'natOp')}   ·   CFOP ${nfe.cfop}`, { bold: true, fs: 8 });
        this.cell(doc, M + natW, y, IW - natW, 22, 'PROTOCOLO DE AUTORIZAÇÃO DE USO',
          autorizada ? `${nfe.protocolo || ''} ${this.fmtDh(nfe.dhRecbto || '')}` : '', { fs: 7 });
        y += 22;

        // ── IE | IE ST | CNPJ (emitente) ─────────────────────────────────
        this.cell(doc, M, y, IW * 0.40, 22, 'INSCRIÇÃO ESTADUAL', this.tag(emit, 'IE'), { fs: 7 });
        this.cell(doc, M + IW * 0.40, y, IW * 0.32, 22, 'INSCR. ESTADUAL DO SUBST. TRIB.', '');
        this.cell(doc, M + IW * 0.72, y, IW * 0.28, 22, 'CNPJ / CPF', this.fmtCnpj(this.tag(emit, 'CNPJ')), { fs: 7 });
        y += 22;

        // ── DESTINATÁRIO / REMETENTE ─────────────────────────────────────
        this.section(doc, M, y, 'DESTINATÁRIO / REMETENTE');
        y += 7;
        const rowH = 20;
        // linha A
        this.cell(doc, M, y, IW * 0.60, rowH, 'NOME / RAZÃO SOCIAL', this.tag(dest, 'xNome'), { bold: true, fs: 8 });
        this.cell(doc, M + IW * 0.60, y, IW * 0.25, rowH, 'CNPJ / CPF', this.fmtCnpj(this.tag(dest, 'CNPJ')), { fs: 7 });
        this.cell(doc, M + IW * 0.85, y, IW * 0.15, rowH, 'DATA DA EMISSÃO', this.fmtDate(this.tag(ide, 'dhEmi')), { fs: 7 });
        y += rowH;
        // linha B
        this.cell(doc, M, y, IW * 0.48, rowH, 'ENDEREÇO',
          `${this.tag(enderD, 'xLgr')}, ${this.tag(enderD, 'nro')}`, { fs: 7 });
        this.cell(doc, M + IW * 0.48, y, IW * 0.22, rowH, 'BAIRRO / DISTRITO', this.tag(enderD, 'xBairro'), { fs: 7 });
        this.cell(doc, M + IW * 0.70, y, IW * 0.15, rowH, 'CEP', this.fmtCep(this.tag(enderD, 'CEP')), { fs: 7 });
        this.cell(doc, M + IW * 0.85, y, IW * 0.15, rowH, 'DATA SAÍDA / ENTRADA', this.fmtDate(this.tag(ide, 'dhSaiEnt') || this.tag(ide, 'dhEmi')), { fs: 7 });
        y += rowH;
        // linha C
        this.cell(doc, M, y, IW * 0.35, rowH, 'MUNICÍPIO', this.tag(enderD, 'xMun'), { fs: 7 });
        this.cell(doc, M + IW * 0.35, y, IW * 0.18, rowH, 'FONE / FAX', this.tag(enderD, 'fone') ? this.fmtFone(this.tag(enderD, 'fone')) : '', { fs: 7 });
        this.cell(doc, M + IW * 0.53, y, IW * 0.07, rowH, 'UF', this.tag(enderD, 'UF'), { fs: 7, align: 'center' });
        this.cell(doc, M + IW * 0.60, y, IW * 0.25, rowH, 'INSCRIÇÃO ESTADUAL', this.tag(dest, 'IE'), { fs: 7 });
        this.cell(doc, M + IW * 0.85, y, IW * 0.15, rowH, 'HORA DA SAÍDA', '');
        y += rowH;

        // ── CÁLCULO DO IMPOSTO ───────────────────────────────────────────
        this.section(doc, M, y, 'CÁLCULO DO IMPOSTO');
        y += 7;
        const w5 = IW / 5;
        this.cell(doc, M + w5 * 0, y, w5, rowH, 'BASE DE CÁLCULO DO ICMS', this.money(this.tag(tot, 'vBC')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w5 * 1, y, w5, rowH, 'VALOR DO ICMS', this.money(this.tag(tot, 'vICMS')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w5 * 2, y, w5, rowH, 'BASE CÁLC. ICMS SUBST.', this.money(this.tag(tot, 'vBCST')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w5 * 3, y, w5, rowH, 'VALOR DO ICMS SUBST.', this.money(this.tag(tot, 'vST')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w5 * 4, y, w5, rowH, 'VALOR TOTAL DOS PRODUTOS', this.money(this.tag(tot, 'vProd')), { fs: 7, align: 'right', vy: 10, bold: true });
        y += rowH;
        const w6 = IW / 6;
        this.cell(doc, M + w6 * 0, y, w6, rowH, 'VALOR DO FRETE', this.money(this.tag(tot, 'vFrete')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w6 * 1, y, w6, rowH, 'VALOR DO SEGURO', this.money(this.tag(tot, 'vSeg')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w6 * 2, y, w6, rowH, 'DESCONTO', this.money(this.tag(tot, 'vDesc')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w6 * 3, y, w6, rowH, 'OUTRAS DESP. ACESS.', this.money(this.tag(tot, 'vOutro')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w6 * 4, y, w6, rowH, 'VALOR DO IPI', this.money(this.tag(tot, 'vIPI')), { fs: 7, align: 'right', vy: 10 });
        this.cell(doc, M + w6 * 5, y, w6, rowH, 'VALOR TOTAL DA NOTA', this.money(this.tag(tot, 'vNF')), { fs: 8, align: 'right', vy: 10, bold: true });
        y += rowH;

        // ── TRANSPORTADOR / VOLUMES ──────────────────────────────────────
        this.section(doc, M, y, 'TRANSPORTADOR / VOLUMES TRANSPORTADOS');
        y += 7;
        // linha A
        this.cell(doc, M, y, IW * 0.34, rowH, 'RAZÃO SOCIAL', '');
        this.cell(doc, M + IW * 0.34, y, IW * 0.14, rowH, 'FRETE POR CONTA', '9 - SEM FRETE', { fs: 6.5 });
        this.cell(doc, M + IW * 0.48, y, IW * 0.13, rowH, 'CÓDIGO ANTT', '');
        this.cell(doc, M + IW * 0.61, y, IW * 0.13, rowH, 'PLACA DO VEÍCULO', '');
        this.cell(doc, M + IW * 0.74, y, IW * 0.06, rowH, 'UF', '');
        this.cell(doc, M + IW * 0.80, y, IW * 0.20, rowH, 'CNPJ / CPF', '');
        y += rowH;
        // linha B
        this.cell(doc, M, y, IW * 0.48, rowH, 'ENDEREÇO', '');
        this.cell(doc, M + IW * 0.48, y, IW * 0.26, rowH, 'MUNICÍPIO', '');
        this.cell(doc, M + IW * 0.74, y, IW * 0.06, rowH, 'UF', '');
        this.cell(doc, M + IW * 0.80, y, IW * 0.20, rowH, 'INSCRIÇÃO ESTADUAL', '');
        y += rowH;
        // volumes
        const totalPecas = dets.reduce((s, it) => s + Number(it.qtd || 0), 0);
        this.cell(doc, M, y, IW * 0.14, rowH, 'QUANTIDADE', String(totalPecas), { fs: 7 });
        this.cell(doc, M + IW * 0.14, y, IW * 0.24, rowH, 'ESPÉCIE', 'VOLUME(S)', { fs: 7 });
        this.cell(doc, M + IW * 0.38, y, IW * 0.20, rowH, 'MARCA', '');
        this.cell(doc, M + IW * 0.58, y, IW * 0.20, rowH, 'NUMERAÇÃO', '');
        this.cell(doc, M + IW * 0.78, y, IW * 0.11, rowH, 'PESO BRUTO', '');
        this.cell(doc, M + IW * 0.89, y, IW * 0.11, rowH, 'PESO LÍQUIDO', '');
        y += rowH;

        // ── DADOS DO PRODUTO / SERVIÇOS ──────────────────────────────────
        this.section(doc, M, y, 'DADOS DO PRODUTO / SERVIÇOS');
        y += 7;
        // colunas (soma = IW)
        const cw = [50, 124, 35, 26, 26, 20, 30, 36, 38, 28, 34, 30, 28, 26, 24];
        const clbl = ['CÓDIGO', 'DESCRIÇÃO DO PRODUTO / SERVIÇO', 'NCM/SH', 'O/CST', 'CFOP', 'UN', 'QUANT', 'VALOR\nUNIT', 'VALOR\nTOTAL', 'DESC', 'B.CÁLC\nICMS', 'VALOR\nICMS', 'VALOR\nIPI', 'AL.\nICMS', 'AL.\nIPI'];
        const calign = ['left', 'left', 'center', 'center', 'center', 'center', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'];
        const cx = (i: number) => M + cw.slice(0, i).reduce((a, b) => a + b, 0);
        const headTH = 15;
        const drawHead = (yy: number) => {
          doc.lineWidth(0.5).rect(M, yy, IW, headTH).stroke();
          doc.fillColor('#000').font('Helvetica-Bold').fontSize(4.6);
          for (let i = 0; i < cw.length; i++) {
            if (i > 0) doc.moveTo(cx(i), yy).lineTo(cx(i), yy + headTH).stroke();
            doc.text(clbl[i], cx(i) + 1, yy + 2, { width: cw[i] - 2, align: 'center' as any, lineBreak: true });
          }
          return yy + headTH;
        };
        y = drawHead(y);

        const bottomLimit = doc.page.height - 120;
        for (const it of dets) {
          doc.font('Helvetica').fontSize(5.5);
          const descH = doc.heightOfString(it.xProd, { width: cw[1] - 4 });
          const rH = Math.max(11, descH + 3);
          if (y + rH > bottomLimit) {
            doc.addPage();
            y = M;
            y = drawHead(y);
            doc.font('Helvetica').fontSize(5.5);
          }
          const vals = [
            it.cProd, it.xProd, it.ncm, it.oCst, it.cfop, it.uCom,
            Number(it.qtd).toLocaleString('pt-BR'),
            this.money(it.vUn), this.money(it.vProd),
            '0,00', this.money(it.vBC), this.money(it.vICMS), '0,00',
            Number(it.pICMS).toFixed(2).replace('.', ','), '0,00',
          ];
          // bordas verticais + valores
          doc.lineWidth(0.4).strokeColor('#ccc');
          for (let i = 0; i < cw.length; i++) {
            if (i > 0) doc.moveTo(cx(i), y).lineTo(cx(i), y + rH).lineWidth(0.4).strokeColor('#ccc').stroke();
            // código (EAN-13) em fonte menor pra não quebrar; descrição quebra em linhas
            doc.fillColor('#000').font('Helvetica').fontSize(i === 0 ? 4.8 : 5.5)
              .text(String(vals[i]), cx(i) + 1.5, y + 1.5, {
                width: cw[i] - 3, align: calign[i] as any, lineBreak: i === 1, ellipsis: i !== 1,
              });
          }
          // borda externa da linha
          doc.lineWidth(0.5).strokeColor('#000').moveTo(M, y + rH).lineTo(R, y + rH).stroke();
          doc.moveTo(M, y).lineTo(M, y + rH).stroke();
          doc.moveTo(R, y).lineTo(R, y + rH).stroke();
          y += rH;
        }

        // ── DADOS ADICIONAIS ─────────────────────────────────────────────
        y += 4;
        this.section(doc, M, y, 'DADOS ADICIONAIS');
        y += 7;
        const infoW = IW * 0.64;
        const boxH = Math.max(46, doc.page.height - 40 - y);
        doc.lineWidth(0.5).rect(M, y, infoW, boxH).stroke();
        doc.rect(M + infoW, y, IW - infoW, boxH).stroke();
        doc.font('Helvetica').fontSize(4.6).fillColor('#000').text('INFORMAÇÕES COMPLEMENTARES', M + 3, y + 2);
        doc.text('RESERVADO AO FISCO', M + infoW + 3, y + 2);
        const infoFull = [
          infCpl,
          'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL NAO GERA DIREITO A CREDITO FISCAL DE IPI.',
          crt3 ? '' : 'NAO GERA DIREITO A CREDITO FISCAL DE ICMS.',
        ].filter(Boolean).join('  ');
        doc.font('Helvetica').fontSize(6.5).fillColor('#000').text(infoFull, M + 3, y + 10, { width: infoW - 6 });

        // rodapé
        doc.font('Helvetica').fontSize(5).fillColor('#666').text(
          `${dets.length} item(ns) · Desenvolvido por LURDS ORDER ONE · gerado em ${new Date().toLocaleString('pt-BR')}`,
          M, doc.page.height - 30, { width: IW, align: 'center' },
        );

        // tarjas
        if (homolog || !autorizada) {
          doc.save();
          doc.rotate(-32, { origin: [W / 2, doc.page.height / 2] });
          doc.font('Helvetica-Bold').fontSize(34).fillColor('#cc0000').opacity(0.16);
          doc.text(
            homolog ? 'HOMOLOGACAO - SEM VALOR FISCAL' : 'NAO AUTORIZADA - SEM VALOR FISCAL',
            0, doc.page.height / 2 - 30, { width: W, align: 'center' },
          );
          doc.opacity(1).restore();
        }

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }
}
