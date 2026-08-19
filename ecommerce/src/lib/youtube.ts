/**
 * VÍDEO DA PEÇA — o link que a retaguarda cola vira id, capa e embed.
 *
 * O campo "Vídeo (YouTube)" da tela master (`produto_ficha_cor.youtube_url`)
 * guarda a URL COMO VEIO — e vem de todo jeito: o botão Compartilhar do
 * celular manda `youtu.be/ID?si=...`, o do desktop manda `watch?v=ID&t=12`,
 * quem grava vertical manda `/shorts/ID`, e tem quem cole só o id. Um lugar
 * só entende todos, porque a alternativa é o vídeo cadastrado não aparecer e
 * ninguém saber por quê (foi o que aconteceu até 19/08).
 */

/** O id do YouTube tem 11 caracteres — este alfabeto, sempre. */
const ID = '[A-Za-z0-9_-]{11}';
const SO_O_ID = new RegExp(`^${ID}$`);
/** Onde o id aparece nas URLs: youtu.be/, /embed/, /shorts/, /live/, ?v= e /v/. */
const NA_URL = new RegExp(`(?:youtu\.be/|/embed/|/shorts/|/live/|[?&]v=|/v/)(${ID})`);

/**
 * `null` quando não dá pra ter certeza. Link de outro site, texto solto ou
 * campo vazio não viram vídeo quebrado na página da cliente — viram nada.
 */
export function youtubeId(entrada?: string | null): string | null {
  const bruto = (entrada ?? '').trim();
  if (!bruto) return null;
  if (SO_O_ID.test(bruto)) return bruto;
  return bruto.match(NA_URL)?.[1] ?? null;
}

/**
 * Capa do vídeo. `hqdefault` de propósito: `maxresdefault` só existe em vídeo
 * gravado em alta e devolve 404 no resto — capa que falha derruba o
 * next/image e o slide vira quadro cinza.
 */
export function youtubeCapa(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/**
 * Embed no domínio `-nocookie`: sem ele o YouTube grava cookie de rastreio
 * assim que o player monta — antes de a cliente ter dito qualquer coisa no
 * banner de consentimento.
 *
 * `autoplay=1` porque o player só é montado no clique dela: quem clicou no ▶
 * já pediu o vídeo, e obrigar a clicar de novo dentro do iframe é o que faz a
 * pessoa desistir. `rel=0` mantém as sugestões do fim dentro do canal.
 */
export function youtubeEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
}
