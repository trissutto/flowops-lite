import type { ZodError } from 'zod';

/**
 * NOME do campo que reprovou o pedido — nunca o VALOR dele.
 *
 * Por que existe: `validation_error` chegava na retaguarda como "Dados do
 * pedido incompletos" e ninguém conseguia dizer QUAL dado. As sessões do
 * painel mostram gente tentando 4, 5, 6 vezes o mesmo pedido e falhando
 * sempre pelo mesmo motivo invisível — pra ela e pra gente.
 *
 * O caminho do zod vira o vocabulário curto que o painel já rotula:
 *
 *   ['customer','cpf']            → 'cpf'
 *   ['shippingAddress','number']  → 'number'
 *   ['items',3,'image','src']     → 'item_image_src'
 *   ['shippingQuoteId']           → 'shippingQuoteId'
 *
 * O índice do item some de propósito: guardar `items.3` racharia a contagem
 * em uma linha por posição da sacola e esconderia que é sempre o mesmo campo.
 */
export function campoDoZod(error: ZodError): string {
  const caminho = error.issues[0]?.path ?? [];
  const partes = caminho.filter((p): p is string => typeof p === 'string');
  if (!partes.length) return 'payload';
  if (partes[0] === 'items') return ['item', ...partes.slice(1)].join('_');
  if (partes[0] === 'customer' || partes[0] === 'shippingAddress') {
    return partes.slice(1).join('_') || partes[0];
  }
  return partes.join('_');
}
