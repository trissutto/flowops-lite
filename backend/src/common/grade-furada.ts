/**
 * GRADE FURADA — a cor que perdeu numeração demais sai do site sozinha, e
 * volta sozinha quando a reposição chega (ordem do dono, 13/09/2026).
 *
 * O problema que ela resolve: a cliente plus size entra pelo card, escolhe a
 * cor e descobre no ÚLTIMO clique que justamente o número dela não tem. Peça
 * com meia grade não vende mais por estar no ar — ela gasta o clique, ensina
 * que "a Lurd's nunca tem meu número" e ainda concorre com a peça que tem
 * grade cheia na mesma prateleira da vitrine.
 *
 * ── A MESMA FAMÍLIA DO PISO POR COR ──
 *
 * Isto é irmão do `ESTOQUE_MINIMO_COR` (piso de 10 peças por cor, 13/08): o
 * corte é DINÂMICO — não grava flag, não despublica nada, não pede
 * republicação. A cor some enquanto está furada e reaparece na montagem
 * seguinte do catálogo assim que o tamanho que faltava entra no
 * `wincred_estoque` (remessa recebida, devolução, realinhamento). Por isso
 * "reativar quando a reposição chegar" não é um segundo job: é a ausência
 * dele. Gravar "fora do site" aqui seria criar uma fila de republicação
 * manual que ninguém ia rodar — e peça boa ficaria fora do ar por meses.
 *
 * ── MEDIDO NA VITRINE DE PRODUÇÃO (13/09/2026, 595 peças / 837 cores) ──
 *
 *   limite 2 (o escolhido): 69 cores somem → 44 peças saem (7,4%) e 918 peças
 *   físicas ficam escondidas; 12 peças perdem SÓ algumas bolinhas e seguem no
 *   ar com as cores de grade cheia. Distribuição por cor: 525 com grade
 *   cheia, 176 com 1 buraco, 67 com 2, 69 com 3+.
 *
 * O limite é por COR, não por peça, porque é a cor que a cliente escolhe
 * antes do número: peça com 3 cores onde só uma está furada segue vendendo as
 * outras duas. A peça inteira sai quando NÃO SOBRA cor — pelo caminho de
 * esgotado que já existe (`disponivel: false` → `catalogoDaVitrine`).
 */

/** Tamanho de uma cor, do jeito que `montarPeca` monta. */
export type TamanhoDaCor = { label: string; estoque?: number | null };

/** `0` desliga a régua inteira sem deploy (a cor furada volta a aparecer). */
export function gradeFuradaLigada(): boolean {
  return process.env.SITE_GRADE_FURADA !== '0';
}

/**
 * Quantas numerações podem faltar antes da cor sair. Default 2 = "mais do que
 * 2 numerações zeradas sai" (ordem do dono). Ajustável sem deploy pelo
 * Railway; `0` aqui é o EXTREMO OPOSTO de desligar — exige grade cheia.
 */
export function maxTamanhosZerados(): number {
  const bruto = Number(process.env.SITE_MAX_TAM_ZERADOS);
  return Number.isFinite(bruto) && bruto >= 0 ? Math.trunc(bruto) : 2;
}

export type VeredictoGrade = {
  /** true = esconder esta cor da vitrine enquanto a reposição não chega. */
  furada: boolean;
  /** Os números que faltam — é o que a matriz precisa ver pra repor. */
  faltando: string[];
};

/**
 * O veredicto de uma cor.
 *
 * ⚠️ Conta o que ESTÁ CADASTRADO na cor, não a grade da casa (46–60): cor que
 * o fornecedor só entrega em 3 números não é "grade furada", é a grade dela.
 * Comparar com 46–60 tiraria do ar toda peça de grade curta — e são elas que
 * chegam em coleção pequena.
 *
 * Cor ZERADA INTEIRA não é problema desta régua: ela já sai antes, no filtro
 * de estoque da bolinha. Aqui interessa a cor que ainda tem peça na arara.
 */
export function veredictoDaGrade(tamanhos: TamanhoDaCor[] | null | undefined): VeredictoGrade {
  const grade = (tamanhos ?? []).filter((t) => t && t.label);
  const faltando = grade.filter((t) => !(Number(t.estoque ?? 0) > 0)).map((t) => String(t.label));
  if (!gradeFuradaLigada()) return { furada: false, faltando };
  // Grade inteira zerada = peça/cor esgotada, caminho que já existe. Cortar
  // aqui também trocaria o motivo que a tela de cores mostra ("grade furada"
  // numa cor que não tem NADA) e esconderia o esgotamento de verdade.
  if (!grade.length || faltando.length === grade.length) return { furada: false, faltando };
  return { furada: faltando.length > maxTamanhosZerados(), faltando };
}
