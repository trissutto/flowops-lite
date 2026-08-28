/**
 * O NOME DA TRANSPORTADORA QUE A CLIENTE LÊ (28/08/2026).
 *
 * "Mais Envios" é o CONTRATO de frete, não quem entrega — a etiqueta deles
 * viaja pelos Correios. Mostrar "Mais Envios SEDEX" pra cliente fez ela
 * pesquisar o nome, cair no site DELES e tomar o suporte deles pelo nosso
 * (caso real de 28/08). Pra cliente é sempre Correios; o carrier cru
 * continua valendo nos registros internos e nas telas da operação.
 *
 * Usar em TODA saída voltada à cliente: WhatsApp/e-mail de pedido, push do
 * app, lista de pedidos da conta, detalhe público do pedido.
 */
export function transportadoraParaCliente(carrier?: string | null): string {
  const c = String(carrier || 'Correios').trim() || 'Correios';
  if (/mais\s*envios/i.test(c)) {
    const servico = /sedex/i.test(c) ? ' SEDEX' : /pac/i.test(c) ? ' PAC' : '';
    return `Correios${servico}`;
  }
  return c;
}
