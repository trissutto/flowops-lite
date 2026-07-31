import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DACE — Documento Auxiliar da DC-e (a folha impressa que vai colada no
 * pacote, com o QR que o atendente dos Correios escaneia).
 *
 * Gerada por NÓS a partir do XML autorizado + chave (a SEFAZ devolve só
 * XML/protocolo — o PDF é responsabilidade do emissor, igual à DANFE).
 * pdfkit + qrcode, mesmas libs da DANFE/NFC-e.
 */
@Injectable()
export class DacePdfService {
  constructor(private readonly prisma: PrismaService) {}

  async gerar(dceId: string): Promise<Buffer> {
    const doc = await this.prisma.dceDoc.findUnique({ where: { id: dceId } });
    if (!doc) throw new BadRequestException('DC-e não encontrada');
    if (doc.status !== 'authorized' || !doc.chave) {
      throw new BadRequestException(`DC-e não autorizada (status ${doc.status}${doc.xMotivo ? ` — ${doc.xMotivo}` : ''})`);
    }

    const xml = doc.xmlAutorizado || doc.xmlEnviado || '';
    const tag = (t: string) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '';
    const block = (t: string) => (xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
    const unesc = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

    const rem = block('rem');
    const dest = block('dest');
    const tagIn = (b: string, t: string) => unesc((b.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '');

    const dets: Array<{ xProd: string; qCom: string; vProd: string }> = [];
    const detRe = /<det[^>]*>([\s\S]*?)<\/det>/g;
    let m: RegExpExecArray | null;
    while ((m = detRe.exec(xml))) {
      const b = m[1];
      dets.push({ xProd: tagIn(b, 'xProd'), qCom: tagIn(b, 'qCom'), vProd: tagIn(b, 'vProd') });
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PDFDocument = require('pdfkit');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const QRCode = require('qrcode');

    const qrDataUrl: string = doc.qrCodeUrl
      ? await QRCode.toDataURL(doc.qrCodeUrl, { margin: 1, width: 220 })
      : '';
    const qrPng = qrDataUrl ? Buffer.from(qrDataUrl.split(',')[1], 'base64') : null;

    const pdf = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

    const W = pdf.page.width - 72;

    // Cabeçalho
    pdf.fontSize(14).font('Helvetica-Bold').text('DACE — Documento Auxiliar da Declaração de Conteúdo Eletrônica', { width: W, align: 'center' });
    pdf.moveDown(0.3);
    pdf.fontSize(9).font('Helvetica').text(`DC-e modelo 99 · Série ${doc.serie} · Nº ${doc.numero} · ${doc.tpAmb === '2' ? 'HOMOLOGAÇÃO — SEM VALOR FISCAL' : 'Produção'}`, { width: W, align: 'center' });
    pdf.moveDown(0.6);

    // Chave + protocolo + QR
    const yTop = pdf.y;
    pdf.font('Helvetica-Bold').fontSize(9).text('CHAVE DE ACESSO', 36, yTop);
    pdf.font('Helvetica').fontSize(10).text((doc.chave.match(/.{1,4}/g) || []).join(' '), 36, yTop + 12, { width: W - 240 });
    pdf.font('Helvetica-Bold').fontSize(9).text('PROTOCOLO DE AUTORIZAÇÃO', 36, yTop + 32);
    pdf.font('Helvetica').fontSize(10).text(`${doc.protocolo || '—'}  ${doc.dhRecbto || ''}`, 36, yTop + 44, { width: W - 240 });
    if (qrPng) pdf.image(qrPng, pdf.page.width - 36 - 130, yTop - 4, { width: 130, height: 130 });
    pdf.y = Math.max(yTop + 70, qrPng ? yTop + 140 : yTop + 70);

    const section = (titulo: string, linhas: string[]) => {
      pdf.moveDown(0.4);
      pdf.font('Helvetica-Bold').fontSize(10).text(titulo, 36, pdf.y, { width: W });
      pdf.font('Helvetica').fontSize(9);
      for (const l of linhas.filter(Boolean)) pdf.text(l, { width: W });
    };

    const enderStr = (b: string) => {
      const lg = tagIn(b, 'xLgr'), nro = tagIn(b, 'nro'), bai = tagIn(b, 'xBairro');
      const mun = tagIn(b, 'xMun'), uf = tagIn(b, 'UF'), cep = tagIn(b, 'CEP');
      return `${lg}, ${nro} — ${bai} — ${mun}/${uf} — CEP ${cep}`;
    };

    section('REMETENTE', [
      `${tagIn(rem, 'xNome')}  ·  CNPJ ${tagIn(rem, 'CNPJ')}`,
      enderStr(block('enderRem') || rem),
    ]);
    section('DESTINATÁRIO', [
      `${tagIn(dest, 'xNome')}${tagIn(dest, 'CPF') ? `  ·  CPF ${tagIn(dest, 'CPF')}` : ''}${tagIn(dest, 'CNPJ') ? `  ·  CNPJ ${tagIn(dest, 'CNPJ')}` : ''}`,
      enderStr(block('enderDest') || dest),
    ]);

    // Itens
    pdf.moveDown(0.5);
    pdf.font('Helvetica-Bold').fontSize(10).text('CONTEÚDO DECLARADO', 36, pdf.y, { width: W });
    pdf.moveDown(0.2);
    const colQ = 60, colV = 80;
    const xDesc = 36, xQ = 36 + W - colQ - colV, xV = 36 + W - colV;
    pdf.fontSize(8).font('Helvetica-Bold');
    pdf.text('DESCRIÇÃO', xDesc, pdf.y, { continued: false });
    const yHead = pdf.y - 10;
    pdf.text('QTD', xQ, yHead, { width: colQ, align: 'right' });
    pdf.text('VALOR R$', xV, yHead, { width: colV, align: 'right' });
    pdf.moveTo(36, pdf.y + 2).lineTo(36 + W, pdf.y + 2).stroke();
    pdf.font('Helvetica').fontSize(9);
    for (const d of dets) {
      const y = pdf.y + 4;
      pdf.text(d.xProd, xDesc, y, { width: W - colQ - colV - 8 });
      const yRow = y;
      pdf.text(d.qCom, xQ, yRow, { width: colQ, align: 'right' });
      pdf.text(d.vProd, xV, yRow, { width: colV, align: 'right' });
    }
    pdf.moveDown(0.6);
    pdf.font('Helvetica-Bold').fontSize(10).text(
      `VALOR TOTAL: R$ ${(doc.valorCents / 100).toFixed(2).replace('.', ',')}`,
      36, pdf.y, { width: W, align: 'right' },
    );

    // Observações do XML
    const obs1 = tag('xObs1'), obs2 = tag('xObs2');
    if (obs1 || obs2) section('OBSERVAÇÕES', [unesc(obs1), unesc(obs2)]);

    if (doc.tpAmb === '2') {
      pdf.moveDown(1);
      pdf.font('Helvetica-Bold').fontSize(16).fillColor('#999999')
        .text('SEM VALOR FISCAL — HOMOLOGAÇÃO', 36, pdf.y, { width: W, align: 'center' });
      pdf.fillColor('#000000');
    }

    pdf.end();
    return done;
  }
}
