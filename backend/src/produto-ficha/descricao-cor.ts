/**
 * DESCRIÇÃO × COR — a régua do "descrição por REF não cita cor" (06/09/2026).
 *
 * A descrição da ficha é UMA por REF e aparece em TODAS as variantes de cor.
 * Texto escrito pra uma cor vira contradição nas outras: a ref-900890 abria
 * na variante MARROM com a descrição inteira jurando "Cor Preta … o preto é
 * o tom mais versátil" (herança do WooCommerce, onde cada cor era um produto
 * com página própria). Contradição ali é troca/devolução paga pela loja.
 *
 * Duas detecções, com graus de certeza diferentes:
 *
 * 1. `citaCorAncorada` — "Cor: Preto", "| Cor Preta". A âncora é a PALAVRA
 *    "cor", igual ao `nome-vitrine.ts`: nenhuma descrição legítima de peça
 *    multi-cor precisa dessa construção, então isto pode BLOQUEAR o save.
 * 2. `coresCitadas` — dicionário de nomes de cor no texto corrido. Serve de
 *    AVISO (fila da ficha) e de matéria-prima pro script de saneamento, nunca
 *    de bloqueio cego: "Vinho" pode ser nome de modelo ("não sai adivinhando
 *    palavra por palavra" — a lição do nome-vitrine vale aqui também, por
 *    isso quem decide apagar é o script comparando com as cores REAIS da
 *    peça, ou um humano na fila).
 *
 * O dicionário espelha os grupos do site (`ecommerce/src/lib/search/synonyms.ts`,
 * COLOR_SYNONYMS) — o script `backend/scripts/fix-descricao-cita-cor.js`
 * carrega uma cópia própria (convenção: script roda standalone via railway).
 */

/** canonical → variantes que aparecem em texto corrido (sem acento, minúsculo). */
export const GRUPOS_DE_COR: ReadonlyArray<{ canonical: string; variantes: string[] }> = [
  { canonical: 'preto', variantes: ['preto', 'preta', 'pretos', 'pretas'] },
  { canonical: 'branco', variantes: ['branco', 'branca', 'brancos', 'brancas'] },
  { canonical: 'off white', variantes: ['off white', 'offwhite', 'off-white'] },
  { canonical: 'cru', variantes: ['cru'] },
  { canonical: 'bege', variantes: ['bege'] },
  { canonical: 'creme', variantes: ['creme'] },
  { canonical: 'nude', variantes: ['nude'] },
  { canonical: 'vermelho', variantes: ['vermelho', 'vermelha', 'vermelhos', 'vermelhas'] },
  { canonical: 'vinho', variantes: ['vinho', 'marsala', 'bordo'] },
  { canonical: 'rosa', variantes: ['rosa', 'pink', 'rose'] },
  { canonical: 'marinho', variantes: ['marinho'] },
  { canonical: 'azul', variantes: ['azul', 'azuis', 'royal'] },
  { canonical: 'verde', variantes: ['verde', 'verdes', 'esmeralda', 'militar', 'oliva', 'musgo'] },
  { canonical: 'amarelo', variantes: ['amarelo', 'amarela', 'mostarda'] },
  { canonical: 'laranja', variantes: ['laranja', 'terracota'] },
  { canonical: 'roxo', variantes: ['roxo', 'roxa', 'uva'] },
  { canonical: 'lilas', variantes: ['lilas', 'lavanda'] },
  { canonical: 'marrom', variantes: ['marrom', 'chocolate', 'caramelo', 'cafe'] },
  { canonical: 'cinza', variantes: ['cinza', 'grafite', 'chumbo'] },
  { canonical: 'dourado', variantes: ['dourado', 'dourada'] },
  { canonical: 'prata', variantes: ['prata', 'prateado', 'prateada'] },
];

/** NFD + sem diacrítico + minúsculo — mesma normalização da `FichaIaService.chave`. */
export function semAcento(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Regex de palavra tolerante a acento — `\b` do JS não entende À-ÿ. */
function palavra(v: string): RegExp {
  const corpo = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\w])${corpo}(?![\\w])`, 'i');
}

/**
 * Nomes canônicos de cor citados no texto. Dicionário sobre texto NORMALIZADO
 * (sem acento) — "Café" casa com "cafe".
 */
export function coresCitadas(texto: string | null | undefined): string[] {
  const t = semAcento(texto ?? '');
  if (!t) return [];
  const achadas: string[] = [];
  for (const g of GRUPOS_DE_COR) {
    if (g.variantes.some((v) => palavra(v).test(t))) achadas.push(g.canonical);
  }
  return achadas;
}

/**
 * A construção "Cor: X" / "cor preta" — ancorada na PALAVRA "cor", que é o
 * que a torna segura pra BLOQUEAR: modelo chamado Vinho não tem "cor" na
 * frente. Devolve o trecho encontrado, ou null.
 */
export function citaCorAncorada(texto: string | null | undefined): string | null {
  const t = String(texto ?? '');
  if (!t) return null;
  const m = t.match(/\bcor(?:es)?\s*:?\s+([\wÀ-ÿ]+(?:\s+[\wÀ-ÿ]+)?)/i);
  if (!m) return null;
  // Só acusa quando o que segue "cor" é cor DE VERDADE — "cores vivas",
  // "cor do verão" e afins passam.
  return coresCitadas(m[1]).length > 0 ? m[0].trim() : null;
}
