import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// pdfkit é CommonJS — usa require() pra evitar problema de interop em runtime
// (ESM import * pode resultar em namespace não-construtor em alguns ambientes).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

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

    // CAIXA DE JUNTADA (21/08): o romaneio precisa GRITAR que essas peças são
    // de um pedido de cliente sendo juntado na loja destino — quem abre a
    // caixa não pode pendurar as peças na arara.
    if (shipment.orderId) {
      const order: any = await (this.prisma as any).order
        .findUnique({
          where: { id: shipment.orderId },
          select: { wcOrderNumber: true, customerName: true, isPickup: true },
        })
        .catch(() => null);
      (shipment as any).__juntada = {
        pedido: order?.wcOrderNumber || shipment.orderId,
        cliente: order?.customerName || '',
        // RETIRADA (27/08): a caixa não vai ser postada — a cliente vem
        // buscar na loja destino. Quem abre precisa GUARDAR, não embalar.
        retirada: !!order?.isPickup,
      };
    }

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
        // Documento começa em A4 PAISAGEM (página de CAPA). O romaneio (lista de
        // produtos) vem depois em A4 retrato.
        const doc = new (PDFDocument as any)({
          size: 'A4',
          layout: 'landscape',
          margin: 30,
          info: {
            Title: `Remessa ${shipment.code}`,
            Author: "Lurd's Plus Size",
            Subject: `Remessa ${shipment.fromStoreCode} → ${shipment.toStoreCode}`,
          },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // ── PÁGINA 1: CAPA A4 PAISAGEM ───────────────────────────
        // Cidade destino GIGANTE + nº da remessa GRANDE + total de peças.
        // É a folha que vai colada na caixa pra triagem visual rápida.
        const totalPecasCapa = items.reduce(
          (s: number, it: any) => s + (Number(it.qtyOrigem) || 1),
          0,
        );
        this.drawCover(doc, shipment, totalPecasCapa);

        // Faixa da JUNTADA na capa: a caixa NÃO é reposição de estoque.
        if ((shipment as any).__juntada) {
          const j = (shipment as any).__juntada;
          doc
            .fontSize(16)
            .fillColor('#b91c1c')
            .font('Helvetica-Bold')
            .text(
              // Sem emoji: as fontes padrão do pdfkit (WinAnsi) não têm o
              // glifo e a geração inteira morre com "glyph not found".
              `ATENÇÃO: PEÇAS DO PEDIDO #${j.pedido}${j.cliente ? ` — ${j.cliente}` : ''} · ` +
                (j.retirada
                  ? `CLIENTE RETIRA NA LOJA ${shipment.toStoreName} · GUARDAR SEPARADO · NÃO COLOCAR NA ARARA`
                  : `JUNTANDO NA LOJA ${shipment.toStoreName} · NÃO COLOCAR NA ARARA`),
              40,
              doc.page.height - 70,
              { width: doc.page.width - 80, align: 'center' },
            );
        }

        // ── PÁGINA 2+: ROMANEIO (A4 RETRATO) ─────────────────────
        // pdfkit: quebras AUTOMÁTICAS de página (lista comprida) chamam
        // addPage() sem args, que herda as opções do CONSTRUTOR — paisagem,
        // por causa da capa. Sem mudar o default aqui, a 1ª folha do romaneio
        // saía retrato e as continuações voltavam pra paisagem (bug 28/07).
        doc.options.layout = 'portrait';
        doc.options.margin = 40;
        doc.addPage({ size: 'A4', layout: 'portrait', margin: 40 });

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

        // Bloco da JUNTADA no romaneio: explica de qual pedido a caixa faz
        // parte e o que a loja destino deve fazer com ela.
        if ((shipment as any).__juntada) {
          const j = (shipment as any).__juntada;
          doc.moveDown(0.4);
          const bx = 40;
          const bw = doc.page.width - 80;
          const by = doc.y;
          doc.roundedRect(bx, by, bw, 46, 6).fillAndStroke('#fee2e2', '#b91c1c');
          doc
            .fillColor('#b91c1c')
            .fontSize(11)
            .font('Helvetica-Bold')
            .text(`ATENÇÃO: ESTA CAIXA FAZ PARTE DO PEDIDO #${j.pedido}${j.cliente ? ` (${j.cliente})` : ''}`, bx + 10, by + 8, {
              width: bw - 20,
            });
          doc
            .fillColor('#7f1d1d')
            .fontSize(9)
            .font('Helvetica')
            .text(
              `As peças estão VENDIDAS e vão ser JUNTADAS na loja ${shipment.toStoreName} pra envio à cliente. ` +
                `Não colocar na arara, não dar entrada como estoque — conferir e juntar ao pedido.`,
              bx + 10,
              by + 24,
              { width: bw - 20 },
            );
          doc.y = by + 52;
        }

        doc.moveDown(0.4);
        doc
          .fontSize(14)
          .fillColor('#0B0B0B')
          .font('Helvetica-Bold')
          .text(`TOTAL DE PEÇAS: ${totalPecasCapa}`, { align: 'center' });

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
        // Larguras redistribuídas: dá MUITO mais espaço pra DESCRIÇÃO (290px)
        // que era 160 e quebrava 2-3 linhas. Coluna COR enxugada de 130 → 80
        // (cores típicas: MARINHO, BEGE, ESTAMPA VERDE — caem em 80 com ellipsis).
        // CÓDIGO entrou em 04/08: duas linhas iguais no romaneio (mesma REF,
        // cor e tamanho) não diziam se era a mesma peça pedida em dobro ou
        // duas peças com cadastro separado no Giga. Com o código na frente, a
        // conferência resolve isso na hora, sem abrir o sistema.
        const cols = [
          { label: '#',          x: 40,  width: 22  },
          { label: 'CÓDIGO',     x: 62,  width: 62  },
          { label: 'REF',        x: 124, width: 56  },
          { label: 'COR',        x: 180, width: 78  },
          { label: 'TAM',        x: 258, width: 32  },
          { label: 'QTY',        x: 290, width: 28  },
          { label: 'DESCRIÇÃO',  x: 318, width: 237 },
        ];

        // Cabeçalho
        doc.rect(40, tableTop, doc.page.width - 80, 18).fill('#fef3c7');
        doc.fillColor('#5e3823').fontSize(9).font('Helvetica-Bold');
        for (const c of cols) {
          doc.text(c.label, c.x + 3, tableTop + 5, { width: c.width, lineBreak: false });
        }
        doc.y = tableTop + 18;

        let totalQty = 0;
        items.forEach((it: any, idx: number) => {
          // Calcula altura dinâmica baseado na DESCRIÇÃO (coluna mais comprida).
          // Outras colunas têm conteúdo curto (REF, COR, TAM, QTY) e ficam centralizadas
          // verticalmente dentro da row. RowHeight = max(16, alturaDescr + 6) pra padding.
          doc.font('Helvetica').fontSize(9);
          const descText = String(it.descricao || '—');
          const descHeight = doc.heightOfString(descText, {
            width: cols[6].width - 6,
          });
          const rowHeight = Math.max(16, descHeight + 6);

          // Quebra de página se a row próxima passar do limite
          if (doc.y + rowHeight > doc.page.height - 100) {
            doc.addPage();
            doc.y = 50;
            // Re-renderiza cabeçalho da tabela na nova página
            const newTop = doc.y;
            doc.rect(40, newTop, doc.page.width - 80, 18).fill('#fef3c7');
            doc.fillColor('#5e3823').fontSize(9).font('Helvetica-Bold');
            for (const c of cols) {
              doc.text(c.label, c.x + 3, newTop + 5, { width: c.width, lineBreak: false });
            }
            doc.y = newTop + 18;
          }

          const rowY = doc.y;
          // Zebra
          if (idx % 2 === 1) {
            doc.rect(40, rowY, doc.page.width - 80, rowHeight).fill('#fafafa');
          }
          doc.fillColor('#222').font('Helvetica').fontSize(9);
          doc.text(String(idx + 1), cols[0].x + 3, rowY + 4, { width: cols[0].width, lineBreak: false });
          doc.text(String(it.codigoBipado || '—'), cols[1].x + 3, rowY + 4, {
            width: cols[1].width,
            ellipsis: true,
            lineBreak: false,
          });
          doc.text(it.refCode || '—', cols[2].x + 3, rowY + 4, {
            width: cols[2].width,
            ellipsis: true,
            lineBreak: false,
          });
          doc.text(it.cor || '—', cols[3].x + 3, rowY + 4, {
            width: cols[3].width,
            ellipsis: true,
            lineBreak: false,
          });
          doc.text(it.tamanho || '—', cols[4].x + 3, rowY + 4, { width: cols[4].width, lineBreak: false });
          doc
            .font('Helvetica-Bold')
            .text(String(it.qtyOrigem || 1), cols[5].x + 3, rowY + 4, {
              width: cols[5].width,
              lineBreak: false,
            });
          // DESCRIÇÃO — quebra em múltiplas linhas dentro da própria célula
          doc
            .font('Helvetica')
            .text(descText, cols[6].x + 3, rowY + 4, {
              width: cols[6].width - 6,
            });

          doc.y = rowY + rowHeight;
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

  /**
   * CAPA A4 PAISAGEM — cidade destino GIGANTE + nº da remessa GRANDE + total de
   * peças. Folha pra colar na caixa (triagem visual no recebimento).
   */
  private drawCover(doc: any, shipment: any, totalPecas: number) {
    const W = doc.page.width; // ~842 (paisagem)
    const cidade = String(shipment.toStoreName || shipment.toStoreCode || '—').toUpperCase();
    // Cidade longa → reduz a fonte pra caber em 1 linha.
    const cidadeFont = cidade.length > 14 ? 64 : cidade.length > 10 ? 80 : 100;

    // Rótulo topo
    doc
      .fillColor('#5e3823')
      .font('Helvetica-Bold')
      .fontSize(20)
      .text('TRANSFERÊNCIA DE MERCADORIA', 0, 46, { align: 'center', width: W });
    doc
      .fillColor('#999')
      .font('Helvetica')
      .fontSize(14)
      .text(
        `Origem: ${shipment.fromStoreName} (${shipment.fromStoreCode})`,
        0,
        78,
        { align: 'center', width: W },
      );

    // DESTINO (rótulo) + CIDADE gigante
    doc
      .fillColor('#16a34a')
      .font('Helvetica-Bold')
      .fontSize(16)
      .text('DESTINO', 0, 130, { align: 'center', width: W });
    doc
      .fillColor('#0B0B0B')
      .font('Helvetica-Bold')
      .fontSize(cidadeFont)
      .text(cidade, 0, 150, { align: 'center', width: W });

    // Nº DA REMESSA — grande
    doc
      .fillColor('#5e3823')
      .font('Helvetica-Bold')
      .fontSize(58)
      .text(String(shipment.code || ''), 0, 330, { align: 'center', width: W });

    // TOTAL DE PEÇAS — grande
    doc
      .fillColor('#0B0B0B')
      .font('Helvetica-Bold')
      .fontSize(44)
      .text(
        `${totalPecas} PEÇA${totalPecas === 1 ? '' : 'S'}`,
        0,
        430,
        { align: 'center', width: W },
      );
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
