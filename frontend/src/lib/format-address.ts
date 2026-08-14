/**
 * Parser de endereço de entrega.
 * O backend salva o shipping address do WooCommerce como JSON stringificado
 * no campo Order.shippingAddress. Aqui a gente tenta parsear e retornar
 * um objeto bonito — se falhar, cai no fallback de mostrar o texto cru.
 */

export interface ParsedAddress {
  /** Nome completo (first_name + last_name) */
  recipientName: string | null;
  /** Rua + número (ex: "Rua Ibirapuera, 3103") */
  streetLine: string | null;
  /** Complemento (apto, sala, etc) */
  complement: string | null;
  /** Bairro */
  neighborhood: string | null;
  /** Cidade / UF */
  cityState: string | null;
  /** UF isolada (SP, RJ, MG…) — pra regras de envio (PROMOCIONAL → SEDEX se SP) */
  state: string | null;
  /** CEP já formatado (00000-000) */
  cep: string | null;
  /** Tudo numa linha só (pra fallback inline) */
  oneLiner: string;
}

export function parseShippingAddress(
  raw: string | null | undefined,
): ParsedAddress | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Se começar com { tenta parsear como JSON
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      return buildFromJson(j);
    } catch {
      // cai no fallback
    }
  }

  // Fallback: texto cru
  return {
    recipientName: null,
    streetLine: null,
    complement: null,
    neighborhood: null,
    cityState: null,
    state: null,
    cep: null,
    oneLiner: trimmed,
  };
}

/**
 * A LINHA DA RUA — "Rua Salomão Filho, 577", com o número UMA vez.
 *
 * O pedido guarda `address_1` = "rua, número" grudado E, desde a correção da
 * etiqueta, também `number` em campo próprio. Quem junta os dois na mão
 * escreve o número duas vezes — foi o que a tela do pedido mostrou em 13/08
 * ("Rua Salomão Filho, 577 , 577"). Toda tela que precisa dessa linha chama
 * aqui; concatenar `address_1 + number` na mão é o bug.
 */
export function ruaComNumero(addr: any): string {
  const a = addr || {};
  const bruto = String(a.address_1 ?? a.street ?? '').trim();
  const numero = String(a.number ?? a.numero ?? '').toString().trim();
  if (!numero) return bruto;

  // Escapa o número: "1500-A" tem hífen, "s/n" tem barra.
  const alvo = numero.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rua = bruto.replace(new RegExp(`[,\\s]*${alvo}\\s*$`, 'i'), '').trim();
  if (!rua) return bruto || `nº ${numero}`;
  return `${rua}, ${numero}`;
}

function buildFromJson(j: any): ParsedAddress {
  const name = [j.first_name, j.last_name].filter(Boolean).join(' ').trim() || null;

  const streetLine = ruaComNumero(j) || null;

  const complement = (j.address_2 || '').trim() || null;
  const neighborhood = (j.neighborhood || '').trim() || null;

  const city = (j.city || '').trim();
  const state = (j.state || '').trim();
  const cityState = city && state ? `${city}/${state}` : city || state || null;

  const cep = formatCep(j.postcode);

  const parts: string[] = [];
  if (streetLine) parts.push(streetLine);
  if (complement) parts.push(complement);
  if (neighborhood) parts.push(neighborhood);
  if (cityState) parts.push(cityState);
  if (cep) parts.push(`CEP ${cep}`);
  const oneLiner = parts.join(' · ');

  return {
    recipientName: name,
    streetLine,
    complement,
    neighborhood,
    cityState,
    state: state || null,
    cep,
    oneLiner,
  };
}

export function formatCep(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length !== 8) return digits || null;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return raw;
}
