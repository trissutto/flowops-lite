import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as PDFDocument from 'pdfkit';
import { brl, rotuloDoMotivo } from '../common/estornos';

const COLUNAS = [
  'Data',
  'Pedido',
  'Origem',
  'Cliente',
  'CPF',
  'Forma',
  'Gateway',
  'Transação',
  'Tipo',
  'Valor',
  'Status',
  'Status no gateway',
  'Motivo',
  'Quem autorizou',
  'Nível',
] as const;

/**
 * EXPORTAÇÃO DO HISTÓRICO — Excel, CSV e PDF (22/09/2026).
 *
 * Os três saem do MESMO recorte que está na tela: o controller manda as linhas
 * já filtradas, e aqui ninguém refiltra. Relatório que discorda da tela é a
 * família do "resumo e lista em recortes diferentes" que já custou uma
 * conferência inteira na conciliação.
 *
 * O CPF sai INTEIRO aqui de propósito — é relatório interno da matriz, com
 * senha na porta; quem sai mascarado é o comprovante que vai pra cliente.
 */
@Injectable()
export class EstornosExportService {
  async exportar(
    formato: string,
    linhas: any[],
    periodo: { de?: string; ate?: string } = {},
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const base = `estornos-${new Date().toISOString().slice(0, 10)}`;
    if (formato === 'xlsx' || formato === 'excel') {
      return { buffer: await this.excel(linhas), filename: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    if (formato === 'pdf') {
      return { buffer: await this.pdf(linhas, periodo), filename: `${base}.pdf`, contentType: 'application/pdf' };
    }
    return { buffer: Buffer.from(this.csv(linhas), 'utf8'), filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8' };
  }

  private celulas(e: any): string[] {
    return [
      this.dataHora(e.createdAt),
      e.refNumero || String(e.refId || '').slice(-8),
      this.rotuloOrigem(e.origem),
      e.clienteNome || '',
      e.clienteCpf || '',
      String(e.metodo || '').includes('pix') ? 'PIX' : 'Cartão',
      e.gateway === 'pagbank' ? 'PagBank' : 'Pagar.me',
      e.gatewayChargeId || '',
      e.tipo === 'integral' ? 'Integral' : 'Parcial',
      brl(e.valorCents),
      String(e.status || ''),
      e.statusGateway || '',
      `${rotuloDoMotivo(e.motivo)}${e.motivoTexto ? ` — ${e.motivoTexto}` : ''}`,
      e.autorizadoPorNome || e.usuarioNome || '',
      e.nivelAutorizacao || '',
    ];
  }

  /** BOM na frente: sem ele o Excel em português abre acentuação quebrada. */
  private csv(linhas: any[]): string {
    const corpo = [COLUNAS as unknown as string[], ...linhas.map((e) => this.celulas(e))]
      .map((l) => l.map((c) => this.celulaCsv(c)).join(';'))
      .join('\r\n');
    return `﻿${corpo}`;
  }

  private celulaCsv(v: any): string {
    const s = String(v ?? '');
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  private async excel(linhas: any[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Estornos');
    ws.addRow(COLUNAS as unknown as string[]).font = { bold: true };
    for (const e of linhas) ws.addRow(this.celulas(e));
    ws.columns.forEach((c) => {
      c.width = 18;
    });
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  private pdf(linhas: any[], periodo: { de?: string; ate?: string }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new (PDFDocument as any)({ size: 'A4', layout: 'landscape', margin: 30 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.fontSize(14).font('Helvetica-Bold').fillColor('#5e3823').text('Estornos e devoluções', { align: 'center' });
        const faixa = [periodo.de, periodo.ate].filter(Boolean).join(' até ');
        doc
          .fontSize(9)
          .font('Helvetica')
          .fillColor('#666')
          .text(`${linhas.length} registro(s)${faixa ? ` · ${faixa}` : ''} · emitido em ${this.dataHora(new Date())}`, {
            align: 'center',
          });
        doc.moveDown(0.6);

        // Só o que cabe deitado numa folha — o detalhe inteiro está no Excel.
        const larguras = [92, 72, 72, 150, 52, 62, 62, 70, 110];
        const cabecalho = ['Data', 'Pedido', 'Origem', 'Cliente', 'Forma', 'Valor', 'Status', 'Tipo', 'Motivo'];
        const linha = (cels: string[], negrito = false) => {
          if (doc.y > 520) doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
          const y = doc.y;
          let x = 30;
          doc.fontSize(8).font(negrito ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000');
          cels.forEach((c, i) => {
            doc.text(String(c ?? ''), x, y, { width: larguras[i] - 4, height: 11, ellipsis: true });
            x += larguras[i];
          });
          doc.y = y + 13;
        };
        linha(cabecalho, true);
        doc.strokeColor('#c87f5e').lineWidth(0.7).moveTo(30, doc.y - 3).lineTo(812, doc.y - 3).stroke();
        for (const e of linhas) {
          const c = this.celulas(e);
          linha([c[0], c[1], c[2], c[3], c[5], c[9], c[10], c[8], c[12]]);
        }
        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  private rotuloOrigem(o: string): string {
    const m: Record<string, string> = {
      site: 'Site',
      pdv_online: 'Venda online',
      live: 'Live',
      pdv_balcao: 'Balcão',
      crediario: 'Crediário',
    };
    return m[String(o)] || String(o || '');
  }

  /** Hora de Brasília SEMPRE — o servidor roda em UTC. */
  private dataHora(v: any): string {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
}
