/**
 * Gera a mensagem de WhatsApp pra loja separar um pedido.
 * Formatação em Markdown do WhatsApp (*negrito*, _itálico_).
 */

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
  shippingMethod: string;
  address: WhatsappAddress;
  storeName?: string;
  /** URL da página interna pra loja ver detalhes */
  orderUrl?: string;
}

export function buildWhatsappMessage(i: WhatsappMessageInput): string {
  const L: string[] = [];
  const total = Number(i.totalAmount || 0)
    .toFixed(2)
    .replace('.', ',');
  const date = fmtDatePtBR(i.orderDateIso);

  L.push(`🛍️ *PEDIDO PRA SEPARAR — #${i.wcOrderNumber}*`);
  L.push(`📅 ${date}  ·  ${i.paymentMethod || 'pagamento não informado'}  ·  R$ ${total}`);
  L.push('');

  L.push(`*👤 CLIENTE*`);
  L.push(i.customerName || '—');
  if (i.customerPhone) L.push(`📱 ${formatPhone(i.customerPhone)}`);
  L.push('');

  L.push(`*📍 ENVIO*`);
  L.push(`🚚 ${i.shippingMethod || '—'}`);
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
  L.push('');

  L.push(`*📦 PEÇAS (${i.items.length} item${i.items.length === 1 ? '' : 'ns'})*`);
  for (const item of i.items) {
    L.push(`${item.quantity}× ${item.productName}`);
    const details = [`SKU ${item.sku}`];
    if (item.variant) details.push(item.variant);
    L.push(`   ${details.join('  ·  ')}`);
  }
  L.push('');

  L.push('Por favor separar e me enviar o código de rastreio ao postar 🙏');
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
