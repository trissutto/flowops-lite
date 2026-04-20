/**
 * Utilitários para extrair dados de um pedido vindo do WooCommerce REST.
 *
 * Por que separado do WooCommerceService?
 *   - São funções puras (sem IO), fáceis de testar
 *   - Reutilizadas em orders.controller + orders.service + routing
 */

export interface StoreLike {
  code: string;
  name: string;
  city?: string | null;
}

export interface ExtractedPickup {
  isPickup: boolean;
  pickupStoreCode: string | null;
  /** Texto original do método de envio (pra UI e fallback manual). */
  shippingMethodTitle: string | null;
  /** Se detectou que é pickup mas não conseguiu mapear pra uma loja cadastrada. */
  unresolvedCityName?: string | null;
}

/**
 * Tenta várias chaves conhecidas de plugins brasileiros pra extrair o CPF.
 * Ordem: plugins mais populares → genéricos.
 */
export function extractCpf(wcOrder: any): string | null {
  if (!wcOrder) return null;

  // Alguns plugins expõem direto no billing
  const billingDirect =
    wcOrder.billing?.cpf ||
    wcOrder.billing?._cpf ||
    wcOrder.billing?.persontype;
  if (typeof billingDirect === 'string' && billingDirect.trim()) {
    return cleanCpf(billingDirect);
  }

  const metaKeys = [
    '_billing_cpf',          // Brazilian Market on WooCommerce
    'billing_cpf',
    '_wcbcf_customer_cpf',   // Brazilian Checkout Fields
    'wcbcf_customer_cpf',
    '_billing_cpf_number',
    'cpf',
    '_cpf',
    'billing_persontype_cpf',
  ];

  const meta = (wcOrder.meta_data ?? []) as Array<{ key?: string; value?: any }>;
  for (const key of metaKeys) {
    const m = meta.find((x) => x?.key === key);
    if (m?.value && String(m.value).trim()) {
      return cleanCpf(String(m.value));
    }
  }

  return null;
}

/**
 * Remove caracteres não-dígitos e valida que tem 11 dígitos. Se não tiver,
 * retorna o valor original (alguns cadastros podem ter CNPJ misturado).
 */
function cleanCpf(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11) {
    // formata 000.000.000-00
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  return trimmed;
}

/**
 * Remove acentos + lowercase pra comparação fuzzy.
 */
function normalize(s: string): string {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detecta se o pedido é "retirar em loja" olhando o shipping_lines.
 *
 * Padrão observado no cliente (lurds.com.br):
 *   method_title: "Retirar Gratuitamente na Loja de Piracicaba (3 a 5 dias úteis)"
 *
 * Estratégia:
 *   1. Se title/method_id contém "retirar" ou "pickup" ou "local_pickup" → é pickup
 *   2. Tenta matchar nome ou city de cada Store cadastrada contra o title (normalizado)
 *   3. Se achar match → retorna storeCode. Se não achar → retorna null + unresolvedCityName
 */
export function detectPickup(wcOrder: any, stores: StoreLike[]): ExtractedPickup {
  const shippingLines = (wcOrder?.shipping_lines ?? []) as Array<any>;
  if (!shippingLines.length) {
    return { isPickup: false, pickupStoreCode: null, shippingMethodTitle: null };
  }

  const line = shippingLines[0];
  const titleRaw = String(line?.method_title ?? '');
  const methodId = String(line?.method_id ?? '').toLowerCase();
  const title = normalize(titleRaw);

  const isPickup =
    methodId.includes('local_pickup') ||
    methodId.includes('pickup') ||
    title.includes('retirar') ||
    title.includes('retirada');

  if (!isPickup) {
    return { isPickup: false, pickupStoreCode: null, shippingMethodTitle: titleRaw || null };
  }

  // Tenta matchar store pelo nome ou pela cidade dentro do title
  // Ordena stores por length do nome descendente — "São José dos Campos" match antes de "Jose"
  const sorted = [...stores].sort(
    (a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0),
  );

  for (const s of sorted) {
    const nameNorm = normalize(s.name ?? '');
    if (nameNorm && title.includes(nameNorm)) {
      return {
        isPickup: true,
        pickupStoreCode: s.code,
        shippingMethodTitle: titleRaw,
      };
    }
    const cityNorm = normalize(s.city ?? '');
    if (cityNorm && title.includes(cityNorm)) {
      return {
        isPickup: true,
        pickupStoreCode: s.code,
        shippingMethodTitle: titleRaw,
      };
    }
  }

  // É pickup mas não achou a loja — extrai tentativa da cidade (depois de "Loja de ...")
  let unresolvedCityName: string | null = null;
  const mLoja = titleRaw.match(/Loja de ([^\(\)\-]+)/i);
  if (mLoja) unresolvedCityName = mLoja[1].trim();

  return {
    isPickup: true,
    pickupStoreCode: null,
    shippingMethodTitle: titleRaw,
    unresolvedCityName,
  };
}
