/**
 * Classifica texto do método de envio do WooCommerce em categorias visuais.
 *
 * O WC devolve strings bem variadas conforme o plugin:
 *  - "SEDEX - 3 dias úteis"
 *  - "PAC (via Correios) - 5-8 dias"
 *  - "Retirar Gratuitamente na Loja de Piracicaba"
 *  - "Jadlog .COM"
 *
 * Essa função normaliza e bate keywords pra devolver:
 *  - kind: categoria padrão pra cor/icone
 *  - label: rótulo curto padronizado (SEDEX, PAC, RETIRADA, ENVIO)
 *  - short: versão curta pra UI estreita
 *  - color: classes Tailwind bg+text (borderless — adicione border/ring na call-site se precisar)
 *  - printColor: hex pra térmica monocromática (sempre '#000' pra garantir visibilidade)
 *
 * Uso típico:
 *   const m = classifyShipping(order.shippingMethod);
 *   <span className={m.color}>{m.label}</span>
 */

export type ShippingKind = 'sedex' | 'pac' | 'pickup' | 'transportadora' | 'other';

export interface ShippingBadge {
  kind: ShippingKind;
  label: string;
  short: string;
  /** Tailwind classes: bg + text (ex: 'bg-red-100 text-red-800'). Sem borda. */
  color: string;
  /** Classes pra badge em destaque (mais forte, cor sólida). */
  colorBold: string;
  /** Raw original (fallback pra exibição). */
  raw: string;
}

const FALLBACK: ShippingBadge = {
  kind: 'other',
  label: '—',
  short: '—',
  color: 'bg-slate-100 text-slate-700',
  colorBold: 'bg-slate-600 text-white',
  raw: '',
};

function normalize(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyShipping(raw: string | null | undefined): ShippingBadge {
  if (!raw) return FALLBACK;

  const text = normalize(raw);
  const rawStr = String(raw);

  // RETIRADA EM LOJA — match antes de SEDEX/PAC pra cobrir "Retirar na loja"
  if (
    text.includes('retirar') ||
    text.includes('retirada') ||
    text.includes('pickup') ||
    text.includes('local_pickup')
  ) {
    return {
      kind: 'pickup',
      label: 'RETIRADA EM LOJA',
      short: 'RETIRADA',
      color: 'bg-amber-100 text-amber-900',
      colorBold: 'bg-amber-500 text-white',
      raw: rawStr,
    };
  }

  // SEDEX (inclui variantes: sedex 10, sedex hoje, etc)
  if (text.includes('sedex')) {
    return {
      kind: 'sedex',
      label: 'SEDEX',
      short: 'SEDEX',
      color: 'bg-red-100 text-red-800',
      colorBold: 'bg-red-600 text-white',
      raw: rawStr,
    };
  }

  // PAC
  if (/\bpac\b/.test(text)) {
    return {
      kind: 'pac',
      label: 'PAC',
      short: 'PAC',
      color: 'bg-blue-100 text-blue-800',
      colorBold: 'bg-blue-600 text-white',
      raw: rawStr,
    };
  }

  // Transportadoras comuns
  if (
    text.includes('jadlog') ||
    text.includes('loggi') ||
    text.includes('jet') ||
    text.includes('azul cargo') ||
    text.includes('total express') ||
    text.includes('transportadora') ||
    text.includes('frete')
  ) {
    return {
      kind: 'transportadora',
      label: 'TRANSPORTADORA',
      short: rawStr.toUpperCase().slice(0, 16),
      color: 'bg-purple-100 text-purple-800',
      colorBold: 'bg-purple-600 text-white',
      raw: rawStr,
    };
  }

  // Fallback genérico — mostra texto original truncado
  return {
    ...FALLBACK,
    label: rawStr,
    short: rawStr.length > 14 ? rawStr.slice(0, 14) + '…' : rawStr,
    raw: rawStr,
  };
}
