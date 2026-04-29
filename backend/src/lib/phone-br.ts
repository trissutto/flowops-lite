/**
 * phone-br.ts — Normalização de telefones brasileiros pra WhatsApp.
 *
 * Lurd's tem clientes cadastrados com formatos variados no Gigasistemas:
 *   - "(13) 99661-0571"   → completo com DDD
 *   - "997687606"         → SEM DDD (precisa adicionar default)
 *   - "9145.1516"         → SEM DDD, formato com ponto
 *   - "99641.5154"        → SEM DDD, formato com ponto
 *   - "5513999998888"     → já com 55 país + DDD
 *
 * Regra: se o número (só dígitos) tem 8 ou 9 dígitos, falta DDD.
 *        Adicionamos o DDD padrão (env `DEFAULT_AREA_CODE` ou '13' default).
 */

const DEFAULT_AREA_CODE = process.env.DEFAULT_AREA_CODE || '13';

/**
 * Recebe qualquer formato cru de telefone e devolve só dígitos no formato
 * BR completo: 55 + DDD + número (12 ou 13 dígitos no total).
 *
 * Retorna null se inviável (vazio, dígitos demais/de menos sem solução).
 */
export function normalizeBrPhone(raw: string | null | undefined, opts: { defaultAreaCode?: string } = {}): string | null {
  if (!raw) return null;
  const ddd = (opts.defaultAreaCode || DEFAULT_AREA_CODE).replace(/\D/g, '').slice(0, 2);

  let n = String(raw).replace(/\D/g, '');
  if (!n) return null;
  if (n.startsWith('0')) n = n.slice(1);

  // Já tem 55 + DDD + número (12 ou 13 dígitos)
  if (n.length === 12 || n.length === 13) {
    if (n.startsWith('55')) return n;
    // Mais raro: 12-13 dígitos sem 55 (não bate). Tenta com 55 prefix.
    return '55' + n;
  }
  // 10 (fixo) ou 11 (celular) com DDD, sem 55
  if (n.length === 10 || n.length === 11) return '55' + n;
  // 8 (fixo) ou 9 (celular novo) SEM DDD — adiciona padrão
  if (n.length === 8 || n.length === 9) return '55' + ddd + n;
  // Outros tamanhos: inviável
  return null;
}

/**
 * Formata pra exibição na UI: "(13) 99661-0571" ou "(13) 9961-0571".
 * Se inviável, retorna o original.
 */
export function formatBrPhonePretty(raw: string | null | undefined): string {
  if (!raw) return '';
  const norm = normalizeBrPhone(raw);
  if (!norm) return String(raw);
  // norm = 55 DD NNNNNNNN (12) ou 55 DD 9 NNNNNNNN (13)
  const dd = norm.slice(2, 4);
  const rest = norm.slice(4);
  if (rest.length === 9) {
    return `(${dd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
  }
  if (rest.length === 8) {
    return `(${dd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return raw;
}

/** Retorna true se o número (depois de normalizar) é válido pra WhatsApp. */
export function isValidBrPhone(raw: string | null | undefined): boolean {
  return normalizeBrPhone(raw) !== null;
}
