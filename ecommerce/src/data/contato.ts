/**
 * O WHATSAPP DO SITE — um número, um lugar (dono, 12/08/2026).
 *
 * ⚠️ Achado que motivou este arquivo: o site tinha DOIS números errados
 * espalhados. `5513996050174` aparecia chumbado em sete telas (home, buy box,
 * rodapé, menu mobile, categoria, busca, assistente de tamanho) e a
 * confirmação do pedido usava `5511978106947` — que é o WhatsApp da LOJA
 * Anália Franco. Quem acabava de comprar caía no atendimento de uma loja
 * física específica, com a mensagem "acabei de fazer o pedido LP-000007".
 *
 * Número repetido é número que diverge: basta uma das cópias envelhecer.
 * Quem precisar do WhatsApp do site importa daqui.
 *
 * Isto é o atendimento do SITE. O WhatsApp de cada loja física continua no
 * cadastro dela (`data/lojas.json`), porque ali o número por unidade é o
 * certo — a cliente quer falar com a loja onde vai retirar.
 */
export const WHATSAPP_ATENDIMENTO = '5513996256238';

/**
 * Link pronto pro WhatsApp, com o texto já escapado.
 *
 * SEM EMOJI nas mensagens automáticas: o 💛 do fim da mensagem de
 * confirmação chegou como "" na tela do WhatsApp (print do dono, 12/08).
 * O fonte estava correto em UTF-8 — quem reinterpretou foi a página
 * intermediária do WhatsApp. Não vale arriscar um caractere quebrado logo na
 * primeira mensagem de quem acabou de comprar.
 */
export function linkWhatsapp(texto?: string): string {
  const base = `https://api.whatsapp.com/send?phone=${WHATSAPP_ATENDIMENTO}`;
  const t = String(texto || '').trim();
  return t ? `${base}&text=${encodeURIComponent(t)}` : base;
}

/**
 * O CARIMBO GERAL — todo botão de WhatsApp do site abre com ele preenchido.
 *
 * Não é cosmético: "vim pelo site" é o CONTRATO DE PARSE da automação
 * (Evolution/n8n) que transforma a mensagem recebida em LEAD com telefone e
 * origem na tela /retaguarda/leads-whatsapp. Os botões de LOJA têm o carimbo
 * próprio ("Quero conhecer a loja X (vim pelo site)", ver `lojas/lib.ts`) —
 * este aqui é o dos botões gerais, que abriam a conversa em branco e a
 * automação não tinha como reconhecer. Mudar o texto quebra o reconhecimento
 * sem dar erro em lugar nenhum.
 */
export const LINK_WHATSAPP_SITE = linkWhatsapp('Olá! Vim pelo site.');
