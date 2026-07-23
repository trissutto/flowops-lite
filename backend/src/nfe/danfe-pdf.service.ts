import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// pdfkit é CommonJS — require() evita problema de interop (mesmo padrão do
// ShipmentPdfService).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/**
 * DanfePdfService — DANFE (Documento Auxiliar da NF-e) em PDF A4.
 *
 * Gerado a partir do XML que NÓS mesmos montamos (NfeDoc.xmlEnviado) — o
 * layout de tags é conhecido, então a extração é por regex simples, sem
 * parser XML. Nota não-autorizada sai com tarja "SEM VALOR FISCAL" (serve
 * pra conferência); homologação idem.
 *
 * Código de barras da chave: CODE-128C desenhado direto no PDF (sem lib).
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
  private fmtMoney(v: string | number): string {
    return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  private fmtDh(iso: string): string {
    if (!iso) return '—';
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : iso;
  }
  private enderTexto(bloco: string): string {
    const p = [
      this.tag(bloco, 'xLgr'),
      this.tag(bloco, 'nro'),
      this.tag(bloco, 'xCpl'),
      this.tag(bloco, 'xBairro'),
    ].filter(Boolean).join(', ');
    const cep = this.tag(bloco, 'CEP');
    const cepFmt = cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;
    return `${p} — ${this.tag(bloco, 'xMun')}/${this.tag(bloco, 'UF')} · CEP ${cepFmt}`;
  }

  // ── CODE-128C (só dígitos, pares) ───────────────────────────────────────
  // Tabela oficial de larguras (11 módulos por símbolo; STOP tem 13).
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

  /** Desenha CODE-128C de uma string numérica de tamanho par. */
  private drawCode128C(doc: any, digits: string, x: number, y: number, width: number, height: number) {
    const codes: number[] = [105]; // Start C
    for (let i = 0; i < digits.length; i += 2) codes.push(Number(digits.slice(i, i + 2)));
    let check = 105;
    for (let i = 1; i < codes.length; i++) check += codes[i] * i;
    codes.push(check % 103);
    codes.push(106); // Stop

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

  // ── PDF ──────────────────────────────────────────────────────────────────
  private buildPdf(nfe: any, xml: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const ide = this.block(xml, 'ide');
        const emit = this.block(xml, 'emit');
        const dest = this.block(xml, 'dest');
        const tot = this.block(xml, 'ICMSTot');
        const infCpl = this.tag(this.block(xml, 'infAdic'), 'infCpl');
        const chave = String(nfe.chave || '').replace(/\D/g, '');
        const homolog = String(nfe.tpAmb) === '2';
        const autorizada = nfe.status === 'authorized';

        const dets: Array<{ cProd: string; xProd: string; ncm: string; cfop: string; qtd: string; vUn: string; vTot: string }> = [];
        const detRe = /<det nItem="\d+">([\s\S]*?)<\/det>/g;
        let m: RegExpExecArray | null;
        while ((m = detRe.exec(xml))) {
          const p = this.block(m[1], 'prod');
          dets.push({
            cProd: this.tag(p, 'cProd'),
            xProd: this.tag(p, 'xProd'),
            ncm: this.tag(p, 'NCM'),
            cfop: this.tag(p, 'CFOP'),
            qtd: this.tag(p, 'qCom'),
            vUn: this.tag(p, 'vUnCom'),
            vTot: this.tag(p, 'vProd'),
          });
        }

        const doc = new (PDFDocument as any)({
          size: 'A4', margin: 28,
          info: { Title: `DANFE ${nfe.numero}`, Author: "Lurd's Plus Size" },
        });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const W = doc.page.width;
        const L = 28; // margem
        const CW = W - L * 2; // largura útil

        // ── Cabeçalho: emitente | DANFE | chave/barcode ─────────────
        const headH = 92;
        doc.lineWidth(0.8).strokeColor('#000');
        doc.rect(L, L, CW, headH).stroke();
        const col1W = CW * 0.42, col2W = CW * 0.16, col3W = CW - col1W - col2W;
        doc.moveTo(L + col1W, L).lineTo(L + col1W, L + headH).stroke();
        doc.moveTo(L + col1W + col2W, L).lineTo(L + col1W + col2W, L + headH).stroke();

        // emitente
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
          .text(this.tag(emit, 'xNome'), L + 6, L + 8, { width: col1W - 12 });
        doc.font('Helvetica').fontSize(7).fillColor('#333')
          .text(this.enderTexto(this.block(emit, 'enderEmit')), L + 6, doc.y + 2, { width: col1W - 12 })
          .text(`CNPJ ${this.fmtCnpj(this.tag(emit, 'CNPJ'))} · IE ${this.tag(emit, 'IE')}`, L + 6, doc.y + 2, { width: col1W - 12 });

        // DANFE
        const c2x = L + col1W;
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#000')
          .text('DANFE', c2x, L + 8, { width: col2W, align: 'center' });
        doc.font('Helvetica').fontSize(5.5)
          .text('Documento Auxiliar da Nota Fiscal Eletrônica', c2x + 4, doc.y + 1, { width: col2W - 8, align: 'center' });
        doc.font('Helvetica').fontSize(7)
          .text('0 - ENTRADA   1 - SAÍDA', c2x + 4, doc.y + 4, { width: col2W - 8, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(10)
          .text(`[ ${this.tag(ide, 'tpNF') || '1'} ]`, c2x, doc.y + 1, { width: col2W, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(8)
          .text(`Nº ${String(nfe.numero).padStart(9, '0')}`, c2x, doc.y + 3, { width: col2W, align: 'center' })
          .text(`SÉRIE ${nfe.serie} · FOLHA 1/1`, c2x, doc.y + 1, { width: col2W, align: 'center' });

        // chave + barcode
        const c3x = L + col1W + col2W;
        if (chave.length === 44) {
          this.drawCode128C(doc, chave, c3x + 10, L + 8, col3W - 20, 34);
        }
        doc.font('Helvetica').fontSize(6).fillColor('#333')
          .text('CHAVE DE ACESSO', c3x + 6, L + 48, { width: col3W - 12 });
        doc.font('Helvetica-Bold').fontSize(7.4)
          .text(chave.replace(/(\d{4})/g, '$1 ').trim(), c3x + 6, doc.y + 1, { width: col3W - 12 });
        doc.font('Helvetica').fontSize(6.5).fillColor('#333')
          .text(
            autorizada
              ? `PROTOCOLO: ${nfe.protocolo || '—'} · ${this.fmtDh(nfe.dhRecbto || '')}`
              : `SITUAÇÃO: ${String(nfe.status || '').toUpperCase()}${nfe.cStat ? ` (cStat ${nfe.cStat})` : ''}`,
            c3x + 6, doc.y + 3, { width: col3W - 12 },
          );

        let y = L + headH + 6;

        // ── natOp ───────────────────────────────────────────────────
        doc.rect(L, y, CW, 26).stroke();
        doc.font('Helvetica').fontSize(6).fillColor('#333').text('NATUREZA DA OPERAÇÃO', L + 6, y + 4);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
          .text(`${this.tag(ide, 'natOp')}   ·   CFOP ${nfe.cfop}`, L + 6, y + 13);
        y += 32;

        // ── destinatário ───────────────────────────────────────────
        doc.rect(L, y, CW, 44).stroke();
        doc.font('Helvetica').fontSize(6).fillColor('#333').text('DESTINATÁRIO / REMETENTE', L + 6, y + 4);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
          .text(this.tag(dest, 'xNome'), L + 6, y + 13, { width: CW - 12 });
        doc.font('Helvetica').fontSize(7.5).fillColor('#333')
          .text(this.enderTexto(this.block(dest, 'enderDest')), L + 6, doc.y + 2, { width: CW - 12 })
          .text(`CNPJ ${this.fmtCnpj(this.tag(dest, 'CNPJ'))} · IE ${this.tag(dest, 'IE')} · Emissão: ${this.fmtDh(this.tag(ide, 'dhEmi'))}`, L + 6, doc.y + 2, { width: CW - 12 });
        y += 50;

        // ── itens ──────────────────────────────────────────────────
        const cols = [
          { label: 'CÓDIGO',    x: L,        w: 78  },
          { label: 'DESCRIÇÃO', x: L + 78,   w: CW - 78 - 52 - 40 - 46 - 62 - 68 },
          { label: 'NCM',       x: L + CW - 52 - 40 - 46 - 62 - 68, w: 52 },
          { label: 'CFOP',      x: L + CW - 40 - 46 - 62 - 68,      w: 40 },
          { label: 'QTD',       x: L + CW - 46 - 62 - 68,           w: 46 },
          { label: 'V. UNIT',   x: L + CW - 62 - 68,                w: 62 },
          { label: 'V. TOTAL',  x: L + CW - 68,                     w: 68 },
        ];
        const drawItemHeader = (yy: number) => {
          doc.rect(L, yy, CW, 14).fillAndStroke('#eee', '#000');
          doc.fillColor('#000').font('Helvetica-Bold').fontSize(6.5);
          for (const c of cols) doc.text(c.label, c.x + 3, yy + 4, { width: c.w - 6, lineBreak: false });
          return yy + 14;
        };
        y = drawItemHeader(y);

        doc.font('Helvetica').fontSize(7);
        for (const it of dets) {
          const descH = doc.heightOfString(it.xProd, { width: cols[1].w - 6 });
          const rowH = Math.max(12, descH + 4);
          if (y + rowH > doc.page.height - 120) {
            doc.addPage();
            y = drawItemHeader(L);
            doc.font('Helvetica').fontSize(7);
          }
          doc.fillColor('#000');
          doc.text(it.cProd, cols[0].x + 3, y + 2, { width: cols[0].w - 6, lineBreak: false });
          doc.text(it.xProd, cols[1].x + 3, y + 2, { width: cols[1].w - 6 });
          doc.text(it.ncm, cols[2].x + 3, y + 2, { width: cols[2].w - 6, lineBreak: false });
          doc.text(it.cfop, cols[3].x + 3, y + 2, { width: cols[3].w - 6, lineBreak: false });
          doc.text(Number(it.qtd).toFixed(0), cols[4].x + 3, y + 2, { width: cols[4].w - 6, align: 'right', lineBreak: false });
          doc.text(this.fmtMoney(it.vUn), cols[5].x + 3, y + 2, { width: cols[5].w - 6, align: 'right', lineBreak: false });
          doc.text(this.fmtMoney(it.vTot), cols[6].x + 3, y + 2, { width: cols[6].w - 6, align: 'right', lineBreak: false });
          doc.moveTo(L, y + rowH).lineTo(L + CW, y + rowH).lineWidth(0.3).strokeColor('#bbb').stroke();
          doc.lineWidth(0.8).strokeColor('#000');
          y += rowH;
        }

        // ── totais ─────────────────────────────────────────────────
        y += 6;
        doc.rect(L, y, CW, 24).stroke();
        doc.font('Helvetica').fontSize(6).fillColor('#333').text('CÁLCULO DO IMPOSTO', L + 6, y + 3);
        doc.font('Helvetica').fontSize(8).fillColor('#000').text(
          `BC ICMS: ${this.fmtMoney(this.tag(tot, 'vBC'))} · ICMS: ${this.fmtMoney(this.tag(tot, 'vICMS'))} · Produtos: ${this.fmtMoney(this.tag(tot, 'vProd'))}`,
          L + 6, y + 12,
        );
        doc.font('Helvetica-Bold').fontSize(10)
          .text(`TOTAL DA NOTA: R$ ${this.fmtMoney(this.tag(tot, 'vNF'))}`, L, y + 8, { width: CW - 8, align: 'right' });
        y += 30;

        // ── dados adicionais ───────────────────────────────────────
        doc.rect(L, y, CW, 30).stroke();
        doc.font('Helvetica').fontSize(6).fillColor('#333').text('DADOS ADICIONAIS', L + 6, y + 3);
        doc.font('Helvetica').fontSize(7.5).fillColor('#000')
          .text(infCpl || '—', L + 6, y + 12, { width: CW - 12 });
        y += 36;

        doc.font('Helvetica').fontSize(6.5).fillColor('#999')
          .text(`${dets.length} item(ns) · Gerado pelo LURDS ORDER ONE em ${new Date().toLocaleString('pt-BR')}`, L, y, { width: CW, align: 'center' });

        // ── tarjas ─────────────────────────────────────────────────
        if (homolog || !autorizada) {
          doc.save();
          doc.rotate(-30, { origin: [W / 2, doc.page.height / 2] });
          doc.font('Helvetica-Bold').fontSize(38).fillColor('#cc0000').opacity(0.18);
          doc.text(
            homolog ? 'HOMOLOGAÇÃO — SEM VALOR FISCAL' : 'NÃO AUTORIZADA — SEM VALOR FISCAL',
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
