import { redirect } from 'next/navigation';

/**
 * ACOMPANHAMENTO DO PEDIDO — a URL pública e compartilhável (item 76).
 *
 * A tela de acompanhamento já existia, mas só em
 * `/checkout/confirmacao/<id>` — uma URL que diz "checkout" e "confirmação"
 * pra quem só quer saber onde está a peça. Ninguém guarda esse link, e é
 * exatamente o link que a cliente cola no WhatsApp pra perguntar do pedido.
 *
 * `/pedido/<id>` é o endereço que se manda por mensagem. Redireciona em vez de
 * duplicar a tela: uma cópia da página de confirmação envelheceria em semanas,
 * e aí as duas mostrariam coisas diferentes do mesmo pedido.
 *
 * O id é longo e aleatório (uuid) — é ele que faz as vezes de senha. Mesmo
 * assim o backend devolve o CPF MASCARADO, porque link compartilhado é link
 * que vaza.
 */
export default async function AcompanharPedidoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/checkout/confirmacao/${encodeURIComponent(id)}`);
}
