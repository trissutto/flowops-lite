/**
 * FOTO NO WORDPRESS APAGADO NÃO É FOTO — a régua única do que pode aparecer.
 *
 * ── O QUE FOI MEDIDO EM 14/09/2026 ──
 *
 * 48 dos 945 itens de `lurds.com.br/feed/google.xml` — e os MESMOS 48 no
 * `/feed/meta.xml` — saíam com a capa (`<g:image_link>`) apontando pra
 * `https://lurds.com.br/wp-content/uploads/...`, mais 152
 * `additional_image_link` no mesmo endereço. Esse caminho é o WordPress que a
 * KingHost APAGOU em 27/08/2026: hoje o firewall da Vercel responde
 * **HTTP 403** (`text/plain`, `X-Vercel-Mitigated: deny`) antes de chegar em
 * rota nenhuma, e o `www` não salva (301 pro apex e o mesmo 403 de volta).
 * Item de feed com imagem que não abre é REPROVADO pelo Google — o anúncio
 * nunca roda e o diagnóstico do Merchant acusa a conta inteira.
 *
 * 🚨 E o feed era a parte MENOS grave. A mesma URL saía na VITRINE: medido com
 * `curl` nas PDPs `ref-700906`, `ref-VMM-123` e `ref-26710`, o HTML servia 46,
 * 81 e 40 ocorrências de `wp-content`. Ou seja: durante 18 dias a cliente
 * abriu essas peças e viu buraco no lugar da roupa. Foto quebrada na cara da
 * cliente é pior que anúncio reprovado.
 *
 * ── DE ONDE VINHA ──
 *
 * `montarPeca` (loja-catalog) monta a galeria com as fotos próprias do R2
 * (`product_photos`) e, quando a peça não tem NENHUMA, cai no acervo que veio
 * do WooCommerce no import (`site_produto.imagens`, `origem:'wc'`). Esse
 * fallback fazia sentido enquanto o WordPress respondia — era "o resto do
 * acervo até a migração de imagem terminar". Em 27/08 ele deixou de ser
 * acervo e virou link morto, e ninguém mexeu no fallback. As 48 peças são
 * exatamente as publicadas que não têm uma única foto no R2.
 *
 * ── A REGRA ──
 *
 * Foto em `/wp-content/` é MORTA: não entra em galeria, não entra em feed,
 * não vira capa. Descarta e promove a próxima foto válida da peça. Peça que
 * ficar sem NENHUMA foto válida fica SEM FOTO — e aí vale a regra que já
 * existe no `montarCatalogo` (item 39): peça sem foto não chega à vitrine, e
 * como o feed sai da mesma lista, também não vira item reprovado.
 *
 * ⚠️ NÃO existe conserto na borda pra isso. Não se reescreve a URL pra um
 * proxy (não há servidor atrás), não se inventa placeholder e não se empresta
 * foto de outra peça — o site mostra só foto oficial, e o incidente de "foto
 * de outra peça" (casamento por md5) já custou capa errada na vitrine. Peça
 * sem foto viva precisa de FOTO NOVA; o caminho é fotografar e subir pro R2.
 *
 * ⚠️ O corte é pelo CAMINHO, nunca pelo host. `lurds.com.br` é o site VIVO —
 * cortar por host mataria qualquer imagem legítima que um dia sirvamos do
 * nosso próprio domínio. O que morreu foi a árvore de uploads do WordPress.
 * O caminho relativo (`/wp-content/uploads/...`, que era o que o `wp-db`
 * devolvia quando não achava o `siteurl`) casa pela mesma régua.
 */

/**
 * Os caminhos que o WordPress apagado servia. `wp-content` é onde ficavam os
 * uploads; `wp-includes` entra junto porque é o outro diretório que o import
 * antigo poderia ter carimbado (imagens de tema) e o estrago é o mesmo 403.
 */
const CAMINHOS_DO_WP_MORTO = /\/wp-(content|includes)\//i;

/** `true` = esta URL é do WordPress apagado e não abre pra ninguém. */
export function fotoMorta(url: unknown): boolean {
  const u = String(url ?? '').trim();
  if (!u) return true; // sem endereço também não abre — é foto morta igual
  return CAMINHOS_DO_WP_MORTO.test(u);
}

/** O contrário de `fotoMorta`, pra usar direto em `.filter()`. */
export function fotoViva(url: unknown): boolean {
  return !fotoMorta(url);
}

/**
 * Filtra uma lista de fotos preservando a ORDEM — é a ordem que decide a capa.
 *
 * `endereco` diz onde mora a URL em cada item, porque a mesma lista chega em
 * três formatos no catálogo: `{ url }` (linha de `product_photos`), `{ src }`
 * (galeria montada e o acervo do WC) e string crua (o que o feed publica).
 */
export function fotosVivas<T>(
  lista: readonly T[] | null | undefined,
  endereco: (item: T) => unknown,
): T[] {
  return (lista ?? []).filter((f) => f != null && fotoViva(endereco(f)));
}
