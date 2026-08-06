/**
 * Ordena tamanhos de grade pra exibição/impressão.
 *
 * Por que existe: objeto JS itera chave NUMÉRICA ("50", "52") antes da
 * não-numérica ("46/48") — quando o JSON da grade vira objeto, o 46/48 cai no
 * fim. E `Number(a) - Number(b)` devolve NaN pra "46/48"/letras, deixando a
 * ordem arbitrária. Aqui: numéricos por valor ("46/48" conta como 46.48),
 * letras na sequência PP→G5 depois dos números, desconhecidos por último.
 */
export function ordemTamanho(t: string): number {
  const n = Number(String(t || '').replace('/', '.'));
  if (!isNaN(n) && n > 0) return n;
  const letras = ['PP', 'P', 'M', 'G', 'GG', 'XGG', 'EG', 'EGG', 'G1', 'G2', 'G3', 'G4', 'G5'];
  const i = letras.indexOf(String(t || '').toUpperCase());
  return i >= 0 ? 1000 + i : 2000;
}
