import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingService } from '../tracking/tracking.service';

/**
 * order-status.service.ts — "MEUS PEDIDOS" público (cliente consulta sozinha).
 *
 * A cliente entra com CELULAR + CPF e vê todos os pedidos dela — site e live
 * juntos, direto da tabela Order do Flow (fonte única dos dois trilhos).
 * Linha do tempo amigável: Pago → Em separação → Postado → Entregue, com
 * rastreio dos Correios ao vivo (LinkeTrack) sob demanda.
 *
 * Segurança (mesmo padrão do portal de trocas / sacolinha da live):
 *  - identidade = CPF completo + celular (dois fatores que só a cliente tem);
 *  - erro GENÉRICO (não diferencia "não existe" de "não confere");
 *  - nunca devolve endereço completo/PII além do necessário;
 *  - rastreio ao vivo só por pedido, sob clique (protege a cota LinkeTrack).
 */

function onlyDigits(v: any): string {
  return String(v || '').replace(/\D/g, '');
}

/** Compara celulares pelos últimos 8 dígitos (tolera DDD/9º dígito/+55). */
function phoneMatch(a: string, b: string): boolean {
  const da = onlyDigits(a);
  const db = onlyDigits(b);
  if (da.length < 8 || db.length < 8) return false;
  return da.slice(-8) === db.slice(-8);
}

/** Etapa da linha do tempo a partir do status interno do Order. */
function mapEtapa(status: string): { etapa: number; label: string } {
  switch (String(status)) {
    case 'pending':
    case 'routing':
    case 'awaiting_stock':
      return { etapa: 1, label: 'Em separação' };
    case 'separating':
      return { etapa: 1, label: 'Em separação' };
    case 'ready':
      return { etapa: 2, label: 'Pronto' };
    case 'shipped':
      return { etapa: 2, label: 'Postado' };
    case 'delivered':
      return { etapa: 3, label: 'Entregue' };
    case 'cancelled':
      return { etapa: -1, label: 'Cancelado' };
    default:
      return { etapa: 0, label: 'Confirmado' };
  }
}

@Injectable()
export class OrderStatusService {
  private readonly logger = new Logger(OrderStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: TrackingService,
  ) {}

  /** Busca + valida identidade. Lança erro genérico quando não casa. */
  private async findOrdersFor(celular: string, cpf: string) {
    const tel = onlyDigits(celular);
    const cpfDigits = onlyDigits(cpf);
    if (tel.length < 10 || cpfDigits.length !== 11) {
      throw new BadRequestException('Informe o celular com DDD e o CPF completo.');
    }
    const cpfFmt = `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`;

    const orders = await (this.prisma as any).order.findMany({
      where: { customerCpf: { in: [cpfDigits, cpfFmt] } },
      include: { items: { select: { productName: true, sku: true, quantity: true, unitPrice: true } } },
      orderBy: [{ wcDateCreated: 'desc' }, { createdAt: 'desc' }],
      take: 30,
    });

    // Celular confere quando o pedido TEM celular; pedido sem celular gravado
    // passa pelo CPF completo (não dá pra conferir o que não existe).
    const list = (orders as any[]).filter(
      (o) => !onlyDigits(o.customerPhone) || phoneMatch(o.customerPhone, tel),
    );
    if (!list.length) {
      throw new NotFoundException(
        'Não encontramos pedidos com esses dados. Confira o celular e o CPF usados na compra.',
      );
    }
    return list;
  }

  async lookup(input: { celular: string; cpf: string }) {
    const orders = await this.findOrdersFor(input.celular, input.cpf);
    const primeiroNome = String(orders[0].customerName || '').trim().split(/\s+/)[0] || null;

    return {
      ok: true,
      nome: primeiroNome,
      pedidos: orders.map((o: any) => {
        const { etapa, label } = mapEtapa(o.status);
        return {
          id: o.id,
          numero: o.wcOrderNumber || String(o.wcOrderId),
          origem: o.source === 'live' ? 'Live' : 'Site',
          data: o.wcDateCreated || o.createdAt,
          total: o.totalAmount,
          etapa,
          statusLabel: label,
          isPickup: !!o.isPickup,
          pickupStoreCode: o.pickupStoreCode || null,
          shippingMethod: o.shippingMethod || null,
          trackingCode: o.trackingCode || null,
          carrier: o.carrier || 'Correios',
          items: (o.items || []).map((it: any) => ({
            nome: it.productName || it.sku,
            qtd: it.quantity,
          })),
        };
      }),
    };
  }

  /** Rastreio ao vivo de UM pedido (mesma identidade; protege cota do provedor). */
  async rastreio(input: { celular: string; cpf: string; orderId: string }) {
    const orders = await this.findOrdersFor(input.celular, input.cpf);
    const order = orders.find((o: any) => o.id === String(input.orderId || ''));
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    if (!order.trackingCode) {
      throw new BadRequestException('Este pedido ainda não tem código de rastreio.');
    }
    const t = await this.tracking.fetchTracking(order.trackingCode, order.carrier || undefined);
    return {
      ok: !t.error,
      code: t.code,
      delivered: t.delivered,
      lastStatus: t.lastStatus,
      events: t.events.slice(0, 15),
      error: t.error || null,
    };
  }
}
