/**
 * A TAG DA SEPARAÇÃO AUTOMÁTICA (dono, 25/09/2026).
 *
 * O `confirmRoute` grava o preview inteiro em `Order.routingResult`; quando
 * quem roteou foi a máquina (`SeparacaoAutomaticaService`), o preview vai
 * com `automatico: { em, origem, versao }`. Esta régua lê isso de volta pra
 * lista da retaguarda e pra tela do pedido dizerem "🤖 AUTO" — sem coluna
 * nova no banco (nada de `db push` por uma tag).
 */
export function routingFoiAutomatico(routingResult: string | null | undefined): boolean {
  if (!routingResult) return false;
  try {
    const j = JSON.parse(String(routingResult));
    return !!j?.automatico;
  } catch {
    return false;
  }
}
