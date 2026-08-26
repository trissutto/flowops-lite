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

  // Helper: dado um número 55+DDD+número, garante que celular tem o 9.
  // Celular brasileiro: 1º dígito após DDD é 6, 7, 8 ou 9 → adiciona 9
  // Fixo: começa com 2-5 → não adiciona.
  const ensureNonoDigito = (full: string): string => {
    if (!full.startsWith('55') || full.length < 12) return full;
    const dddPart = full.slice(2, 4);
    const numPart = full.slice(4);
    // Já tem 9 dígitos (celular novo) ou é fixo (8 dígitos começando 2-5)
    if (numPart.length === 9) return full;
    if (numPart.length === 8) {
      const firstDigit = numPart[0];
      // Celular sem o 9 — números começando 6,7,8,9 são celulares
      if (['6', '7', '8', '9'].includes(firstDigit)) {
        return `55${dddPart}9${numPart}`;
      }
      // Fixo — mantém como está
      return full;
    }
    return full;
  };

  // Já tem 55 + DDD + número (12 ou 13 dígitos)
  if (n.length === 12 || n.length === 13) {
    if (n.startsWith('55')) return ensureNonoDigito(n);
    // Mais raro: 12-13 dígitos sem 55 (não bate). Tenta com 55 prefix.
    return ensureNonoDigito('55' + n);
  }
  // 10 (fixo) ou 11 (celular) com DDD, sem 55
  if (n.length === 10 || n.length === 11) return ensureNonoDigito('55' + n);
  // 8 (fixo) ou 9 (celular novo) SEM DDD — adiciona padrão
  if (n.length === 8 || n.length === 9) return ensureNonoDigito('55' + ddd + n);
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

/**
 * Telefone LOCAL do pedido: DDD + número, SEM o DDI — o formato que
 * `orders.customerPhone` guarda pro pedido do site e que a tela mostra.
 *
 * Existe por causa do "+55" colado no checkout: a máscara fazia
 * `slice(0, 11)` e "+55 11 99595-8222" virava "55119959582" — o DDI entrava
 * e ENGOLIA os últimos dígitos, gravando um número que não é de ninguém.
 * O 55 só é tratado como DDI quando o total tem 12-13 dígitos: número real
 * do DDD 55 (região de Santa Maria/RS) tem no máximo 11 e passa intacto.
 */
export function localBrPhone(raw: string | null | undefined): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, ''); // prefixo de operadora ("011 9…")
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d;
}

/**
 * O número local é plausível? Fixo = DDD + 8 (10 dígitos); celular = DDD + 9
 * dígitos começando com 9 (11). É o que denuncia o caso "55119595822": tem 11
 * dígitos mas o terceiro não é 9 — sobrou DDI e faltou dígito no fim.
 */
export function localBrPhoneValido(raw: string | null | undefined): boolean {
  const d = localBrPhone(raw);
  if (d.length === 10) return true;
  return d.length === 11 && d[2] === '9';
}
