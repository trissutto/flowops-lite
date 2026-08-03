/**
 * REF-BASE — a família da peça, uma regra só pro sistema inteiro.
 *
 * No cadastro do ERP a COR virou sufixo de REF na mão, sem padrão de
 * significado: "VMS-223" (blush), "VMS-223 MA" (marinho), "VMS-223 MM"
 * (marrom), "VMS-223 P" (preto) são O MESMO VESTIDO em quatro cadastros.
 * Também aparece colado ("VLM-222P") e como estampa ("VLM-222EST").
 *
 * Regra (decisão do dono, 13/07): corta tudo DEPOIS do último dígito.
 *   VMS-223 MA → VMS-223 · VLM-222P → VLM-222 · 900658M → 900658
 *   VLM-2225   → VLM-2225   (dígito é núcleo: produto diferente não se mistura)
 *   GRAVATA    → GRAVATA    (REF sem dígito fica como está)
 *
 * ⚠️ NÃO tente adivinhar a cor pelo sufixo. "MA" é marinho aqui e pode ser
 * outra coisa na peça do lado — o sufixo agrupa a família, quem diz a cor é a
 * coluna COR do catálogo.
 *
 * A regra morava só na busca (ProductSearchService.refBaseOf). Ficha, fotos e
 * importação usavam cada uma o seu jeito — ou nenhum — e por isso a mesma peça
 * aparecia como quatro produtos na tela de Produto Master. Regra duplicada é
 * regra que diverge: quem precisar de REF-BASE importa daqui.
 */
export function refBaseOf(ref: unknown): string {
  const up = String(ref ?? '').trim().toUpperCase();
  const semSufixo = up.replace(/[^0-9]+$/, '');
  return semSufixo || up;
}

/**
 * As duas chaves de busca de uma REF, sem repetir: a base e a REF como veio.
 *
 * Serve pra ler acervo antigo: fotos gravadas antes da unificação estão sob a
 * REF inteira ("VLM-222EST"), as novas estão sob a base. Procurar nas duas é o
 * que evita "a foto sumiu" no dia da mudança.
 */
export function refsDeBusca(ref: unknown): string[] {
  const up = String(ref ?? '').trim().toUpperCase();
  const base = refBaseOf(up);
  return base === up ? [base] : [base, up];
}
