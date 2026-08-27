import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { DanfePdfService } from '../nfe/danfe-pdf.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENVIO DA NOTA FISCAL PRA CLIENTE  (27/08 — pedido do dono)
 *
 *  🚨 NASCE DESLIGADO. `NFE_ENVIO_CLIENTE=1` é o que liga — sem a env, o
 *  serviço monta tudo (acha a nota, gera o PDF, escreve o e-mail) e PARA antes
 *  de enviar, devolvendo o que TERIA feito. Ordem do dono: "não coloque em
 *  produção ainda".
 *
 *  Não existe cron aqui, nem gancho no fluxo do pedido. Nada dispara sozinho:
 *  o único caminho é alguém chamar o endpoint. Quando for a hora de ligar de
 *  verdade, o gancho entra em quem despacha (`markShipped`) e esta trava vira
 *  a rede de segurança, não o único freio.
 *
 *  ── O DESENHO ──
 *
 *  A nota é por CARD, não por pedido (`shipment_id = 'envio:<pickId>'`): num
 *  pedido dividido a cliente recebe DUAS notas, de dois CNPJs. Isso não é
 *  detalhe técnico, é o que ela vai ver na caixa de entrada — então o e-mail
 *  diz de qual loja é a nota e quantos volumes o pedido tem, senão a segunda
 *  mensagem parece cobrança repetida.
 *
 *  Só nota AUTORIZADA vai. Rejeitada não é documento; mandar DANFE de
 *  homologação (`tpAmb='2'`) pra cliente seria mandar um papel que a SEFAZ não
 *  reconhece — as duas são recusadas aqui, com motivo.
 *
 *  Duplicata: o serviço olha o que já foi enviado com sucesso pro MESMO
 *  destino e recusa, a menos que venha `force`. Reenvio existe (cliente pediu
 *  de novo, e-mail estava errado) — o que não pode é retry acidental virar
 *  três e-mails.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface EnvioNfeResultado {
  ok: boolean;
  /** O que aconteceu, em uma palavra — a tela e o log leem isto. */
  resultado: 'enviado' | 'simulado' | 'ja-enviado' | 'sem-nota' | 'sem-email' | 'nota-invalida' | 'falha';
  motivo?: string;
  /** Pra onde foi (ou iria). */
  destino?: string;
  nfeDocId?: string;
  numero?: number;
  serie?: string;
  /** Tamanho do PDF gerado — prova de que o DANFE saiu, mesmo em simulação. */
  pdfBytes?: number;
  assunto?: string;
}

@Injectable()
export class NfeEnvioClienteService {
  private readonly logger = new Logger(NfeEnvioClienteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly danfe: DanfePdfService,
  ) {}

  /**
   * 🚨 A TRAVA. Sem `NFE_ENVIO_CLIENTE=1` nada sai.
   * Lida a cada chamada de propósito: ligar/desligar não pode exigir deploy.
   */
  private get ligado(): boolean {
    return String(process.env.NFE_ENVIO_CLIENTE || '').trim() === '1';
  }

  /**
   * Manda (ou simula) a nota do envio de UM card.
   *
   * @param pickOrderId card que despachou — é ele que tem a nota.
   * @param opts.force  reenviar mesmo já tendo ido pro mesmo destino.
   * @param opts.userId quem clicou (null = automático).
   * @param opts.emailOverride mandar pra outro endereço (cliente digitou errado).
   */
  async enviarPorCard(
    pickOrderId: string,
    opts: { force?: boolean; userId?: string | null; emailOverride?: string } = {},
  ): Promise<EnvioNfeResultado> {
    const card = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true, orderId: true, status: true,
        store: { select: { code: true, name: true } },
      },
    });
    if (!card) throw new NotFoundException('Card de separação não encontrado');

    const nota = await this.prisma.nfeDoc.findFirst({
      where: { shipmentId: `envio:${pickOrderId}` },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, numero: true, serie: true, chave: true, status: true,
        tpAmb: true, valorTotalCents: true, xMotivo: true,
      },
    });
    if (!nota) {
      return { ok: false, resultado: 'sem-nota', motivo: 'Este envio não tem nota fiscal emitida.' };
    }
    if (nota.status !== 'authorized') {
      return {
        ok: false, resultado: 'nota-invalida', nfeDocId: nota.id,
        motivo: `Nota está "${nota.status}"${nota.xMotivo ? ` — ${nota.xMotivo}` : ''}. Só nota AUTORIZADA vai pra cliente.`,
      };
    }
    if (nota.tpAmb === '2') {
      return {
        ok: false, resultado: 'nota-invalida', nfeDocId: nota.id,
        motivo: 'Nota de HOMOLOGAÇÃO (teste) — a SEFAZ não reconhece esse DANFE. Não vai pra cliente.',
      };
    }

    const pedido = await this.prisma.order.findUnique({
      where: { id: card.orderId },
      select: {
        id: true, wcOrderNumber: true, customerName: true, customerEmail: true,
        pickOrders: { select: { id: true } },
      },
    });
    if (!pedido) throw new NotFoundException('Pedido não encontrado');

    const destino = String(opts.emailOverride || pedido.customerEmail || '').trim();
    if (!destino.includes('@')) {
      return {
        ok: false, resultado: 'sem-email', nfeDocId: nota.id,
        motivo: 'Cliente sem e-mail no cadastro — não há pra onde mandar.',
      };
    }

    if (!opts.force) {
      const ja = await this.prisma.nfeEnvioCliente.findFirst({
        where: { nfeDocId: nota.id, destino, status: 'sent' },
        orderBy: { enviadoEm: 'desc' },
        select: { enviadoEm: true },
      });
      if (ja) {
        return {
          ok: false, resultado: 'ja-enviado', nfeDocId: nota.id, destino,
          motivo: `Já foi enviada pra ${destino} em ${ja.enviadoEm.toLocaleString('pt-BR')}. Use "reenviar" se for de propósito.`,
        };
      }
    }

    // O PDF é gerado ANTES da trava do kill-switch: em simulação a gente quer
    // saber se o DANFE sairia — descobrir que ele quebra só no dia de ligar
    // seria descobrir tarde.
    let pdf: { buffer: Buffer; filename: string };
    try {
      pdf = await this.danfe.generateForDoc(nota.id);
    } catch (e: any) {
      return {
        ok: false, resultado: 'falha', nfeDocId: nota.id, destino,
        motivo: `Não consegui gerar o DANFE: ${e?.message || e}`,
      };
    }

    const volumes = pedido.pickOrders.length;
    const assunto = `Sua nota fiscal — pedido ${pedido.wcOrderNumber || ''}`.trim();
    const html = this.montarEmail({
      clienteNome: pedido.customerName,
      pedidoNumero: pedido.wcOrderNumber,
      lojaNome: card.store?.name ?? null,
      numero: nota.numero,
      serie: nota.serie,
      chave: nota.chave,
      volumes,
    });

    if (!this.ligado) {
      this.logger.log(
        `[nfe-envio] SIMULADO (NFE_ENVIO_CLIENTE≠1) — NF ${nota.numero}/${nota.serie} iria pra ${destino} ` +
          `(${pdf.buffer.length} bytes de PDF)`,
      );
      return {
        ok: true, resultado: 'simulado', nfeDocId: nota.id, destino,
        numero: nota.numero, serie: nota.serie, pdfBytes: pdf.buffer.length, assunto,
        motivo: 'Módulo desligado (NFE_ENVIO_CLIENTE≠1) — nada foi enviado. Isto é o que sairia.',
      };
    }

    const enviado = await this.email.send(destino, assunto, html, undefined, [
      { filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' },
    ]);

    await this.prisma.nfeEnvioCliente.create({
      data: {
        nfeDocId: nota.id,
        orderId: pedido.id,
        pickOrderId: card.id,
        canal: 'email',
        destino,
        status: enviado ? 'sent' : 'failed',
        erro: enviado ? null : 'EmailService devolveu false (SMTP não configurado ou recusou)',
        enviadoPor: opts.userId ?? null,
      },
    });

    if (!enviado) {
      return {
        ok: false, resultado: 'falha', nfeDocId: nota.id, destino,
        motivo: 'O e-mail não saiu. Conferir SMTP_FROM/SMTP_USER (remetente sem endereço derruba o canal inteiro).',
      };
    }

    this.logger.log(`[nfe-envio] NF ${nota.numero}/${nota.serie} enviada pra ${destino}`);
    return {
      ok: true, resultado: 'enviado', nfeDocId: nota.id, destino,
      numero: nota.numero, serie: nota.serie, pdfBytes: pdf.buffer.length, assunto,
    };
  }

  /** Manda a nota de TODOS os cards despachados de um pedido. */
  async enviarPorPedido(
    orderId: string,
    opts: { force?: boolean; userId?: string | null } = {},
  ): Promise<EnvioNfeResultado[]> {
    const cards = await this.prisma.pickOrder.findMany({
      where: { orderId, status: { in: ['shipped', 'delivered'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!cards.length) {
      throw new BadRequestException('Pedido não tem envio despachado — não há nota pra mandar.');
    }
    const out: EnvioNfeResultado[] = [];
    for (const c of cards) out.push(await this.enviarPorCard(c.id, opts));
    return out;
  }

  /** O que já foi enviado desta nota — pra tela mostrar "enviada em X". */
  async historico(nfeDocId: string) {
    return this.prisma.nfeEnvioCliente.findMany({
      where: { nfeDocId },
      orderBy: { enviadoEm: 'desc' },
      select: { id: true, canal: true, destino: true, status: true, erro: true, enviadoEm: true, enviadoPor: true },
    });
  }

  /**
   * Texto do e-mail. Sem imagem e sem link externo de propósito: mensagem com
   * anexo fiscal e link de rastreador é o padrão que filtro de spam pune, e a
   * cliente PRECISA receber esta.
   */
  private montarEmail(p: {
    clienteNome: string | null;
    pedidoNumero: string | null;
    lojaNome: string | null;
    numero: number;
    serie: string;
    chave: string | null;
    volumes: number;
  }): string {
    const primeiroNome = String(p.clienteNome || '').trim().split(/\s+/)[0] || 'Olá';
    // Pedido dividido: a cliente recebe uma nota por loja. Dizer isso ANTES
    // evita que o segundo e-mail pareça engano ou cobrança repetida.
    const aviso =
      p.volumes > 1
        ? `<p style="margin:0 0 16px">Seu pedido foi enviado em <strong>${p.volumes} volumes</strong>, de lojas diferentes — ` +
          `por isso você recebe uma nota para cada um. Esta é a ${p.lojaNome ? `da loja <strong>${p.lojaNome}</strong>` : 'deste volume'}.</p>`
        : '';
    return `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#17181A;line-height:1.6;max-width:520px">
        <p style="margin:0 0 16px">${primeiroNome}, tudo bem?</p>
        <p style="margin:0 0 16px">
          Segue em anexo a nota fiscal${p.pedidoNumero ? ` do seu pedido <strong>${p.pedidoNumero}</strong>` : ''}.
        </p>
        ${aviso}
        <table style="border-collapse:collapse;margin:0 0 16px;font-size:14px">
          <tr><td style="padding:2px 12px 2px 0;color:#6C6E73">Nota</td><td><strong>${p.numero}</strong> · série ${p.serie}</td></tr>
          ${p.chave ? `<tr><td style="padding:2px 12px 2px 0;color:#6C6E73;vertical-align:top">Chave de acesso</td><td style="font-family:monospace;font-size:12px;word-break:break-all">${p.chave}</td></tr>` : ''}
        </table>
        <p style="margin:0 0 16px;color:#6C6E73;font-size:13px">
          Guarde este e-mail: a nota é o documento da sua compra e serve para troca e garantia.
          Com a chave de acesso você também consulta a nota no portal da NF-e.
        </p>
        <p style="margin:0">Obrigado pela preferência!<br><strong>Lurd's Plus Size</strong></p>
      </div>
    `.trim();
  }
}
