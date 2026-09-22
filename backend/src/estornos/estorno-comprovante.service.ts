import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AtorEstorno, EstornosAcessoService } from './estornos-acesso.service';
import { StatusEstorno, brl, fraseDoComprovante, mascararCpf, mascararEmail, rotuloDoMotivo } from '../common/estornos';

const MARROM = '#5e3823';
const COBRE = '#985d3f';
const CINZA = '#666666';
const LINHA = '#c87f5e';
const VERDE = '#2E7D46';
const AMBAR = '#B8912B';
const VERMELHO = '#B3261E';
const SEM_DADO = 'não disponível';

/**
 * COMPROVANTE DE ESTORNO — o papel que vai pra cliente (22/09/2026).
 *
 * 🚨 A REGRA QUE MANDA AQUI: **o comprovante diz o que o gateway disse, e nada
 * além.** Estorno ainda em processamento sai como "EM PROCESSAMENTO", com
 * prazo e sem a palavra "devolvido"; estorno recusado não vira comprovante
 * nenhum. Papel que afirma devolução que não aconteceu é pior que papel
 * nenhum: a cliente para de cobrar e o dinheiro nunca chega.
 *
 * O que NÃO entra: observação interna (é nota nossa, não da cliente), CPF e
 * e-mail inteiros (vão mascarados — o documento circula por WhatsApp e
 * e-mail) e qualquer dado de cartão além da bandeira/últimos dígitos que o
 * gateway já devolveu.
 */
@Injectable()
export class EstornoComprovanteService {
  private readonly logger = new Logger(EstornoComprovanteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly acesso: EstornosAcessoService,
  ) {}

  async gerar(estornoId: string): Promise<{ buffer: Buffer; filename: string; titulo: string }> {
    const e = await (this.prisma as any).estornoPagamento.findUnique({ where: { id: estornoId } });
    if (!e) throw new BadRequestException('Estorno não encontrado.');
    const frase = fraseDoComprovante(String(e.status) as StatusEstorno);
    if (!frase.podeEmitir) {
      throw new BadRequestException(
        `Este estorno está "${e.status}" — não existe comprovante de estorno que não saiu. Consulte o gateway e tente de novo quando ele confirmar.`,
      );
    }
    const empresa = await this.empresa(e.storeCode);
    const buffer = await this.montar(e, empresa, frase.titulo);
    const nome = String(e.refNumero || e.id.slice(-8)).replace(/[^\w-]/g, '');
    return { buffer, filename: `estorno-${nome}.pdf`, titulo: frase.titulo };
  }

  /**
   * Manda o comprovante pra cliente, com o PDF ANEXADO. O endereço pode ser
   * corrigido na hora (a senha já foi conferida na porta) e o que foi enviado
   * — pra quem, quando — fica gravado no estorno e no log.
   */
  async enviarPorEmail(estornoId: string, paraDigitado: string | undefined, ator: AtorEstorno) {
    const e = await (this.prisma as any).estornoPagamento.findUnique({ where: { id: estornoId } });
    if (!e) throw new BadRequestException('Estorno não encontrado.');
    const para = String(paraDigitado || e.clienteEmail || '').trim();
    if (!para.includes('@')) {
      throw new BadRequestException('Este pedido não tem e-mail da cliente — digite o endereço pra enviar.');
    }

    const { buffer, filename, titulo } = await this.gerar(estornoId);
    const ok = await this.email.send(
      para,
      `${titulo} — pedido ${e.refNumero || ''}`.trim(),
      this.corpoDoEmail(e, titulo),
      undefined,
      [{ filename, content: buffer, contentType: 'application/pdf' }],
    );

    if (ok) {
      await (this.prisma as any).estornoPagamento.update({
        where: { id: e.id },
        data: { comprovanteEnviadoEm: new Date(), comprovanteEmail: para },
      });
    }
    this.logger.log(`[estornos] comprovante ${e.id} ${ok ? 'enviado' : 'NÃO enviado'} para ${para}`);
    await this.acesso.registrar({
      tipo: ok ? 'email_ok' : 'email_erro',
      ator,
      estornoId: e.id,
      refId: e.refId,
      refNumero: e.refNumero,
      detalhe: `comprovante ${ok ? 'enviado' : 'NÃO enviado'} para ${para}`,
    });
    if (!ok) {
      // Falha de SMTP não pode virar "enviado" na tela — a cliente ficaria
      // esperando um e-mail que não saiu.
      throw new BadRequestException(
        'O e-mail não saiu (servidor de e-mail indisponível ou endereço recusado). Baixe o PDF e mande pela loja.',
      );
    }
    return { ok: true, para, enviadoEm: new Date() };
  }

  private corpoDoEmail(e: any, titulo: string): string {
    const pendente = e.status !== 'processado';
    const pix = String(e.metodo || '').toLowerCase().includes('pix');
    const prazo = pix
      ? 'O valor volta para a mesma conta que pagou o PIX, normalmente em alguns minutos depois da confirmação.'
      : 'No cartão de crédito, o valor aparece como crédito na fatura em até 2 dias úteis, conforme o prazo do seu banco.';
    return `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">
        <p>Olá${e.clienteNome ? `, ${String(e.clienteNome).split(' ')[0]}` : ''}!</p>
        <p>${pendente ? 'Solicitamos o estorno' : 'Confirmamos o estorno'} de
           <strong>${brl(e.valorCents)}</strong>${e.refNumero ? ` referente ao pedido <strong>${e.refNumero}</strong>` : ''}.</p>
        <p>${pendente ? 'A operação está sendo processada pelo nosso meio de pagamento. ' : ''}${prazo}</p>
        <p>O comprovante está anexado a este e-mail em PDF.</p>
        <p style="color:#666;font-size:12px">${titulo} · Lurd's Plus Size</p>
      </div>`;
  }

  /** Dados da empresa: a loja dona da conta do gateway, com queda pra matriz. */
  private async empresa(storeCode?: string | null) {
    const candidatos = [String(storeCode || '').trim(), 'SITE', '01'].filter(Boolean);
    for (const code of candidatos) {
      const cfg = await (this.prisma as any).nfceConfig.findUnique({ where: { storeCode: code } }).catch(() => null);
      if (cfg?.cnpj || cfg?.razaoSocial) {
        return {
          razaoSocial: cfg.razaoSocial || cfg.fantasia || "Lurd's Plus Size",
          cnpj: this.formatarCnpj(cfg.cnpj),
          endereco: this.endereco(cfg.endereco),
        };
      }
    }
    return { razaoSocial: "Lurd's Plus Size", cnpj: SEM_DADO, endereco: SEM_DADO };
  }

  private endereco(json: string | null | undefined): string {
    try {
      const e = JSON.parse(String(json || '{}'));
      const partes = [
        [e.logradouro, e.numero].filter(Boolean).join(', '),
        e.bairro,
        [e.municipio, e.uf].filter(Boolean).join('/'),
        e.cep ? `CEP ${e.cep}` : '',
      ].filter(Boolean);
      return partes.length ? partes.join(' · ') : SEM_DADO;
    } catch {
      return SEM_DADO;
    }
  }

  private formatarCnpj(v: string | null | undefined): string {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length !== 14) return d || SEM_DADO;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }

  private montar(e: any, empresa: any, titulo: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new (PDFDocument as any)({
          size: 'A4',
          margin: 44,
          info: {
            Title: `Comprovante de estorno ${e.refNumero || ''}`.trim(),
            Author: empresa.razaoSocial,
            Subject: 'Comprovante de estorno / devolução de pagamento',
          },
        });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.cabecalho(doc, e, empresa, titulo);
        this.blocoPedido(doc, e);
        this.blocoFinanceiro(doc, e);
        this.blocoTransacao(doc, e);
        this.blocoMotivo(doc, e);
        this.rodape(doc, e);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  private cabecalho(doc: any, e: any, empresa: any, titulo: string) {
    const logo = this.acharLogo();
    if (logo) {
      try {
        doc.image(logo, 44, 40, { fit: [46, 46] });
      } catch {
        /* logo é enfeite: comprovante sai sem ela */
      }
    }
    doc.fontSize(16).fillColor(MARROM).font('Helvetica-Bold').text(empresa.razaoSocial, { align: 'center' });
    doc.fontSize(9).fillColor(CINZA).font('Helvetica').text(`CNPJ ${empresa.cnpj}`, { align: 'center' });
    if (empresa.endereco && empresa.endereco !== SEM_DADO) {
      doc.fontSize(8.5).fillColor(CINZA).text(empresa.endereco, { align: 'center' });
    }
    doc.moveDown(0.6);
    const cor = e.status === 'processado' ? VERDE : AMBAR;
    doc.fontSize(15).fillColor(cor).font('Helvetica-Bold').text(titulo, { align: 'center' });
    doc.moveDown(0.15);
    doc
      .fontSize(9)
      .fillColor(CINZA)
      .font('Helvetica')
      .text(`Comprovante nº ${String(e.id).slice(0, 8).toUpperCase()} · emitido em ${this.dataHora(new Date())}`, {
        align: 'center',
      });
    this.regua(doc);
  }

  private blocoPedido(doc: any, e: any) {
    this.titulo(doc, 'Pedido e cliente');
    this.par(doc, [
      ['Pedido', e.refNumero || String(e.refId).slice(-8)],
      ['Origem', this.rotuloOrigem(e.origem)],
      ['Cliente', e.clienteNome || SEM_DADO],
      ['CPF', e.clienteCpf ? mascararCpf(e.clienteCpf) : SEM_DADO],
      ['E-mail', e.clienteEmail ? mascararEmail(e.clienteEmail) : SEM_DADO],
    ]);
  }

  private blocoFinanceiro(doc: any, e: any) {
    const saldo = Math.max(0, Number(e.valorPagoCents || 0) - Number(e.jaEstornadoCents || 0) - Number(e.valorCents || 0));
    this.titulo(doc, 'Valores');
    this.par(doc, [
      ['Valor pago', brl(e.valorPagoCents)],
      ['Já estornado antes desta operação', brl(e.jaEstornadoCents)],
      ['Valor DESTE estorno', `${brl(e.valorCents)} (${e.tipo === 'integral' ? 'integral' : 'parcial'})`],
      ['Saldo que continua pago', brl(saldo)],
    ]);
  }

  private blocoTransacao(doc: any, e: any) {
    this.titulo(doc, 'Transação');
    this.par(doc, [
      ['Forma de pagamento', this.rotuloMetodo(e.metodo)],
      ['Gateway', e.gateway === 'pagbank' ? 'PagBank' : 'Pagar.me'],
      ['Código da transação', e.gatewayChargeId || SEM_DADO],
      ['Pedido no gateway', e.gatewayOrderId || SEM_DADO],
      ['Estorno solicitado em', this.dataHora(e.createdAt)],
      ['Confirmado pelo gateway em', e.processadoEm ? this.dataHora(e.processadoEm) : 'aguardando confirmação'],
      ['Situação informada pelo gateway', e.statusGateway || SEM_DADO],
    ]);
  }

  private blocoMotivo(doc: any, e: any) {
    this.titulo(doc, 'Motivo');
    doc.fontSize(9.5).fillColor('#000').font('Helvetica').text(rotuloDoMotivo(e.motivo));
    if (e.motivoTexto) {
      doc.moveDown(0.15);
      doc.fontSize(9.5).fillColor(CINZA).text(String(e.motivoTexto));
    }
    // A OBSERVAÇÃO INTERNA fica de fora de propósito: é anotação nossa.
  }

  private rodape(doc: any, e: any) {
    this.regua(doc);
    const pix = String(e.metodo || '').toLowerCase().includes('pix');
    const prazo = pix
      ? 'O valor volta para a MESMA conta que pagou o PIX, normalmente em alguns minutos depois da confirmação.'
      : 'No cartão de crédito, o valor aparece como crédito na fatura em até 2 dias úteis, conforme o prazo do banco emissor — pode cair na fatura seguinte.';
    const pendente = e.status !== 'processado';
    doc.fontSize(9.5).fillColor(pendente ? AMBAR : '#000').font(pendente ? 'Helvetica-Bold' : 'Helvetica');
    if (pendente) {
      doc.text(
        'Este estorno foi solicitado e está sendo processado pelo gateway de pagamento. Assim que a confirmação chegar, o crédito segue o prazo abaixo.',
        { align: 'justify' },
      );
      doc.moveDown(0.3);
    }
    doc.fontSize(9.5).fillColor('#000').font('Helvetica').text(prazo, { align: 'justify' });
    doc.moveDown(0.5);
    doc
      .fontSize(8)
      .fillColor(CINZA)
      .text(
        'Documento gerado automaticamente pelo sistema da loja. Em caso de dúvida, responda esta mensagem com o número do pedido informado acima.',
        { align: 'center' },
      );
  }

  private rotuloOrigem(o: string): string {
    const m: Record<string, string> = {
      site: 'Pedido do site',
      pdv_online: 'Venda online da loja',
      live: 'Compra na live',
      pdv_balcao: 'Venda na loja',
      crediario: 'Crediário',
    };
    return m[String(o)] || String(o || SEM_DADO);
  }

  private rotuloMetodo(m: string): string {
    const s = String(m || '').toLowerCase();
    if (s.includes('pix')) return 'PIX';
    if (s.includes('credit') || s.includes('cart')) return 'Cartão de crédito';
    if (s.includes('debit')) return 'Cartão de débito';
    return m || SEM_DADO;
  }

  /** A mesma logo da DANFE — os caminhos mudam entre dev e o build do Railway. */
  private acharLogo(): string | null {
    const candidatos = [
      path.join(__dirname, '..', '..', 'assets', 'danfe-logo.png'),
      path.join(__dirname, '..', '..', '..', 'assets', 'danfe-logo.png'),
      path.join(process.cwd(), 'assets', 'danfe-logo.png'),
      path.join(process.cwd(), 'backend', 'assets', 'danfe-logo.png'),
    ];
    for (const c of candidatos) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* ignora */
      }
    }
    return null;
  }

  // ── Desenho ───────────────────────────────────────────────────────────────

  private titulo(doc: any, t: string) {
    if (doc.y > 720) doc.addPage();
    doc.moveDown(0.6);
    doc.fontSize(11.5).fillColor(MARROM).font('Helvetica-Bold').text(t);
    doc.moveDown(0.2);
    doc.fontSize(9.5).fillColor('#000').font('Helvetica');
  }

  private par(doc: any, linhas: Array<[string, string]>) {
    for (const [k, v] of linhas) {
      if (doc.y > 760) doc.addPage();
      doc
        .fontSize(9.5)
        .fillColor(CINZA)
        .font('Helvetica')
        .text(`${k}: `, { continued: true })
        .fillColor('#000')
        .font('Helvetica-Bold')
        .text(String(v ?? SEM_DADO));
    }
    doc.font('Helvetica').fillColor('#000');
  }

  private regua(doc: any) {
    doc.moveDown(0.45);
    doc.strokeColor(LINHA).lineWidth(1).moveTo(44, doc.y).lineTo(551, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fillColor('#000');
  }

  /** Hora de Brasília SEMPRE — o servidor roda em UTC. */
  private dataHora(v: any): string {
    if (!v) return SEM_DADO;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return SEM_DADO;
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
}

/** O vermelho fica aqui pra quem for desenhar a versão "recusado" (hoje não sai). */
export const COR_RECUSADO = VERMELHO;
export const COR_OK = COBRE;
