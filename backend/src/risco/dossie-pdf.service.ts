import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { RiscoService } from './risco.service';
import { ChargebackService } from './chargeback.service';

/**
 * DOSSIÊ DE CHARGEBACK — o documento que a gente manda pro adquirente pra
 * contestar (item 17, o que o documento chama de "MUITO importante").
 *
 * O QUE ELE É: a reunião, num PDF só, de tudo que o sistema JÁ SABE sobre a
 * venda — pedido, transação, cliente, entrega, nota, rastreio e a prova de
 * entrega. Hoje isso existe espalhado em cinco telas e é remontado à mão a
 * cada contestação, com prazo correndo.
 *
 * O QUE ELE NÃO É — e essa é a parte que o documento fez questão de deixar
 * escrita: ele NÃO acusa. A seção de padrão transacional descreve relações
 * objetivas ("outro pedido anterior relacionado ao mesmo telefone e endereço,
 * posteriormente objeto de chargeback") e para por aí. A palavra "fraude" não
 * é gerada por este código em lugar nenhum. Quem lê tira a conclusão; o
 * documento entrega o fato.
 *
 * DADO QUE NÃO EXISTE APARECE COMO "não disponível", nunca como invenção. Um
 * dossiê com dado inventado é pior que nenhum dossiê: ele perde a contestação
 * E queima a credibilidade das próximas.
 */

const MARROM = '#5e3823';
const COBRE = '#985d3f';
const CINZA = '#666666';
const LINHA = '#c87f5e';
const NAO_DISPONIVEL = 'não disponível';

@Injectable()
export class DossiePdfService {
  private readonly logger = new Logger(DossiePdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly risco: RiscoService,
    private readonly chargebacks: ChargebackService,
  ) {}

  async gerar(orderId: string): Promise<{ buffer: Buffer; filename: string }> {
    const dados = await this.coletar(orderId);
    const buffer = await this.montar(dados);
    const nome = String(dados.order.wcOrderNumber || orderId.slice(-8)).replace(/[^\w-]/g, '');
    return { buffer, filename: `dossie-chargeback-${nome}.pdf` };
  }

  /** Junta, de uma vez, tudo que o dossiê precisa. */
  private async coletar(orderId: string) {
    const order = await (this.prisma as any).order.findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        pickOrders: true,
      },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado');

    const pickIds: string[] = (order.pickOrders || []).map((p: any) => p.id);
    const codigos = Array.from(
      new Set(
        [order.trackingCode, ...(order.pickOrders || []).map((p: any) => p.trackingCode)].filter(
          Boolean,
        ),
      ),
    ) as string[];

    const [notas, rastreios, cbs, analise] = await Promise.all([
      pickIds.length
        ? (this.prisma as any).nfeDoc.findMany({
            where: { shipmentId: { in: pickIds.map((id) => `envio:${id}`) } },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      codigos.length
        ? (this.prisma as any).rastreioObjeto.findMany({ where: { codigo: { in: codigos } } })
        : Promise.resolve([]),
      this.chargebacks.doPedido(orderId),
      this.risco.analisar(orderId, { persistir: false }).catch(() => null),
    ]);

    return {
      order,
      pay: this.parse(order.paymentInfo) || {},
      checkout: this.parse(order.checkoutInfo) || {},
      envio: this.parse(order.shippingAddress) || {},
      notas,
      rastreios,
      chargebacks: cbs,
      analise,
    };
  }

  private montar(d: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new (PDFDocument as any)({
          size: 'A4',
          margin: 40,
          info: {
            Title: `Dossiê de chargeback — pedido ${d.order.wcOrderNumber || ''}`,
            Author: "Lurd's Plus Size",
            Subject: 'Documentação de defesa de contestação',
          },
        });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.cabecalho(doc, d);
        this.blocoPedidoETransacao(doc, d);
        this.blocoCliente(doc, d);
        this.blocoProdutos(doc, d);
        this.blocoExpedicao(doc, d);
        this.blocoPadraoTransacional(doc, d);
        this.blocoChargebacks(doc, d);
        this.rodape(doc, d);

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── Blocos ────────────────────────────────────────────────────────────

  private cabecalho(doc: any, d: any) {
    doc.fontSize(18).fillColor(MARROM).font('Helvetica-Bold').text("LURD'S PLUS SIZE", { align: 'center' });
    doc.moveDown(0.2);
    doc
      .fontSize(11)
      .fillColor(CINZA)
      .font('Helvetica')
      .text('Dossiê de defesa — contestação de cobrança', { align: 'center' });
    doc.moveDown(0.3);
    doc
      .fontSize(14)
      .fillColor(COBRE)
      .font('Helvetica-Bold')
      .text(`Pedido ${d.order.wcOrderNumber || d.order.id.slice(-8)}`, { align: 'center' });
    this.regua(doc);
  }

  private blocoPedidoETransacao(doc: any, d: any) {
    const tx = d.pay?.transacao || {};
    this.titulo(doc, 'Pedido e transação');
    this.par(doc, [
      ['Número do pedido', d.order.wcOrderNumber || d.order.id.slice(-8)],
      ['Data do pedido', this.dataHora(d.order.wcDateCreated || d.order.createdAt)],
      ['Pagamento confirmado em', this.dataHora(d.order.paidAt)],
      ['Valor total', this.dinheiro(d.order.totalAmount)],
      ['Forma de pagamento', this.formaPagamento(d.pay)],
      ['Parcelas', d.pay?.installments ? String(d.pay.installments) : NAO_DISPONIVEL],
      ['Bandeira', tx.bandeira || NAO_DISPONIVEL],
      ['Cartão (4 últimos)', tx.ultimos4 ? `**** ${tx.ultimos4}` : NAO_DISPONIVEL],
      ['Titular informado', tx.titular || NAO_DISPONIVEL],
      ['ID da transação (TID)', tx.tid || NAO_DISPONIVEL],
      ['NSU', tx.nsu || NAO_DISPONIVEL],
      ['Código de autorização', tx.autorizacao || NAO_DISPONIVEL],
      ['Status da autorização', tx.status || NAO_DISPONIVEL],
      ['Código de retorno do adquirente', tx.codigoRetorno || NAO_DISPONIVEL],
      ['Antifraude', tx.antifraudeStatus || NAO_DISPONIVEL],
      ['Score do antifraude', tx.antifraudeScore != null ? String(tx.antifraudeScore) : NAO_DISPONIVEL],
      ['Pedido no gateway', d.pay?.gatewayOrderId || NAO_DISPONIVEL],
      ['Cobrança no gateway', d.pay?.gatewayChargeId || NAO_DISPONIVEL],
      ['IP do checkout', d.order.clienteIp || NAO_DISPONIVEL],
    ]);
  }

  private blocoCliente(doc: any, d: any) {
    const e = d.envio || {};
    const entrega = [
      [e.address_1, e.number].filter(Boolean).join(', '),
      e.address_2,
      e.neighborhood,
      [e.city, e.state].filter(Boolean).join('/'),
      e.postcode ? `CEP ${e.postcode}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    this.titulo(doc, 'Cliente, entrega e cobrança');
    this.par(doc, [
      ['Nome', d.order.customerName || NAO_DISPONIVEL],
      ['CPF', d.order.customerCpf || NAO_DISPONIVEL],
      ['E-mail', d.order.customerEmail || NAO_DISPONIVEL],
      ['Telefone', d.order.customerPhone || NAO_DISPONIVEL],
      ['Endereço de entrega', entrega || NAO_DISPONIVEL],
      ['Modalidade', d.order.isPickup ? `Retirada em loja ${d.order.pickupStoreCode || ''}`.trim() : d.order.shippingMethod || 'Entrega'],
      [
        'Endereço de cobrança',
        d.order.billingAddress
          ? String(d.order.billingAddress)
          : 'não coletado separadamente — o checkout usa o endereço de entrega como endereço de cobrança',
      ],
    ]);
  }

  private blocoProdutos(doc: any, d: any) {
    this.titulo(doc, 'Produtos');
    const itens = (d.order.items || []).filter((i: any) => !i.cancelledAt);
    if (!itens.length) {
      this.texto(doc, 'Nenhum item registrado no pedido.');
      return;
    }
    for (const i of itens) {
      const nome = [i.productName || i.sku, i.cor, i.tamanho].filter(Boolean).join(' · ');
      this.texto(
        doc,
        `${i.quantity}× ${nome} — ${this.dinheiro(i.unitPrice)}  (SKU ${i.sku})`,
      );
    }
    const cancelados = (d.order.items || []).filter((i: any) => i.cancelledAt);
    if (cancelados.length) {
      doc.moveDown(0.2);
      this.texto(doc, `Itens cancelados no pedido: ${cancelados.length}.`, CINZA);
    }
  }

  private blocoExpedicao(doc: any, d: any) {
    this.titulo(doc, 'Expedição, nota fiscal e entrega');

    const autorizadas = (d.notas || []).filter((n: any) => n.status === 'authorized');
    if (autorizadas.length) {
      for (const n of autorizadas) {
        this.texto(
          doc,
          `NF-e ${n.numero}/série ${n.serie} — chave ${n.chave || NAO_DISPONIVEL}` +
            (n.protocolo ? ` — protocolo ${n.protocolo}` : '') +
            (n.tpAmb === '2' ? '  [HOMOLOGAÇÃO — sem valor fiscal]' : ''),
        );
      }
    } else {
      this.texto(doc, `Nota fiscal: ${NAO_DISPONIVEL}.`);
    }

    if (!d.rastreios?.length) {
      this.texto(doc, `Rastreamento: ${NAO_DISPONIVEL}.`);
    } else {
      for (const r of d.rastreios) {
        const partes = [
          `Objeto ${r.codigo}`,
          r.provedor ? `(${r.provedor})` : '',
          r.status ? `— ${r.status}` : '',
          r.local ? `em ${r.local}` : '',
          r.eventoEm ? `· ${this.dataHora(r.eventoEm)}` : '',
        ].filter(Boolean);
        this.texto(doc, partes.join(' '));
        if (r.entregue) {
          // O COMPROVANTE DE ENTREGA é a peça mais forte da defesa quando a
          // contestação é "não recebi". Sai destacado.
          doc
            .font('Helvetica-Bold')
            .fillColor(MARROM)
            .text(
              `   ✔ ENTREGA CONFIRMADA pela transportadora em ${this.dataHora(r.entregueEm)}`,
            )
            .font('Helvetica')
            .fillColor('#000');
        }
      }
    }

    if (d.order.deliveredAt) {
      this.texto(doc, `Pedido marcado como ENTREGUE em ${this.dataHora(d.order.deliveredAt)}.`);
    }
    if (d.order.shippedAt) {
      this.texto(doc, `Despachado em ${this.dataHora(d.order.shippedAt)}.`);
    }
  }

  /**
   * A SEÇÃO DELICADA. Só relação objetiva, uma frase por fato, sem adjetivo e
   * sem conclusão. Se não houver relação nenhuma, diz isso — em vez de omitir
   * a seção e deixar parecer que tem algo escondido.
   */
  private blocoPadraoTransacional(doc: any, d: any) {
    this.titulo(doc, 'Evidências complementares — padrão transacional');

    const rel = (d.analise?.relacionados || []).filter((r: any) => r.situacao === 'chargeback');
    if (!rel.length) {
      this.texto(
        doc,
        'Não foram identificados outros pedidos relacionados a este que tenham sido objeto de contestação.',
      );
      return;
    }

    this.texto(
      doc,
      'Os registros abaixo descrevem relações objetivas entre este pedido e pedidos anteriores da mesma base. Não constituem afirmação sobre a conduta da titular — são apresentados como contexto transacional.',
      CINZA,
    );
    doc.moveDown(0.3);

    for (const r of rel) {
      const porQue = (r.relacao || []).join(' e ');
      this.texto(
        doc,
        `• Pedido ${r.numero}, de ${this.data(r.data)}, no valor de ${this.dinheiro(r.valor)}, relacionado a este pelo mesmo ${porQue}, foi posteriormente objeto de contestação (${r.situacaoTexto.toLowerCase()}).`,
      );
    }

    const outros = (d.analise?.relacionados || []).filter((r: any) => r.situacao !== 'chargeback');
    if (outros.length) {
      doc.moveDown(0.2);
      this.texto(
        doc,
        `Há ainda ${outros.length} outro(s) pedido(s) relacionado(s) a este por dados de contato ou entrega, sem contestação registrada.`,
        CINZA,
      );
    }
  }

  private blocoChargebacks(doc: any, d: any) {
    this.titulo(doc, 'Contestações registradas neste pedido');
    if (!d.chargebacks?.length) {
      this.texto(doc, 'Nenhuma contestação registrada neste pedido.');
    } else {
      for (const c of d.chargebacks) {
        this.texto(
          doc,
          `${this.data(c.abertoEm)} — ${this.dinheiro(c.valor)} — situação: ${c.status}` +
            (c.motivo ? ` — motivo informado: ${c.motivo}` : '') +
            (c.plataforma ? ` (${c.plataforma})` : ''),
        );
        if (c.observacoes) this.texto(doc, `   Observação interna: ${c.observacoes}`, CINZA);
      }
    }

    const obs = d.analise?.observacao;
    if (obs) {
      doc.moveDown(0.3);
      this.titulo(doc, 'Observações internas da análise');
      this.texto(doc, String(obs));
    }
  }

  private rodape(doc: any, d: any) {
    doc.moveDown(1);
    this.regua(doc);
    doc
      .fontSize(8)
      .fillColor(CINZA)
      .font('Helvetica')
      .text(
        `Documento gerado automaticamente pelo FlowOps em ${this.dataHora(new Date())} · pedido ${d.order.id}`,
        { align: 'center' },
      );
    doc.moveDown(0.2);
    doc.text(
      'Os dados aqui reunidos são registros do próprio sistema de vendas. Campos assinalados como "não disponível" não são coletados ou não foram informados no momento da compra.',
      { align: 'center' },
    );
  }

  // ── Utilidades de desenho ─────────────────────────────────────────────

  private titulo(doc: any, t: string) {
    this.quebraSePreciso(doc, 90);
    doc.moveDown(0.6);
    doc.fontSize(12).fillColor(MARROM).font('Helvetica-Bold').text(t);
    doc.moveDown(0.25);
    doc.fontSize(9.5).fillColor('#000').font('Helvetica');
  }

  private par(doc: any, linhas: Array<[string, string]>) {
    for (const [k, v] of linhas) {
      this.quebraSePreciso(doc, 40);
      doc
        .fontSize(9.5)
        .fillColor(CINZA)
        .font('Helvetica')
        .text(`${k}: `, { continued: true })
        .fillColor('#000')
        .font('Helvetica-Bold')
        .text(String(v ?? NAO_DISPONIVEL));
    }
    doc.font('Helvetica').fillColor('#000');
  }

  private texto(doc: any, t: string, cor = '#000') {
    this.quebraSePreciso(doc, 40);
    doc.fontSize(9.5).fillColor(cor).font('Helvetica').text(t, { width: 515 });
  }

  private regua(doc: any) {
    doc.moveDown(0.4);
    doc.strokeColor(LINHA).lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fillColor('#000');
  }

  /** Página nova antes de cortar um bloco no meio. */
  private quebraSePreciso(doc: any, espaco: number) {
    if (doc.y + espaco > doc.page.height - doc.page.margins.bottom) doc.addPage();
  }

  // ── Formatação ────────────────────────────────────────────────────────

  private formaPagamento(pay: any): string {
    const m = String(pay?.method || '').toLowerCase();
    if (m === 'card' || m === 'credit_card') return 'Cartão de crédito';
    if (m === 'pix') return 'PIX';
    if (!m) return NAO_DISPONIVEL;
    return m;
  }

  private dinheiro(v: any): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return NAO_DISPONIVEL;
    return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  private data(v: any): string {
    if (!v) return NAO_DISPONIVEL;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? NAO_DISPONIVEL : d.toLocaleDateString('pt-BR');
  }

  private dataHora(v: any): string {
    if (!v) return NAO_DISPONIVEL;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? NAO_DISPONIVEL : d.toLocaleString('pt-BR');
  }

  private parse(t: any): any {
    if (!t) return null;
    if (typeof t === 'object') return t;
    try {
      return JSON.parse(String(t));
    } catch {
      return null;
    }
  }
}
