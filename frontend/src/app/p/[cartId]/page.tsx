/**
 * /p/<code> — atalho CURTO da página pública de fechamento (/pagar/<uuid>).
 * O backend resolve o payCode de 8 chars pro carrinho; a página é a mesma.
 * Mantém o mesmo nome de parâmetro (cartId) pro useParams funcionar igual.
 */
export { default } from '../../pagar/[cartId]/page';
