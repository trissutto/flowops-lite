/**
 * Nome do destinatário dentro do limite da transportadora.
 *
 * Cada API tem um teto diferente e nenhuma delas trunca sozinha: o Mais Envios
 * RECUSA a pré-postagem ("Tamanho do campo nome do destinatário inválido.
 * Máximo 40") e os Correios cortam no meio da palavra. Nome de cliente do site
 * estoura isso com facilidade — o pedido #197922 travou com 44 caracteres
 * ("Ivanilde dos Santos Augusto Marques da Silva").
 *
 * Encurtar aqui é melhor do que devolver o erro pra loja: ela não pode inventar
 * um nome diferente do que a cliente usou na compra, e o pacote precisa sair.
 *
 * Ordem das tentativas (para na primeira que couber):
 *   1. o nome como está;
 *   2. sem os conectivos do meio ("de", "da", "dos", "e") — costuma bastar:
 *      "Ivanilde dos Santos Augusto Marques da Silva" (44) vira
 *      "Ivanilde Santos Augusto Marques Silva" (37);
 *   3. nomes do meio abreviados em inicial: "Ivanilde S. A. M. Silva";
 *   4. primeiro + último sobrenome;
 *   5. corte seco — só quando o primeiro nome sozinho já estoura.
 *
 * O carteiro precisa reconhecer quem mora ali, então o primeiro nome e o
 * último sobrenome nunca são abreviados.
 */
/**
 * LIMITE ÚNICO pra TODAS as transportadoras (decisão do dono, 06/08: "melhor
 * limitar todos pelo Mais Envios"). Cada provedor valida um teto diferente e
 * recusa a pré-postagem inteira quando estoura; em vez de manter um mapa por
 * provedor, vale sempre o MAIS APERTADO conhecido — o que cabe nele cabe em
 * qualquer um. Nome 40 é o do Mais Envios (provado no pedido #197922);
 * endereço são os do manual CWS dos Correios (caso Sorocaba 05/08, que
 * estourou no endereço/complemento).
 */
export const LIMITES_TRANSPORTE = {
  nome: 40,        // Mais Envios recusa acima de 40 (Correios aceita 50)
  logradouro: 50,
  numero: 6,
  complemento: 30,
  bairro: 30,
  cidade: 30,
} as const;

/**
 * Campo de ENDEREÇO dentro do limite da transportadora (logradouro, bairro,
 * cidade, complemento). Mesmo problema do nome — o CWS dos Correios valida e
 * recusa a pré-postagem inteira ("excesso de caracteres", caso Sorocaba
 * 05/08) — mas a solução é outra: endereço não pode virar inicial, então a
 * ordem é abreviação consagrada ("Avenida"→"Av.", "Doutor"→"Dr.",
 * "Jardim"→"Jd.") e, só se ainda não couber, corte no fim. O carteiro lê
 * "Av. Dr. Armando" igual lê "Avenida Doutor Armando"; perder o FIM do
 * logradouro é menos grave que perder o começo.
 */
const ABREV_ENDERECO: Array<[RegExp, string]> = [
  [/\bAVENIDA\b/gi, 'Av.'], [/\bALAMEDA\b/gi, 'Al.'], [/\bTRAVESSA\b/gi, 'Tv.'],
  [/\bRODOVIA\b/gi, 'Rod.'], [/\bESTRADA\b/gi, 'Estr.'], [/\bPRA[CÇ]A\b/gi, 'Pç.'],
  [/\bDOUTORA\b/gi, 'Dra.'], [/\bDOUTOR\b/gi, 'Dr.'],
  [/\bPROFESSORA\b/gi, 'Profa.'], [/\bPROFESSOR\b/gi, 'Prof.'],
  [/\bPRESIDENTE\b/gi, 'Pres.'], [/\bCORONEL\b/gi, 'Cel.'], [/\bGENERAL\b/gi, 'Gal.'],
  [/\bMARECHAL\b/gi, 'Mal.'], [/\bENGENHEIRO\b/gi, 'Eng.'], [/\bCOMENDADOR\b/gi, 'Com.'],
  [/\bSENADOR\b/gi, 'Sen.'], [/\bDEPUTADO\b/gi, 'Dep.'], [/\bVEREADOR\b/gi, 'Ver.'],
  [/\bGOVERNADOR\b/gi, 'Gov.'], [/\bPREFEITO\b/gi, 'Pref.'],
  [/\bNOSSA SENHORA\b/gi, 'N. Sra.'], [/\bSANTO\b/gi, 'Sto.'], [/\bSANTA\b/gi, 'Sta.'],
  [/\bJARDIM\b/gi, 'Jd.'], [/\bPARQUE\b/gi, 'Pq.'], [/\bVILA\b/gi, 'Vl.'],
  [/\bCONJUNTO\b/gi, 'Cj.'], [/\bRESIDENCIAL\b/gi, 'Res.'], [/\bCONDOM[IÍ]NIO\b/gi, 'Cond.'],
  [/\bAPARTAMENTO\b/gi, 'Ap.'], [/\bBLOCO\b/gi, 'Bl.'], [/\bEDIF[IÍ]CIO\b/gi, 'Ed.'],
];

/**
 * Texto SEGURO pro sistema de captação dos Correios.
 *
 * A causa das trocas com código "inválido" (21/08): a declaração de conteúdo
 * com o nome novo do catálogo ("Blusa Manga Curta — CHIC · PRETO · 54") faz o
 * sistema de captação CANCELAR a etiqueta no ato da criação — o SRO registra
 * "Etiqueta cancelada pelo sistema de captação" e a cliente ouve "código
 * inválido" no balcão. O em-dash chega lá corrompido em "¿"; acento português
 * comum ("Calça", "Cardigã") passa sem problema, então a limpeza preserva
 * Latin-1 e só translitera a pontuação tipográfica (—, ·, aspas curvas…) pra
 * ASCII, descartando o resto.
 */
export function limparTextoTransporte(bruto: any): string {
  return String(bruto || '')
    .replace(/[‐-―−]/g, '-') // hífens tipográficos (‐ – — −)
    .replace(/[·•‧]/g, '-')  // · • ‧ (separador do "REF · COR TAM")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/…/g, '...')
    .replace(/[  -​ 　]/g, ' ') // espaços exóticos (NBSP etc.)
    .replace(/[^\x20-\x7EªºÀ-ÿ]/g, ' ') // fora de ASCII+Latin-1 → espaço
    .replace(/\s+/g, ' ')
    .trim();
}

export function encurtarCampoEndereco(bruto: any, max: number): string {
  let s = limparTextoTransporte(bruto);
  if (s.length <= max) return s;
  for (const [re, abrev] of ABREV_ENDERECO) {
    s = s.replace(re, abrev);
    if (s.length <= max) return s;
  }
  return s.slice(0, max).trim();
}

export function encurtarNomeDestinatario(bruto: any, max: number): string {
  const limpo = limparTextoTransporte(bruto);
  if (limpo.length <= max) return limpo;

  const partes = limpo.split(' ').filter(Boolean);
  const conectivos = new Set(['de', 'da', 'das', 'do', 'dos', 'e']);
  const juntar = (arr: string[]) => arr.join(' ').trim();

  const semConectivos = partes.filter(
    (p, i) => i === 0 || i === partes.length - 1 || !conectivos.has(p.toLowerCase()),
  );
  if (juntar(semConectivos).length <= max) return juntar(semConectivos);

  const abreviado = semConectivos.map((p, i) =>
    i === 0 || i === semConectivos.length - 1 ? p : `${p[0].toUpperCase()}.`,
  );
  if (juntar(abreviado).length <= max) return juntar(abreviado);

  const primeiro = semConectivos[0] || limpo;
  const ultimo = semConectivos.length > 1 ? semConectivos[semConectivos.length - 1] : '';
  const curto = juntar([primeiro, ultimo]);
  if (curto.length <= max) return curto;

  return curto.slice(0, max).trim();
}
