import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as PDFDocument from 'pdfkit';

/**
 * FechamentoPdfService — gera PDF do comprovante mensal por filial.
 *
 * Layout (1 página por filial):
 *   - Cabeçalho: Lurd's Plus Size · Comprovante de Fechamento Mensal · MM/AAAA
 *   - Bloco filial: nome, código, mês
 *   - Bloco resumo: venda bruta, royalties, marketing, obrigações a pagar/receber, saldo
 *   - Tabela detalhada de obrigações (REF, cor, tamanho, qty, preço, ÷2.5)
 *   - Footer: data de emissão + ID do fechamento
 *
 * Stream-based pra não estourar memória.
 */
@Injectable()
export class FechamentoPdfService {
  private readonly logger = new Logger(FechamentoPdfService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gera PDF de UMA filial específica pra UM mês.
   * Retorna Buffer com o PDF pronto pra envio.
   */
  async generateForFilial(mesReferencia: string, filialCode: string): Promise<{ buffer: Buffer; filename: string }> {
    if (!/^\d{4}-\d{2}$/.test(mesReferencia)) {
      throw new Error('mesReferencia inválido (formato YYYY-MM)');
    }

    // Carrega fechamento (snapshot)
    const closure = await (this.prisma as any).monthlyClosure.findUnique({
      where: { mesReferencia },
    });
    if (!closure) {
      throw new NotFoundException(`Mês ${mesReferencia} não foi fechado ainda`);
    }

    const detalhe = closure.detalhePorFilial ? JSON.parse(closure.detalhePorFilial) : [];
    const filial = detalhe.find((f: any) => f.storeCode === filialCode);
    if (!filial) {
      throw new NotFoundException(`Filial ${filialCode} não consta no fechamento de ${mesReferencia}`);
    }

    // Carrega obrigações detalhadas dessa filial nesse mês
    // (aqui pega tanto as que ela paga — toStoreCode — quanto as que recebe — fromStoreCode)
    const obligations = await (this.prisma as any).interStoreObligation.findMany({
      where: {
        mesReferencia,
        OR: [{ toStoreCode: filialCode }, { fromStoreCode: filialCode }],
      },
      orderBy: [{ fromStoreCode: 'asc' }, { toStoreCode: 'asc' }, { refCode: 'asc' }],
    });

    const buffer = await this.buildPdf(closure, filial, obligations);
    const filename = `comprovante-${mesReferencia}-${filialCode}.pdf`;

    return { buffer, filename };
  }

  /**
   * Constrói o PDF em si (stream → Buffer).
   */
  private buildPdf(closure: any, filial: any, obligations: any[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new (PDFDocument as any)({
          size: 'A4',
          margin: 40,
          info: {
            Title: `Comprovante ${closure.mesReferencia} ${filial.storeCode}`,
            Author: "Lurd's Plus Size",
            Subject: `Fechamento mensal ${filial.storeName}`,
          },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // ── CABEÇALHO ────────────────────────────────────────────
        doc
          .fontSize(18)
          .fillColor('#5e3823')
          .font('Helvetica-Bold')
          .text("LURD'S PLUS SIZE", { align: 'center' });
        doc.moveDown(0.2);
        doc
          .fontSize(11)
          .fillColor('#666')
          .font('Helvetica')
          .text('Comprovante de Fechamento Mensal', { align: 'center' });

        doc.moveDown(0.3);
        const [year, month] = closure.mesReferencia.split('-');
        const mesLabel = `${month}/${year}`;
        doc
          .fontSize(14)
          .fillColor('#985d3f')
          .font('Helvetica-Bold')
          .text(`Mês de referência: ${mesLabel}`, { align: 'center' });

        // Linha divisória
        doc.moveDown(0.5);
        doc.strokeColor('#c87f5e').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.8);

        // ── DADOS DA FILIAL ──────────────────────────────────────
        doc.fontSize(10).fillColor('#000').font('Helvetica');
        doc.text(`Filial: `, { continued: true }).font('Helvetica-Bold').text(`${filial.storeCode} — ${filial.storeName}`);
        doc.font('Helvetica').text(`Emitido em: `, { continued: true }).font('Helvetica-Bold').text(new Date().toLocaleString('pt-BR'));
        doc.font('Helvetica').text(`Fechado em: `, { continued: true }).font('Helvetica-Bold').text(new Date(closure.closedAt).toLocaleString('pt-BR'));

        doc.moveDown(0.8);

        // ── RESUMO FINANCEIRO ────────────────────────────────────
        const fmt = (n: number) =>
          `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        doc
          .fontSize(12)
          .font('Helvetica-Bold')
          .fillColor('#5e3823')
          .text('Resumo Financeiro');
        doc.moveDown(0.3);

        // Caixa cinza com resumo
        const boxTop = doc.y;
        doc
          .rect(40, boxTop, 515, 130)
          .fillColor('#f5f0eb')
          .fill();
        doc.fillColor('#000').font('Helvetica').fontSize(10);

        const lineHeight = 18;
        let lineY = boxTop + 10;

        const drawRow = (label: string, value: string, color = '#000', bold = false) => {
          doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
          doc.text(label, 50, lineY, { width: 350 });
          doc.text(value, 400, lineY, { width: 145, align: 'right' });
          lineY += lineHeight;
        };

        drawRow('Venda bruta no mês:', fmt(filial.vendaBruta));
        drawRow('Royalties (8%):', fmt(filial.royaltiesValor), '#7d4a30');
        drawRow('Marketing (4%):', fmt(filial.marketingValor), '#7d4a30');
        drawRow('Obrigações a pagar (mercadoria recebida):', fmt(filial.obrigacoesAPagar), '#985d3f');
        drawRow('Obrigações a receber (mercadoria enviada):', `(${fmt(filial.obrigacoesAReceber)})`, '#5d7048');

        // Linha separadora dentro da caixa
        doc.strokeColor('#c87f5e').lineWidth(0.5).moveTo(50, lineY).lineTo(545, lineY).stroke();
        lineY += 5;

        drawRow('SALDO LÍQUIDO A PAGAR:', fmt(filial.saldoLiquido), '#5e3823', true);

        doc.y = boxTop + 140;
        doc.moveDown(0.5);

        // ── DETALHE DAS OBRIGAÇÕES ───────────────────────────────
        if (obligations.length > 0) {
          doc
            .fontSize(12)
            .font('Helvetica-Bold')
            .fillColor('#5e3823')
            .text(`Detalhe das transferências (${obligations.length} item${obligations.length > 1 ? 's' : ''})`);
          doc.moveDown(0.3);

          // Cabeçalho da tabela
          const tableTop = doc.y;
          const cols = [
            { label: 'De → Para', x: 40, w: 90 },
            { label: 'REF', x: 130, w: 70 },
            { label: 'Cor/Tam', x: 200, w: 80 },
            { label: 'Qty', x: 280, w: 30, align: 'right' as const },
            { label: 'Preço', x: 310, w: 70, align: 'right' as const },
            { label: 'Total', x: 380, w: 75, align: 'right' as const },
            { label: 'Obrigação', x: 455, w: 95, align: 'right' as const },
          ];

          // Header bg
          doc.rect(40, tableTop, 515, 20).fillColor('#e3d5c7').fill();
          doc.fillColor('#5e3823').font('Helvetica-Bold').fontSize(9);
          for (const c of cols) {
            doc.text(c.label, c.x + 3, tableTop + 6, { width: c.w - 6, align: c.align || 'left' });
          }

          let rowY = tableTop + 22;
          doc.font('Helvetica').fontSize(8).fillColor('#000');

          for (let i = 0; i < obligations.length; i++) {
            const o = obligations[i];
            // Quebra de página se necessário
            if (rowY > 770) {
              doc.addPage();
              rowY = 60;
              // Repete header
              doc.rect(40, rowY - 22, 515, 20).fillColor('#e3d5c7').fill();
              doc.fillColor('#5e3823').font('Helvetica-Bold').fontSize(9);
              for (const c of cols) {
                doc.text(c.label, c.x + 3, rowY - 16, { width: c.w - 6, align: c.align || 'left' });
              }
              doc.font('Helvetica').fontSize(8).fillColor('#000');
            }

            // Zebra
            if (i % 2 === 0) {
              doc.rect(40, rowY - 2, 515, 16).fillColor('#fafafa').fill();
            }

            const isReceiving = o.toStoreCode === filial.storeCode;
            const direcao = isReceiving
              ? `${o.fromStoreCode} → ${o.toStoreCode}`
              : `${o.fromStoreCode} → ${o.toStoreCode}`;

            const valuesByCol = [
              direcao,
              o.refCode,
              `${o.cor || '—'}/${o.tamanho || '—'}`,
              String(o.qty),
              fmt(o.precoUnitario),
              fmt(o.precoTotal),
              fmt(o.valorObrigacao),
            ];

            doc.fillColor(isReceiving ? '#985d3f' : '#5d7048');
            for (let ci = 0; ci < cols.length; ci++) {
              const c = cols[ci];
              doc.text(valuesByCol[ci], c.x + 3, rowY + 2, {
                width: c.w - 6,
                align: c.align || 'left',
                ellipsis: true,
              });
            }
            rowY += 16;
          }

          doc.y = rowY + 10;
        } else {
          doc.fontSize(10).fillColor('#666').font('Helvetica-Oblique').text('Sem transferências REDE↔FILIAL nesse mês.');
        }

        // ── FOOTER ────────────────────────────────────────────────
        doc.fontSize(7).fillColor('#999').font('Helvetica');
        const pageHeight = doc.page.height;
        doc.text(
          `Documento gerado por LURD'S ORDER ONE · Fechamento ID ${closure.id} · ` +
            `${new Date().toLocaleString('pt-BR')}`,
          40,
          pageHeight - 30,
          { width: 515, align: 'center' },
        );

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }
}
