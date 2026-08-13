/**
 * NOME DE VITRINE — módulo puro, uma regra só pra todo mundo.
 *
 * Morava como método privado do LojaCatalogService; virou módulo quando o
 * `publicar()` também precisou limpar (o auto-publish gravava a descrição CRUA
 * do ERP como nome do site) e o primeiro produto nascido no sistema estreou na
 * PDP como **"CAMISA MANGA LONGA POÁ MARROM 46"** (13/08) — cor, tamanho e
 * caixa alta, os três no título.
 *
 * As três lições desse caso, todas aqui dentro:
 *  1. COR COM ACENTO: a limpeza normalizava o acento da COR ("POÁ"→"POA") mas
 *     comparava com o TEXTO acentuado — nunca casava. O casamento agora é
 *     tolerante a acento dos dois lados.
 *  2. TAMANHO NO FIM: a descrição do ERP é POR VARIAÇÃO e carrega a grade
 *     ("... 46"). Número da grade da casa no FIM do nome é tamanho, não nome.
 *  3. CAIXA ALTA: etiqueta é MAIÚSCULA, vitrine não. Nome sem NENHUMA
 *     minúscula vira Title Case; nome digitado por gente passa intacto.
 */

/** Ruído que não é nome: o site inteiro é plus size feminino. */
const RUIDO_NO_NOME = [
  'plus size', 'plus-size', 'plussize', 'feminina', 'feminino', 'fem',
];

const escapar = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const semAcento = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Regex que casa a palavra COM OU SEM acento: "POA" vira `P[oóòôõö]A...` e
 * encontra tanto "POA" quanto "POÁ". Recebe o texto já SEM acento.
 */
const VARIANTES: Record<string, string> = {
  a: 'aáàâãä', e: 'eéèêë', i: 'iíìîï', o: 'oóòôõö', u: 'uúùûü', c: 'cç', n: 'nñ',
};
function padraoAcentoTolerante(semAcentoTxt: string): string {
  return escapar(semAcentoTxt)
    .split('')
    .map((ch) => {
      const v = VARIANTES[ch.toLowerCase()];
      return v ? `[${v}${v.toUpperCase()}]` : ch;
    })
    .join('');
}

/**
 * NÚMERO DA GRADE NO FIM DO NOME = tamanho da variação, nunca nome da peça.
 * Só a grade da casa (44–60, pares) e as duplas ("46/48", "46-48", "46 48");
 * "Jeans 501" não é atingido. Roda em loop: "... 46 48" cai inteiro.
 */
const TAMANHO_NO_FIM =
  /[\s·,–-]+(?:tam\.?\s*|tamanho\s*)?(?:4[468]|5[02468]|60)(?:\s*[/\s-]\s*(?:4[468]|5[02468]|60))?\s*$/i;

/** Conectivo fica minúsculo no meio do título ("Blusa de Alça", não "De"). */
const CONECTIVOS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'com', 'sem', 'para', 'pra',
  'por', 'a', 'o', 'as', 'os', 'na', 'no', 'nas', 'nos', 'à', 'ao',
]);

/**
 * "CAMISA MANGA LONGA" → "Camisa Manga Longa". Só entra em nome SEM nenhuma
 * minúscula (assinatura de etiqueta do ERP): "T-shirt com Bordado" digitado
 * por gente não é tocado — escolha humana vence heurística.
 */
export function titularSeCaixaAlta(nome: string): string {
  const txt = String(nome || '').trim();
  if (!txt || /[a-zçáéíóúâêôãõàüñ]/.test(txt)) return txt;
  return txt
    .toLowerCase()
    .split(/\s+/)
    .map((palavra, i) => {
      if (i > 0 && CONECTIVOS.has(palavra)) return palavra;
      // Capitaliza cada trecho de palavra composta: "t-shirt" → "T-Shirt"
      return palavra
        .split('-')
        .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
        .join('-');
    })
    .join(' ');
}

/**
 * O nome como a cliente lê no card — venha da ficha, do cadastro ou do ERP.
 *
 * Passa em TODOS os caminhos de propósito: o título sujo não vinha só da
 * descrição do ERP. "Regata Feminina Plus Size Ref 700979 Estampa Verde" é
 * nome importado do WooCommerce, e nenhuma limpeza anterior o tocava.
 *
 * Nunca devolve vazio: se a limpeza comer o nome inteiro (peça cujo título
 * era só "Blusa Feminina Plus Size Preto"), volta o original. Peça sem nome
 * na vitrine é pior que peça com nome redundante.
 */
export function limparNomeVitrine(
  nome: string | null | undefined,
  ref: string,
  cores: string[],
  marca?: string | null,
): string {
  const original = String(nome || '').trim();
  if (!original) return '';

  let txt = original;

  // "Ref 700979", "REF: 700979" e a REF solta — ela vai pro card em campo
  // próprio, em negrito, em vez de diluída no meio da frase.
  txt = txt.replace(new RegExp(`\\bref\\s*:?\\s*${escapar(ref)}\\b`, 'gi'), ' ');
  txt = txt.replace(new RegExp(`\\b${escapar(ref)}\\b`, 'gi'), ' ');
  txt = txt.replace(/\bref\s*:?\s*\d{3,}\b/gi, ' ');

  for (const ruido of RUIDO_NO_NOME) {
    txt = txt.replace(new RegExp(`\\b${escapar(ruido)}\\b`, 'gi'), ' ');
  }

  if (marca) txt = txt.replace(new RegExp(`\\b${escapar(marca)}\\b`, 'gi'), ' ');

  /**
   * A COR — E TUDO O QUE VEM DEPOIS DELA.
   *
   * Nestes nomes (importados do site antigo) a cor MARCA O FIM da parte
   * descritiva; o que sobra atrás é sufixo interno. Exemplos reais:
   *
   *   "T-shirt Feminina Plus Size Manga Curta Ref Vogue Preto LENE"
   *   "CAMISA MANGA LONGA POÁ MARROM 46"
   *
   * "LENE" não é marca nem cor (resto de cadastro) e "46" é a grade da
   * variação: os dois somem junto com a cor.
   *
   * Cores da MAIS LONGA pra mais curta: "ROSA QUEIMADO" tem que casar
   * inteira antes de "ROSA" cortar no meio dela. O casamento é TOLERANTE A
   * ACENTO nos dois lados — cor gravada "POÁ MARROM" tem que sair de um nome
   * escrito "POA MARROM", e vice-versa.
   */
  for (const cor of [...cores].sort((a, b) => b.length - a.length)) {
    const alvo = semAcento(cor).trim();
    if (alvo.length < 3) continue; // "PP", "GG" — arriscado demais
    txt = txt.replace(new RegExp(`\\b${padraoAcentoTolerante(alvo)}\\b.*$`, 'i'), ' ');
  }

  /**
   * Qualificador de cor que ficou órfão. "Blusa Manga Curta Estampa
   * Marinho" com a cor gravada só como "MARINHO" perde o "Marinho" e deixa
   * "Estampa" pendurado no fim, qualificando o nada. Some só quando está no
   * FIM: "Blusa Estampa Floral" não é o caso, e "Saia Midi" não é atingida.
   */
  const ORFAOS = /\s+(estampa|estampada?o?|mescla|claro?a?|escuro?a?|m[ée]dio?a?)$/i;
  let limpo = txt.replace(/\s{2,}/g, ' ').trim();
  while (ORFAOS.test(limpo)) limpo = limpo.replace(ORFAOS, '');

  // Tamanho pendurado no fim (com ou sem a cor na frente) — ver TAMANHO_NO_FIM.
  while (TAMANHO_NO_FIM.test(limpo)) limpo = limpo.replace(TAMANHO_NO_FIM, '');

  limpo = limpo
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·,-]+/, '')
    .replace(/[\s·,-]+$/, '')
    .trim();

  return titularSeCaixaAlta(limpo || original);
}

/**
 * A descrição CRUA do ERP virando nome de vitrine — sem a cor de outra peça.
 *
 * 🔴 Bug visto no pedido `#LP-000002` (06/08): a peça saiu como
 * **"T-shirt Feminina Plus Size Manga Curta Ref Vogue Preto LENE · VINHO"**.
 * "Preto" não é parte do nome do produto — é a cor da variação que por acaso
 * ficou em primeiro na consulta. Como a descrição do ERP é POR VARIAÇÃO, ela
 * sempre carrega uma cor; usá-la como nome da peça inteira gruda a cor de
 * uma no título de todas, e aí a cliente lê "Preto · VINHO" no próprio
 * carrinho.
 *
 * Tira o que é identificação interna (REF, "Ref XXX", marca), QUALQUER cor
 * conhecida daquela REF e o tamanho pendurado no fim. Conservador: só remove
 * o que sabe ser cor — não sai adivinhando palavra por palavra, senão come
 * pedaço do nome de verdade ("Vinho" pode ser cor, mas "Vogue" é modelo).
 *
 * Isto é REMENDO do dado ruim. O certo é a ficha ter `nomeCurto` — e é por
 * isso que ela ganha desta função na ordem de preferência.
 */
export function nomeDaDescricaoErp(
  descricao: string | null | undefined,
  ref: string,
  cores: string[],
  marca?: string | null,
): string {
  let txt = String(descricao || '').trim();
  if (!txt) return '';

  // Remove "Ref VOGUE", "REF: VOGUE" e a REF solta.
  txt = txt.replace(new RegExp(`\\bref\\s*:?\\s*${escapar(ref)}\\b`, 'gi'), ' ');
  txt = txt.replace(new RegExp(`\\b${escapar(ref)}\\b`, 'gi'), ' ');

  if (marca) txt = txt.replace(new RegExp(`\\b${escapar(marca)}\\b`, 'gi'), ' ');

  /**
   * Cores da MAIS LONGA pra mais curta: "ROSA QUEIMADO" tem que sair inteira
   * antes de "ROSA" comer só um pedaço e deixar "QUEIMADO" solto no nome.
   * Tolerante a acento nos dois lados (caso "POÁ MARROM", 13/08).
   */
  for (const cor of [...cores].sort((a, b) => b.length - a.length)) {
    const alvo = semAcento(cor).trim();
    if (alvo.length < 3) continue; // "PP", "GG" — arriscado demais
    txt = txt.replace(new RegExp(`\\b${padraoAcentoTolerante(alvo)}\\b`, 'gi'), ' ');
  }

  let limpo = txt.replace(/\s{2,}/g, ' ').replace(/[\s·,-]+$/, '').trim();
  while (TAMANHO_NO_FIM.test(limpo)) limpo = limpo.replace(TAMANHO_NO_FIM, '');

  return limpo.trim();
}
