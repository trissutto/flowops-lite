/**
 * AS LOJAS DA GRADE — quais colunas entram e em que ordem.
 *
 * Saiu de dentro do `GradeEstoque` em 24/08/2026 porque a MATRIZ DE REPOSIÇÃO
 * precisa da MESMA lista. A linha "TENHO HOJE" da matriz é o total das lojas;
 * se ela somasse um conjunto diferente do que a grade logo acima soma na
 * coluna TOT, a mesma tela mostraria dois estoques da mesma peça — e aí
 * ninguém confia em nenhum dos dois.
 *
 * Nada mudou de comportamento: é o mesmo código, no mesmo lugar da chamada.
 */

/**
 * MATRIZ, ITU, DEPÓSITO e SITE fora da grade (dono, 04/08).
 *
 * A grade existe pra mover peça ENTRE LOJAS QUE VENDEM. Essas quatro não
 * vendem da arara — e coluna a mais aqui não é só ruído visual: cada uma é um
 * destino de arraste, e arrastar peça pra matriz por engano tira ela da arara
 * sem ninguém precisar dela. SITE é loja-canal: a peça vai pro site pelo
 * pedido (TransferOrder do canal), nunca arrastada nesta grade.
 *
 * Filtra pela SIGLA (o mesmo texto do cabeçalho) e não por código: código de
 * loja não dá pra conferir daqui, e chutar código é esconder a coluna errada.
 */
const FORA_DA_GRADE = ['MATRI', 'ITU', 'DEPOS', 'SITE'];

/**
 * ORDEM DO ITINERÁRIO DA ENTREGA (dono, 04/08) — não alfabética.
 *
 * A grade é usada pra decidir o que vai em cada caixa, e quem monta segue a
 * ordem do carro. Coluna em ordem alfabética obriga a pular de um lado pro
 * outro da tela a cada loja da rota.
 *
 * Casa pela SIGLA, não por código. Loja fora da rota (qualquer uma nova) vai
 * pro fim, em ordem alfabética — melhor no fim do que sumida.
 */
const ITINERARIO = [
  'ITANH', 'PRAIA', 'SANTO', 'JUNDI', 'VINHE', 'CAMPI', 'LIMEI',
  'PIRAC', 'INDAI', 'SOROC', 'MOEMA', 'ANALI', 'SUZAN', 'SAO J',
];

/** Fallback de quando `/stores` ainda não respondeu. */
const CODIGOS_PADRAO = ['01', '02', '03', '05', '06', '08', '10', '15', '17', '18'];

/**
 * As lojas que VENDEM esta peça de arara, na ordem da rota.
 *
 * TODAS as lojas cadastradas entram, mesmo zeradas (pedido do dono 03/08):
 * coluna vazia é DESTINO válido, e sem ela não dá pra arrastar peça pra loja
 * que ainda não tem essa cor.
 */
export function lojasDaGrade(
  skus: Array<{ estoqueLojas?: Record<string, number> }>,
  lojaNomes: Map<string, string>,
): string[] {
  const s = new Set<string>(lojaNomes.keys());
  if (!s.size) for (const c of CODIGOS_PADRAO) s.add(c);
  for (const r of skus) for (const l of Object.keys(r.estoqueLojas ?? {})) s.add(l);

  const posicao = (c: string) => {
    const i = ITINERARIO.indexOf((lojaNomes.get(c) || c).toUpperCase());
    return i < 0 ? ITINERARIO.length : i;
  };

  return [...s]
    .filter((c) => !FORA_DA_GRADE.includes((lojaNomes.get(c) || c).toUpperCase()))
    .sort((a, b) => {
      const d = posicao(a) - posicao(b);
      return d !== 0 ? d : a.localeCompare(b);
    });
}
