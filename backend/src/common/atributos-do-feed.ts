/**
 * COR E TAMANHO NO FEED — a régua única dos dois feeds (Google e Meta).
 *
 * ── O BUG QUE ISTO CONSERTA (medido em 13/09/2026) ──
 *
 * O diagnóstico da campanha `[Petter][GOOGLE PMAX Feeds Personalizados]`
 * acusava três problemas com o MESMO número: **Esgotado 145, Cor ausente 145,
 * Tamanho ausente 94**. Não eram três conjuntos — era um só. Conferido no XML
 * publicado: das 969 ofertas, as **145 esgotadas saíam sem `<g:color>` e sem
 * `<g:size>`**, e nenhuma peça à venda saía sem.
 *
 * A causa é uma troca de significado. A vitrine monta cor e grade com o que dá
 * pra COMPRAR — é o certo pra ela: bolinha de cor zerada gasta o clique da
 * cliente, e tamanho sem estoque na PDP é promessa falsa. O feed herdou essa
 * lista e ficou sem atributo nenhum quando a peça zerou.
 *
 * Só que no feed **quem diz "agora não" é o `availability`**. Cor e tamanho
 * dizem o que a peça É: uma blusa esgotada continua sendo preta e continua
 * existindo do 46 ao 56. Mandar `out_of_stock` é correto (e é decisão tomada:
 * sumir do feed faz o Google tratar como produto morto e recomeçar o
 * aprendizado do zero na volta) — mandar `out_of_stock` SEM atributo é o que
 * faz a peça voltar da reposição como item incompleto, e atributo faltando em
 * vestuário é dos sinais que mais pesam contra no Shopping.
 *
 * ── A REGRA ──
 *
 * Publica o que dá pra comprar. Quando NÃO sobrou nada comprável — e só nesse
 * caso — publica a grade inteira, porque a alternativa não é "menos", é NADA.
 * Peça à venda segue anunciando só o que ela entrega: quem procura 54 e acha
 * um anúncio sem 54 em estoque volta pro Google, e isso custa mais caro.
 */

export interface TamanhoDaGrade {
  label: string;
  /** `false` = existe na grade e está zerado. */
  disponivel?: boolean;
}

/**
 * Os tamanhos que o feed publica.
 *
 * Peça com grade viva → só os compráveis. Peça inteira zerada → a grade
 * inteira, que é o que ela É.
 */
export function tamanhosDoFeed(grade: readonly TamanhoDaGrade[] | null | undefined): string[] {
  const todos = (grade ?? []).filter((t) => t && String(t.label ?? '').trim());
  const compraveis = todos.filter((t) => t.disponivel);
  return (compraveis.length ? compraveis : todos).map((t) => String(t.label).trim());
}

/**
 * As cores que o feed publica.
 *
 * `vendaveis` são as que a vitrine mostra (com foto, com estoque e acima do
 * piso por cor); `daGrade` são os nomes crus das linhas do ERP, que continuam
 * existindo depois que o estoque zera.
 *
 * ⚠️ A ordem importa e é a da vitrine: a primeira desta lista é a que vira o
 * rótulo do anúncio quando a peça sai como item único.
 */
export function coresDoFeed(
  vendaveis: readonly (string | null | undefined)[] | null | undefined,
  daGrade: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  const limpar = (lista: readonly (string | null | undefined)[] | null | undefined) => {
    const vistas = new Set<string>();
    const out: string[] = [];
    for (const c of lista ?? []) {
      const nome = String(c ?? '').trim();
      // Dedupe por caixa/acento tem dono: `chaveDeCor` no site. Aqui basta não
      // repetir o nome idêntico — a origem é a mesma coluna do ERP.
      if (!nome || vistas.has(nome)) continue;
      vistas.add(nome);
      out.push(nome);
    }
    return out;
  };
  const compraveis = limpar(vendaveis);
  return compraveis.length ? compraveis : limpar(daGrade);
}
