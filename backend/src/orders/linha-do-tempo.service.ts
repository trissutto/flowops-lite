import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * LINHA DO TEMPO + RAIO-X DO PEDIDO (26/08/2026 — contrato do dono).
 *
 * Os casos ON-000106 e LP-000244 provaram que ninguém enxerga o pedido
 * fracionado: o estado mora espalhado em order_history, pick_orders,
 * order_items, pick_order_scans, pick_order_item_reports,
 * realignment_shipments e rastreio_objetos — e cada tela lê UM pedaço.
 * Campinas foi acusada de não ter enviado o que já tinha postado porque a
 * tela do card mostrava outra fatia da verdade.
 *
 * Este serviço NÃO grava nada. Ele costura as fontes que já existem em duas
 * respostas:
 *
 *   `pecas`   — RAIO-X: pra cada peça do pedido, ONDE ELA ESTÁ AGORA
 *               (card de loja, caixa em trânsito, enviada, sem dono...).
 *               Regra de ouro: peça sem dono aparece em VERMELHO, nunca some.
 *   `eventos` — tudo que aconteceu, em ordem, com QUEM fez. Registro antigo
 *               sem autor sai como "sem autor (registro antigo)" — nunca
 *               inventamos nome.
 */

export interface PecaRaioX {
  orderItemId: string;
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  quantity: number;
  /** com_loja | na_caixa | enviada | entregue | sem_dono | reportada | cancelada */
  estado: string;
  /** Frase pronta pra tela ("na caixa REM-x a caminho de LIMEIRA"). */
  onde: string;
  /** vermelho = parado/sem dono · amarelo = em movimento · verde = resolvido */
  cor_semaforo: 'vermelho' | 'amarelo' | 'verde';
  storeCode: string | null;
  storeName: string | null;
  trackingCode: string | null;
}

export interface EventoLinhaDoTempo {
  em: string; // ISO
  /** Nome de quem fez. Null = sistema ou registro antigo sem autor. */
  quem: string | null;
  /** humano | loja | sistema | sem_autor */
  tipoAtor: string;
  /** pedido | bipe | reporte | caixa | rastreio */
  origem: string;
  titulo: string;
  detalhe: string | null;
}

@Injectable()
export class LinhaDoTempoService {
  constructor(private readonly prisma: PrismaService) {}

  async porWcOrderId(wcOrderId: number) {
    const order: any = await (this.prisma as any).order.findUnique({
      where: { wcOrderId },
      include: {
        items: true,
        pickOrders: { include: { store: { select: { code: true, name: true } } } },
        history: { orderBy: { createdAt: 'asc' }, take: 300 },
      },
    });
    if (!order) return { found: false as const };

    const scans: any[] = await (this.prisma as any).pickOrderScan.findMany({
      where: { orderId: order.id },
      orderBy: { scannedAt: 'asc' },
    });
    const reports: any[] = await (this.prisma as any).pickOrderItemReport.findMany({
      where: { orderId: order.id },
      orderBy: { reportedAt: 'asc' },
    });
    const caixas: any[] = await (this.prisma as any).realignmentShipment.findMany({
      where: { orderId: order.id },
      orderBy: { openedAt: 'asc' },
    });

    // Rastreio: código do Order + de cada card (pedido dividido = 1 por caixa).
    const codigos = new Set<string>();
    if (order.trackingCode) codigos.add(order.trackingCode);
    for (const p of order.pickOrders) if (p.trackingCode) codigos.add(p.trackingCode);
    const rastreios: any[] = codigos.size
      ? await (this.prisma as any).rastreioObjeto.findMany({
          where: { codigo: { in: Array.from(codigos) } },
        })
      : [];

    // ── QUEM: resolve todo user_id que aparece em qualquer fonte ──────────
    const userIds = new Set<string>();
    const add = (v: any) => v && typeof v === 'string' && userIds.add(v);
    order.history.forEach((h: any) => add(h.userId));
    scans.forEach((s) => { add(s.scannedBy); add(s.revertedBy); });
    reports.forEach((r) => { add(r.reportedBy); add(r.resolvedBy); });
    caixas.forEach((c) => { add(c.openedByUserId); add(c.sentByUserId); add(c.receivedByUserId); });
    const users: any[] = userIds.size
      ? await (this.prisma as any).user.findMany({
          where: { id: { in: Array.from(userIds) } },
          select: {
            id: true, name: true, email: true, role: true,
            store: { select: { code: true, name: true } },
          },
        })
      : [];
    const porId = new Map(users.map((u) => [u.id, u]));
    const quemDe = (userId: string | null | undefined): { quem: string | null; tipoAtor: string } => {
      if (!userId) return { quem: null, tipoAtor: 'sem_autor' };
      const u = porId.get(userId);
      if (!u) return { quem: null, tipoAtor: 'sem_autor' }; // user apagado — não inventa
      if (u.role === 'store') {
        const loja = u.store ? `loja ${u.store.code} (${u.store.name})` : u.name;
        return { quem: loja, tipoAtor: 'loja' };
      }
      return { quem: u.name || u.email, tipoAtor: 'humano' };
    };

    const pecaTxt = (x: { ref?: any; cor?: any; tamanho?: any; sku?: any }) =>
      [x.ref, x.cor, x.tamanho].filter(Boolean).join(' ') || String(x.sku || '');

    // ── EVENTOS ───────────────────────────────────────────────────────────
    const eventos: EventoLinhaDoTempo[] = [];

    for (const h of order.history) {
      const { quem, tipoAtor } = quemDe(h.userId);
      eventos.push({
        em: h.createdAt.toISOString(),
        quem,
        // Nota de robô sem autor é "sistema"; nota humana antiga sem autor é
        // indistinguível — o front rotula sem_autor como "sem autor (registro antigo)".
        tipoAtor,
        origem: 'pedido',
        titulo:
          h.fromStatus && h.toStatus && h.fromStatus !== h.toStatus
            ? `${h.fromStatus} → ${h.toStatus}`
            : 'registro',
        detalhe: h.note || null,
      });
    }

    for (const s of scans) {
      const q = quemDe(s.scannedBy);
      eventos.push({
        em: s.scannedAt.toISOString(),
        quem: q.quem,
        tipoAtor: q.tipoAtor === 'sem_autor' ? 'loja' : q.tipoAtor,
        origem: 'bipe',
        titulo: `Peça bipada na loja ${s.storeCode}`,
        detalhe: `${s.sku}${s.stockDecreasedAt ? ' · estoque baixado' : s.debitSkippedReason ? ` · baixa pulada (${s.debitSkippedReason})` : ''}`,
      });
      if (s.revertedAt) {
        const rq = quemDe(s.revertedBy);
        const motivo: Record<string, string> = {
          undo: 'desfazer da própria loja',
          swap: 'troca de peça',
          issue: 'problema reportado',
          remove_card: 'card removido pela retaguarda',
          reroute: 'reroteamento',
          order_cancelled: 'pedido cancelado',
          store_swap: 'troca de loja',
        };
        eventos.push({
          em: s.revertedAt.toISOString(),
          quem: rq.quem,
          tipoAtor: rq.tipoAtor === 'sem_autor' ? 'sistema' : rq.tipoAtor,
          origem: 'bipe',
          titulo: `Bipe desfeito (${motivo[s.revertReason] ?? s.revertReason ?? '—'})`,
          detalhe: `${s.sku} devolvida ao estoque da loja ${s.storeCode}`,
        });
      }
    }

    for (const r of reports) {
      const q = quemDe(r.reportedBy);
      const motivo: Record<string, string> = {
        out_of_stock: 'sem estoque físico',
        defective: 'defeito',
        divergence: 'divergência',
        other: 'outro',
      };
      eventos.push({
        em: r.reportedAt.toISOString(),
        quem: q.quem,
        tipoAtor: q.tipoAtor === 'sem_autor' ? 'loja' : q.tipoAtor,
        origem: 'reporte',
        titulo: `Loja ${r.storeCode} reportou a peça ${pecaTxt(r)}`,
        detalhe:
          `${motivo[r.reason] ?? r.reason}${r.note ? ` — ${r.note}` : ''}` +
          (r.stockDecreasedAt ? ' · quantidade fantasma baixada do estoque' : ''),
      });
      if (r.resolvedAt) {
        const rq = quemDe(r.resolvedBy);
        eventos.push({
          em: r.resolvedAt.toISOString(),
          quem: rq.quem,
          tipoAtor: rq.tipoAtor,
          origem: 'reporte',
          titulo: `Reporte da peça ${pecaTxt(r)} resolvido`,
          detalhe: null,
        });
      }
    }

    for (const c of caixas) {
      const abriu = quemDe(c.openedByUserId);
      eventos.push({
        em: c.openedAt.toISOString(),
        quem: abriu.quem,
        tipoAtor: abriu.tipoAtor === 'sem_autor' ? 'sistema' : abriu.tipoAtor,
        origem: 'caixa',
        titulo: `Caixa ${c.code} aberta: ${c.fromStoreName} → ${c.toStoreName}`,
        detalhe: c.notes || null,
      });
      if (c.sentAt) {
        const enviou = quemDe(c.sentByUserId);
        eventos.push({
          em: c.sentAt.toISOString(),
          quem: enviou.quem,
          tipoAtor: enviou.tipoAtor === 'sem_autor' ? 'sistema' : enviou.tipoAtor,
          origem: 'caixa',
          titulo: `Caixa ${c.code} DESPACHADA pra ${c.toStoreName}`,
          detalhe: c.trackingCode ? `rastreio ${c.trackingCode}` : 'transporte próprio/carro da rede',
        });
      }
      if (c.receivedAt) {
        const recebeu = quemDe(c.receivedByUserId);
        eventos.push({
          em: c.receivedAt.toISOString(),
          quem: recebeu.quem,
          tipoAtor: recebeu.tipoAtor === 'sem_autor' ? 'loja' : recebeu.tipoAtor,
          origem: 'caixa',
          titulo: `Caixa ${c.code} RECEBIDA por ${c.toStoreName}`,
          detalhe: c.missingQty ? `⚠ ${c.missingQty} peça(s) faltando na conferência` : null,
        });
      }
    }

    for (const r of rastreios) {
      if (!r.eventoEm) continue;
      eventos.push({
        em: r.eventoEm.toISOString(),
        quem: null,
        tipoAtor: 'sistema',
        origem: 'rastreio',
        titulo: `${r.codigo}: ${r.status ?? '—'}`,
        detalhe: [r.local, r.entregue ? 'ENTREGUE' : null].filter(Boolean).join(' · ') || null,
      });
    }

    eventos.sort((a, b) => (a.em < b.em ? 1 : a.em > b.em ? -1 : 0)); // mais novo primeiro

    // ── RAIO-X: onde está cada peça AGORA ─────────────────────────────────
    const cardsAtivos = ['new', 'separating', 'separated', 'ready'];
    const rastreioPorCodigo = new Map(rastreios.map((r: any) => [r.codigo, r]));
    // Card "do momento" por loja: o mais novo não-cancelado.
    const cardDaLoja = (storeId: string | null) => {
      if (!storeId) return null;
      const doStore = order.pickOrders
        .filter((p: any) => p.storeId === storeId)
        .sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : -1));
      return doStore[0] ?? null;
    };
    const caixaDoCard = (pickOrderId: string) =>
      caixas.filter((c) => c.pickOrderId === pickOrderId && c.status !== 'cancelled').pop() ?? null;

    const pecas: PecaRaioX[] = order.items.map((it: any) => {
      const base = {
        orderItemId: it.id,
        sku: it.sku,
        ref: it.ref ?? null,
        cor: it.cor ?? null,
        tamanho: it.tamanho ?? null,
        quantity: it.quantity,
        trackingCode: null as string | null,
      };
      if (order.status === 'cancelled') {
        return { ...base, estado: 'cancelada', onde: 'pedido cancelado', cor_semaforo: 'verde' as const, storeCode: null, storeName: null };
      }
      const card = cardDaLoja(it.assignedStoreId);
      if (card) {
        const loja = { storeCode: card.store?.code ?? null, storeName: card.store?.name ?? null };
        if (card.status === 'shipped' || card.status === 'delivered') {
          const ras: any = card.trackingCode ? rastreioPorCodigo.get(card.trackingCode) : null;
          const entregue = order.status === 'delivered' || ras?.entregue;
          return {
            ...base, ...loja,
            estado: entregue ? 'entregue' : 'enviada',
            trackingCode: card.trackingCode ?? null,
            onde: entregue
              ? `entregue à cliente (enviada por ${loja.storeName})`
              : `enviada por ${loja.storeName}` +
                (card.trackingCode ? ` · ${card.trackingCode}` : '') +
                (ras?.status ? ` · ${ras.status}${ras.local ? ` (${ras.local})` : ''}` : ''),
            cor_semaforo: entregue ? 'verde' : 'amarelo',
          };
        }
        if (cardsAtivos.includes(card.status)) {
          // Feeder de juntada: a peça pode estar DENTRO de uma caixa viajando.
          if (card.isTransfer && card.transferToStoreCode) {
            const cx = caixaDoCard(card.id);
            if (cx?.status === 'in_transit') {
              return {
                ...base, ...loja,
                estado: 'na_caixa',
                trackingCode: cx.trackingCode ?? null,
                onde: `na caixa ${cx.code}, a caminho da loja ${cx.toStoreName} (saiu de ${cx.fromStoreName})`,
                cor_semaforo: 'amarelo',
              };
            }
            if (cx?.status === 'received') {
              return {
                ...base, ...loja,
                estado: 'na_caixa',
                onde: `chegou na loja âncora ${cx.toStoreName} (caixa ${cx.code}) — aguardando envio final`,
                cor_semaforo: 'amarelo',
              };
            }
            return {
              ...base, ...loja,
              estado: 'com_loja',
              onde: `com a loja ${loja.storeName} (${card.status}) — vai mandar pra loja ${card.transferToStoreCode} juntar`,
              cor_semaforo: 'amarelo',
            };
          }
          const rotulo: Record<string, string> = {
            new: 'na fila, ninguém começou',
            separating: 'sendo separada',
            separated: 'separada, aguardando envio',
            ready: 'pronta pra despachar',
          };
          return {
            ...base, ...loja,
            estado: card.issueReason ? 'reportada' : 'com_loja',
            onde: card.issueReason
              ? `loja ${loja.storeName} reportou problema (${card.issueReason}) — aguardando decisão da matriz`
              : `com a loja ${loja.storeName} — ${rotulo[card.status] ?? card.status}`,
            cor_semaforo: card.issueReason ? 'vermelho' : 'amarelo',
          };
        }
      }
      // Sem loja atribuída — mas o BIPE ÓRFÃO é evidência (é pra isso que a
      // linha sobrevive ao delete do card): se esta peça tem bipe não
      // estornado num card que JÁ ENVIOU, ela está fisicamente na caixa que
      // viajou. Foi o buraco do ON-000106: o remove zerou a loja das peças e
      // as 2 que Campinas tinha postado viraram "sem dono" na tela.
      const cardPorId = new Map(order.pickOrders.map((p: any) => [p.id, p]));
      const bipeEnviado = scans.find((s) => {
        if (s.sku !== it.sku || !s.stockDecreasedAt || s.stockIncreasedAt) return false;
        const c: any = cardPorId.get(s.pickOrderId);
        return c && (c.status === 'shipped' || c.status === 'delivered');
      });
      if (bipeEnviado) {
        const c: any = cardPorId.get(bipeEnviado.pickOrderId);
        const ras: any = c?.trackingCode ? rastreioPorCodigo.get(c.trackingCode) : null;
        const entregue = order.status === 'delivered' || ras?.entregue;
        return {
          ...base,
          estado: entregue ? 'entregue' : 'enviada',
          trackingCode: c?.trackingCode ?? null,
          onde:
            (entregue ? 'entregue à cliente — ' : '') +
            `enviada pela loja ${c?.store?.name ?? bipeEnviado.storeCode} (prova: bipe de ${bipeEnviado.scannedAt.toISOString().slice(0, 10)})` +
            (c?.trackingCode ? ` · ${c.trackingCode}` : '') +
            (!entregue && ras?.status ? ` · ${ras.status}` : ''),
          cor_semaforo: entregue ? ('verde' as const) : ('amarelo' as const),
          storeCode: c?.store?.code ?? bipeEnviado.storeCode,
          storeName: c?.store?.name ?? null,
        };
      }
      // Reporte por peça em aberto explica o porquê.
      const rep = reports.find(
        (r) => !r.resolvedAt && (r.orderItemId === it.id || r.sku === it.sku),
      );
      if (rep) {
        return {
          ...base,
          estado: 'reportada',
          onde: `reportada pela loja ${rep.storeCode} (${rep.reason === 'out_of_stock' ? 'sem estoque físico' : rep.reason}) — SEM LOJA, matriz precisa decidir`,
          cor_semaforo: 'vermelho',
          storeCode: null, storeName: null,
        };
      }
      return {
        ...base,
        estado: 'sem_dono',
        onde: 'SEM DONO — nenhuma loja está separando esta peça (matriz precisa decidir)',
        cor_semaforo: 'vermelho',
        storeCode: null, storeName: null,
      };
    });

    // ── ALERTAS de pedido doente (os mesmos invariantes da sentinela) ─────
    const alertas: string[] = [];
    const semDono = pecas.filter((p) => p.cor_semaforo === 'vermelho').length;
    if (semDono) alertas.push(`${semDono} peça(s) sem dono ou reportada(s) — ninguém vai separar até a matriz decidir.`);
    for (const p of order.pickOrders) {
      if (!p.isTransfer || !p.transferToStoreCode) continue;
      if (!cardsAtivos.concat('shipped').includes(p.status)) continue;
      const ancoraViva = order.pickOrders.some(
        (a: any) => a.store?.code === p.transferToStoreCode && !a.isTransfer && cardsAtivos.includes(a.status),
      );
      if (!ancoraViva) {
        const cx = caixaDoCard(p.id);
        alertas.push(
          `Caixa da loja ${p.store?.code} aponta pra âncora ${p.transferToStoreCode}, que NÃO tem mais card neste pedido` +
            (cx ? ` (${cx.code} está "${cx.status}")` : '') + ' — reescolher a âncora ou redirecionar a caixa.',
        );
      }
    }
    const porLojaAtivos = new Map<string, number>();
    for (const p of order.pickOrders) {
      if (!cardsAtivos.includes(p.status)) continue;
      const k = p.store?.code ?? p.storeId;
      porLojaAtivos.set(k, (porLojaAtivos.get(k) ?? 0) + 1);
    }
    for (const [loja, n] of porLojaAtivos) {
      if (n > 1) alertas.push(`Loja ${loja} tem ${n} cards ativos no MESMO pedido — a tela dela mistura as peças (caso ON-000106).`);
    }

    return { found: true as const, pecas, eventos, alertas };
  }
}
