/**
 * DISCRIMINADOR DE PRODUTO — o que separa dois produtos que dividem a MESMA REF.
 *
 * No ERP a REF numérica é RECICLADA entre fornecedores: "6605" é bermuda
 * KATHO, vestido FAJOS, blusa NB **e** calça wideleg MAX DENIM ao mesmo tempo.
 * Sem um segundo campo na chave, a grade mistura o nome de um produto com as
 * variações do outro (o "velho erro de adivinhar a referência", dono 21/07).
 *
 * Em 03/08 esse segundo campo virou a MARCA — estável entre cadastros, ao
 * contrário do FORNECEDOR (CNPJ), que muda de escrita e racha a mesma peça em
 * dois cartões (caso BMM-100).
 *
 * ⚠️ O QUE FALTAVA (12/08): a marca pode vir VAZIA — e vem em **44% do
 * catálogo ativo** (155.910 de 353.572). Com o discriminador em branco a regra
 * desaba pra "família = REF sozinha" e o bug de 21/07 volta inteiro: a calça
 * 6605 (14 peças no tam 50) foi engolida pelo cartão da blusa 6605, que também
 * estava sem marca. Havia 3.391 baldes com dois ou mais produtos fundidos
 * assim.
 *
 * Fallback: a primeira palavra significativa da DESCRIÇÃO. Palavras do dono
 * (03/08): *"usar somente referência e partes da descrição; sempre na descrição
 * teremos o nome fantasia do fornecedor"*. "CALÇA FEMININA WIDELEG PLUS SIZE
 * 6605 JEANS 50 MAX DENIM" → `calca`, e a blusa vira `blusa`: cartões
 * separados, sem depender de ninguém preencher cadastro.
 *
 * Mesma heurística (e mesmas stopwords) de ProductSearchService.familiaOf /
 * ErpService.groupRowsByFamily — só com piso de 3 letras em vez de 4, pra não
 * jogar "TOP" e "KIT" todos no mesmo balde. As duas de lá não mudam: os
 * chamadores delas dependem de casar uma com a outra.
 */

const STOPWORDS = new Set([
  'plus', 'size', 'feminina', 'feminino', 'masculino', 'masculina',
  'infantil', 'unissex', 'adulto', 'manga', 'curta', 'longa', 'comum',
  'basica', 'basico', 'alfaiataria', 'modelo', 'inverno', 'verao',
]);

/** Primeira palavra significativa da descrição (sem acento, minúscula). */
export function familiaDaDescricao(descricao: unknown): string {
  const palavras = String(descricao ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  return (
    palavras.find((w) => w.length >= 3 && !/\d/.test(w) && !STOPWORDS.has(w)) || ''
  );
}

/**
 * O discriminador da REF: MARCA quando existe, família da descrição quando não.
 * Nunca devolve vazio pra linha que tem descrição — vazio é o que fundia tudo.
 */
export function discriminadorProduto(marca: unknown, descricao: unknown): string {
  const m = String(marca ?? '').trim().toUpperCase();
  if (m) return m;
  const familia = familiaDaDescricao(descricao);
  return familia ? `~${familia}` : '';
}
