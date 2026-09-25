/**
 * Gera a mensagem de WhatsApp pra loja separar um pedido.
 * Formatação em Markdown do WhatsApp (*negrito*, _itálico_).
 *
 * `items` é O QUE ESTA LOJA SEPARA — quem monta a lista é a régua
 * `pecas-por-loja.util.ts` (dono, 25/09: cada loja recebe só a peça dela; o
 * pedido inteiro só na retirada na própria loja).
 */
import { totalDePecas } from './pecas-por-loja.util';

export interface WhatsappAddress {
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
}

export interface WhatsappItem {
  sku: string;
  quantity: number;
  productName: string;
  variant?: string;
}

export interface WhatsappMessageInput {
  wcOrderNumber: string;
  orderDateIso: string;
  totalAmount: number;
  paymentMethod: string;
  items: WhatsappItem[];
  customerName: string;
  customerPhone?: string | null;
  customerCpf?: string | null;
  customerEmail?: string | null;
  shippingMethod: string;
  address: WhatsappAddress;
  storeName?: string;
  /** URL da página interna pra loja ver detalhes */
  orderUrl?: string;
  /** Quando true, mensagem vai sinalizar que é TRANSFERÊNCIA pra outra loja. */
  isTransfer?: boolean;
  transferToStoreName?: string | null;
  /**
   * Cliente vai RETIRAR nesta loja (pickup-lock): a mensagem leva o pedido
   * COMPLETO, sem endereço de entrega e sem pedir rastreio (dono, 25/09:
   * "pedido inteiro só na retirada na loja").
   */
  isPickup?: boolean;
  /**
   * Transferência de JUNTADA (loja âncora posta UM pacote pra cliente) — sem
   * isto a loja fonte lia "cliente vai retirar lá", que é a transferência de
   * RETIRADA, e não é o caso.
   */
  isJuntada?: boolean;
  /** Pedido saiu de 2+ lojas: avisa que o resto sai de outra loja (LP-001687). */
  pedidoDividido?: boolean;
  /** Esta loja é a ÂNCORA da juntada: recebe as caixas das outras e posta UM pacote. */
  isJuntadaAncora?: boolean;
}

export function buildWhatsappMessage(i: WhatsappMessageInput): string {
  const L: string[] = [];
  const total = Number(i.totalAmount || 0)
    .toFixed(2)
    .replace('.', ',');
  const date = fmtDatePtBR(i.orderDateIso);

  const retiraAqui = !!i.isPickup && !i.isTransfer;

  // Cabeçalho conta o PAPEL desta loja no pedido
  if (i.isTransfer && i.transferToStoreName && i.isJuntada) {
    L.push(`📦 *JUNTADA — Pedido #${i.wcOrderNumber} — ENVIAR PRA ${i.transferToStoreName.toUpperCase()}*`);
    L.push(
      `⚠️ SEPARAR E MANDAR PRA LOJA *${i.transferToStoreName}* — ela junta com o resto do pedido e posta UM pacote pra cliente. NÃO postar pra cliente daqui.`,
    );
  } else if (i.isTransfer && i.transferToStoreName) {
    L.push(`🚚 *TRANSFERÊNCIA PRA ${i.transferToStoreName.toUpperCase()} — Pedido #${i.wcOrderNumber}*`);
    L.push(`⚠️ SEPARAR E ENVIAR PRA LOJA *${i.transferToStoreName}* — cliente vai retirar lá, NÃO é venda direta.`);
  } else if (retiraAqui) {
    L.push(`🏬 *RETIRADA NA LOJA — Pedido #${i.wcOrderNumber}*`);
    L.push(`⚠️ Cliente vai RETIRAR AQUI na loja — separar e deixar reservado no nome dela. NÃO é pra postar.`);
  } else {
    L.push(`🛍️ *PEDIDO PRA SEPARAR — #${i.wcOrderNumber}*`);
  }
  L.push(`📅 ${date}  ·  ${i.paymentMethod || 'pagamento não informado'}  ·  R$ ${total}`);
  L.push('');

  L.push(`*👤 CLIENTE*`);
  L.push(i.customerName || '—');
  if (i.customerCpf) L.push(`🪪 CPF ${i.customerCpf}`);
  if (i.customerPhone) L.push(`📱 ${formatPhone(i.customerPhone)}`);
  if (i.customerEmail) L.push(`✉️ ${i.customerEmail}`);
  L.push('');

  if (retiraAqui) {
    L.push(`*📍 RETIRADA NA LOJA*`);
    L.push(`🏬 ${i.shippingMethod || 'Retirada em loja'}`);
  } else {
    L.push(`*📍 ENVIO*`);
    L.push(`🚚 ${i.shippingMethod || '—'}`);
  }
  // Endereço só quando ESTA loja posta pra cliente: transferência e retirada
  // não precisam dele (e na retirada ele induzia a loja a postar).
  if (!i.isTransfer && !retiraAqui) {
    const addrLine = [
      i.address.street,
      i.address.number ? `, ${i.address.number}` : '',
    ]
      .filter(Boolean)
      .join('');
    if (addrLine) L.push(addrLine);
    if (i.address.complement) L.push(i.address.complement);
    if (i.address.neighborhood) L.push(i.address.neighborhood);
    const cityLine = [i.address.city, i.address.state].filter(Boolean).join(' / ');
    if (cityLine) L.push(cityLine);
    if (i.address.postcode) L.push(`CEP ${i.address.postcode}`);
  }
  L.push('');

  // Conta PEÇAS (soma das quantidades), não linhas — "peça é peça" (29/08)
  // grava uma linha por peça, e a loja separa peça.
  const n = totalDePecas(i.items);
  const pecas = `${n} ${n === 1 ? 'peça' : 'peças'}`;
  L.push(
    retiraAqui && !i.pedidoDividido
      ? `*📦 PEÇAS DO PEDIDO — separar todas (${pecas})*`
      : `*📦 PEÇAS PRA ESTA LOJA SEPARAR (${pecas})*`,
  );
  for (const item of i.items) {
    L.push(`${item.quantity}× ${item.productName}`);
    const details = [`SKU ${item.sku}`];
    if (item.variant) details.push(item.variant);
    L.push(`   ${details.join('  ·  ')}`);
  }
  // Pedido em 2+ lojas: a lista acima é SÓ a parte desta loja — diz o que
  // acontece com o resto, conforme o papel dela.
  if (i.pedidoDividido) {
    if (i.isJuntadaAncora) {
      L.push('ℹ️ As outras peças deste pedido CHEGAM de outra loja (juntada) — junta tudo e posta UM pacote pra cliente.');
    } else if (retiraAqui) {
      L.push('ℹ️ As outras peças deste pedido chegam de outra loja por transferência — a cliente retira tudo aqui.');
    } else {
      L.push('ℹ️ As outras peças deste pedido saem de outra loja — separar SÓ as de cima.');
    }
  }
  L.push('');

  if (i.isTransfer && i.transferToStoreName && i.isJuntada) {
    L.push(`⚠️ *Após separar, enviar pra LOJA ${i.transferToStoreName}.* Ela fecha o pacote e posta pra cliente.`);
  } else if (i.isTransfer && i.transferToStoreName) {
    L.push(`⚠️ *Após separar, enviar pra LOJA ${i.transferToStoreName}.* Cliente vai buscar lá.`);
  } else if (retiraAqui) {
    L.push('Separar e deixar reservado no nome da cliente — ela vem buscar na loja 🙏');
  } else {
    L.push('Por favor separar e me enviar o código de rastreio ao postar 🙏');
  }
  if (i.orderUrl) {
    L.push('');
    L.push(`_Detalhes: ${i.orderUrl}_`);
  }

  return L.join('\n');
}

/** Gera URL wa.me com a mensagem já encodada. Retorna null se sem whatsapp. */
export function buildWhatsappUrl(whatsapp: string | null | undefined, message: string): string | null {
  if (!whatsapp) return null;
  const clean = whatsapp.replace(/\D/g, '');
  if (!clean) return null;
  return `https://wa.me/${clean}?text=${encodeURIComponent(message)}`;
}

function fmtDatePtBR(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  // 55 13 99621-8277  ou 13 99621-8277
  if (d.length === 13 && d.startsWith('55')) {
    return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  }
  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return raw;
}
