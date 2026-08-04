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
export function encurtarNomeDestinatario(bruto: any, max: number): string {
  const limpo = String(bruto || '').replace(/\s+/g, ' ').trim();
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
