import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as PDFDocument from 'pdfkit';

/**
 * ShipmentPdfService — gera o PDF da nota de remessa de realinhamento.
 *
 * Layout (1-2 páginas):
 *   - Cabeçalho: Lurd's Plus Size · Romaneio de Remessa · CÓDIGO
 *   - Bloco origem/destino (lojas)
 *   - Tabela de itens (REF, COR, TAMANHO, QTY)
 *   - Totais (qtd itens + peças)
 *   - Linha de assinatura conferente origem · conferente destino
 *   - Footer: data emissão + status atual
 *
 * Pode ser gerado em qualquer status (open/in_transit/received) — a info
 * relevante muda. Usado pra anexar fisicamente na caixa antes de mandar.
 */
@Injectable()
export class ShipmentPdfService {
  private readonly logger = new Logger(ShipmentPdfService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gera PDF de uma remessa específica.
   *
   * Se `requireStoreCode` for passado, valida que a remessa é da loja
   * origem OU destino (impede vazar romaneio entre lojas).
   */
  async generateForShipment(
    shipmentId: string,
    requireStoreCode?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (
      requireStoreCode &&
      shipment.fromStoreCode !== requireStoreCode &&
      shipment.toStoreCode !== requireStoreCode
    ) {
      throw new ForbiddenException('Esta remessa não é da sua loja');
    }

    // Itens da remessa
    const items = await (this.prisma as any).transferOrder.findMany({
      where: { shipmentId } as any,
      orderBy: [{ refCode: 'asc' }, { cor: 'asc' }, { tamanho: 'asc' }],
    });

    const buffer = await this.buildPdf(shipment, items);
    const safeCode = String(shipment.code || shipmentId).replace(/[^A-Za-z0-9-_]/g, '');
    const filename = `remessa-${safeCode}.pdf`;
    return { buffer, filename };
  }

  /**
   * Constrói o PDF (stream → Buffer).
   */
  private buildPdf(shipment: any, items: any[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new (PDFDocument as any)({
          size: 'A4',
          margin: 40,
          info: {
            Title: `Romaneio ${shipment.code}`,
            Author: "Lurd's Plus Size",
            Subject: `Remessa ${shipment.fromStoreCode} → ${shipment.toStoreCode}`,
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
          .text('Romaneio de Remessa — Realinhamento de Estoque', { align: 'center' });

        doc.moveDown(0.5);
        doc
          .fontSize(16)
          .fillColor('#5e3823')
          .font('Helvetica-Bold')
          .text(`${shipment.code}`, { align: 'center' });

        doc.moveDown(0.2);
        const statusLabel: Record<string, string> = {
          open: 'EM MONTAGEM',
          in_transit: 'EM TRÂNSITO',
          received: 'RECEBIDA',
          cancelled: 'CANCELADA',
        };
        doc
          .fontSize(10)
          .fillColor(this.statusColor(shipment.status))
          .font('Helvetica-Bold')
          .text(statusLabel[shipment.status] || shipment.status.toUpperCase(), { align: 'center' });

        doc.moveDown(1);

        // ── ORIGEM / DESTINO ─────────────────────────────────────
        const colW = (doc.page.width - 80) / 2 - 10;
        const startY = doc.y;

        // Caixa origem
        doc.roundedRect(40, startY, colW, 70, 6).fillAndStroke('#fef3c7', '#d97706');
        doc
          .fillColor('#92400e')
          .fontSize(8)
          .font('Helvetica-Bold')
          .text('ORIGEM', 50, startY + 8);
        doc
          .fontSize(13)
          .fillColor('#5e3823')
          .text(shipment.fromStoreName, 50, startY + 22, { width: colW - 20 });
        doc
          .fontSize(10)
          .fillColor('#666')
          .font('Helvetica')
          .text(`Código: ${shipment.fromStoreCode}`, 50, startY + 50);

        // Caixa destino
        const xDest = 40 + colW + 20;
        doc.roundedRect(xDest, startY, colW, 70, 6).fillAndStroke('#dcfce7', '#16a34a');
        doc
          .fillColor('#166534')
          .fontSize(8)
          .font('Helvetica-Bold')
          .text('DESTINO', xDest + 10, startY + 8);
        doc
          .fontSize(13)
          .fillColor('#5e3823')
          .text(shipment.toStoreName, xDest + 10, startY + 22, { width: colW - 20 });
        doc
          .fontSize(10)
          .fillColor('#666')
          .font('Helvetica')
          .text(`Código: ${shipment.toStoreCode}`, xDest + 10, startY + 50);

        doc.y = startY + 80;
        doc.moveDown(0.5);

        // ── DATAS ────────────────────────────────────────────────
        doc
          .fontSize(9)
          .fillColor('#666')
          .font('Helvetica')
          .text(
            `Aberta em: ${this.fmtDate(shipment.openedAt)}` +
              (shipment.sentAt ? `   ·   Enviada em: ${this.fmtDate(shipment.sentAt)}` : '') +
              (shipment.receivedAt ? `   ·   Recebida em: ${this.fmtDate(shipment.receivedAt)}` : ''),
            { align: 'left' },
          );
        doc.moveDown(1);

        // ── TABELA DE ITENS ──────────────────────────────────────
        doc.fontSize(11).fillColor('#5e3823').font('Helvetica-Bold').text('Itens da remessa');
        doc.moveDown(0.3);

        const tableTop = doc.y;
        const cols = [
          { label: '#', x: 40, width: 25 },
          { label: 'REF', x: 65, width: 110 },
          { label: 'COR', x: 175, width: 130 },
          { label: 'TAM', x: 305, width: 50 },
          { label: 'QTY', x: 355, width: 40 },
          { label: 'DESCRIÇÃO', x: 395, width: 160 },
        ];

        // Cabeçalho
        doc.rect(40, tableTop, doc.page.width - 80, 18).fill('#fef3c7');
        doc.fillColor('#5e3823').fontSize(9).font('Helvetica-Bold');
        for (const c of cols) {
          doc.text(c.label, c.x + 3, tableTop + 5, { width: c.width });
        }
        doc.y = tableTop + 18;

        let totalQty = 0;
        doc.font('Helvetica').fontSize(9).fillColor('#222');
        items.forEach((it: any, idx: number) => {
          const y = doc.y;
          // Quebra de página se passar do final
          if (y > doc.page.height - 100) {
            doc.addPage();
            doc.y = 50;
          }
          const rowY = doc.y;
          // Zebra
          if (idx % 2 === 1) {
            doc.rect(40, rowY, doc.page.width - 80, 16).fill('#fafafa');
            doc.fillColor('#222');
          }
          doc.text(String(idx + 1), cols[0].x + 3, rowY + 4, { width: cols[0].width });
          doc.text(it.refCode || '—', cols[1].x + 3, rowY + 4, { width: cols[1].width });
          doc.text(it.cor || '—', cols[2].x + 3, rowY + 4, {
            width: cols[2].width,
            ellipsis: true,
            lineBreak: false,
          });
          doc.text(it.tamanho || '—', cols[3].x + 3, rowY + 4, { width: cols[3].width });
          doc
            .font('Helvetica-Bold')
            .text(String(it.qtyOrigem || 1), cols[4].x + 3, rowY + 4, { width: cols[4].width });
          doc
            .font('Helvetica')
            .text(it.descricao || '—', cols[5].x + 3, rowY + 4, {
              width: cols[5].width,
              ellipsis: true,
              lineBreak: false,
            });
          doc.y = rowY + 16;
          totalQty += Number(it.qtyOrigem) || 1;
        });

        // Linha total
        doc.moveDown(0.3);
        doc
          .strokeColor('#5e3823')
          .lineWidth(1)
          .moveTo(40, doc.y)
          .lineTo(doc.page.width - 40, doc.y)
          .stroke();
        doc.moveDown(0.3);
        doc
          .fontSize(11)
          .fillColor('#5e3823')
          .font('Helvetica-Bold')
          .text(`TOTAL: ${items.length} item(s) · ${totalQty} peça(s)`, { align: 'right' });

        doc.moveDown(2);

        // ── ASSINATURAS ─────────────────────────────────────────
        const sigY = doc.y;
        const sigW = (doc.page.width - 80 - 40) / 2;

        doc
          .strokeColor('#666')
          .lineWidth(0.5)
          .moveTo(40, sigY + 30)
          .lineTo(40 + sigW, sigY + 30)
          .stroke();
        doc
          .fontSize(8)
          .fillColor('#666')
          .font('Helvetica')
          .text('Conferente origem (separação)', 40, sigY + 35, { width: sigW, align: 'center' });

        const sigDestX = 40 + sigW + 40;
        doc
          .strokeColor('#666')
          .moveTo(sigDestX, sigY + 30)
          .lineTo(sigDestX + sigW, sigY + 30)
          .stroke();
        doc
          .fontSize(8)
          .fillColor('#666')
          .text('Conferente destino (recebimento)', sigDestX, sigY + 35, {
            width: sigW,
            align: 'center',
          });

        // ── FOOTER ──────────────────────────────────────────────
        doc
          .fontSize(7)
          .fillColor('#999')
          .text(
            `Gerado em ${this.fmtDate(new Date())} · LURDS ORDER ONE`,
            40,
            doc.page.height - 50,
            { align: 'center', width: doc.page.width - 80 },
          );

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  private fmtDate(d: Date | string | null): string {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  private statusColor(status: string): string {
    const colors: Record<string, string> = {
      open: '#d97706',
      in_transit: '#2563eb',
      received: '#16a34a',
      cancelled: '#dc2626',
    };
    return colors[status] || '#666';
  }
}
