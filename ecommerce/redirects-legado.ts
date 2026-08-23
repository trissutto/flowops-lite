/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MAPA DE REDIRECT DO SITE ANTIGO (WooCommerce em lurds.com.br)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Este arquivo existe porque o domínio `lurds.com.br` deixou de servir o
 * WordPress e passou a servir esta loja. Toda URL que a cliente tem salva, que
 * o Google indexou ou que algum post do Instagram aponta continua chegando —
 * e chega aqui.
 *
 * ── O QUE **NÃO** ESTÁ AQUI, E POR QUÊ ──
 *
 * **Produto não tem redirect.** O importador copiou o slug do WooCommerce
 * (`site_produto.slug = wc_slug`) e esta loja serve `/produto/<slug>` no mesmo
 * caminho: das 641 URLs de produto do sitemap antigo, **624 já respondiam 200
 * aqui antes de qualquer regra** (medido em 19/08/2026, uma a uma). Só as 17
 * peças que saíram do catálogo aparecem embaixo, cada uma pra sua categoria.
 *
 * ── A ORDEM IMPORTA ──
 *
 * O Next usa a PRIMEIRA regra que casa. Por isso a lista vai do específico pro
 * genérico: filha antes de mãe, mãe antes do curinga, curinga por último. Se
 * `/categoria-produto/:qualquer*` subisse pro topo, engoliria as 54 regras.
 *
 * ── DE ONDE VEIO CADA DESTINO ──
 *
 * Não é chute: é a Search Console de 16 meses (exportada em 19/08/2026,
 * 38,9 mil cliques). O que manda no mapa é clique, não a árvore do
 * WooCommerce. Duas consequências que só o dado mostrou:
 *
 * 1. **O sitemap antigo mente sobre as duas maiores categorias.** Ele lista
 *    `vestidos-plus-size2` e `outono_inverno2`; quem tem tráfego é a versão
 *    SEM o `2` (2.866 e 782 cliques). As duas formas entram.
 * 2. **`/tree` foi invadido e virou `/nossaslojas`** — o WordPress já fazia
 *    esse 301 internamente, e a ponte ainda trouxe 613 cliques em 90 dias.
 *    Quando o WordPress sai, quem segura as DUAS pontas é esta lista.
 */

export interface RedirectLegado {
  source: string;
  destination: string;
  permanent: boolean;
}

/** Açúcar pra não repetir `/categoria/` 40 vezes e errar um. */
const cat = (slug: string) => `/categoria/${slug}`;

/** Uma categoria antiga e todas as filhas dela caindo no mesmo lugar. */
function familia(origem: string, destino: string): RedirectLegado[] {
  return [
    { source: `/categoria-produto/${origem}`, destination: destino, permanent: true },
    { source: `/categoria-produto/${origem}/:sub*`, destination: destino, permanent: true },
  ];
}

/**
 * As peças que saíram do catálogo. 404 seco aqui seria desperdício: a REF está
 * no próprio slug, então dá pra mandar cada uma pra vitrine da categoria dela,
 * que é onde a cliente encontra a substituta.
 */
const PRODUTOS_MORTOS: Record<string, string> = {
  'calca-feminina-pantalona-plus-size-ref-69010-musgo': cat('calcas'),
  'calca-feminina-pantalona-plus-size-ref-69010-preto': cat('calcas'),
  'calca-feminina-pantacourt-plus-size-ref-800267-bege': cat('calcas'),
  'calca-feminina-pantacourt-plus-size-ref-800267-cinza': cat('calcas'),
  'conjunto-feminino-inverno-blusa-manga-longa-calca-plus-size-ref-12105-terra': cat('conjuntos'),
  'blusa-feminina-manga-curta-plus-size-ref-12690-verde': cat('blusas'),
  'blusa-feminina-manga-longa-plus-size-ref-207367-preta': cat('blusas'),
  'blusa-feminina-manga-curta-plus-size-ref-s01822-gelo': cat('blusas'),
  'blusa-feminina-manga-curta-plus-size-puggy-marrie-puggyoff': cat('blusas'),
  'vestido-manga-curta-plus-size-ref-900817-estampa-laranja': cat('vestidos'),
  'vestido-sem-manga-plus-size-ref-207299-preto': cat('vestidos'),
  'vestido-sem-manga-plus-size-ref-207286-terracota': cat('vestidos'),
  'vestido-longo-sem-manga-plus-size-ref-207272-preto': cat('vestidos'),
  'vestido-sem-manga-plus-size-ref-900756-verde': cat('vestidos'),
  'macacao-longo-feminino-sem-manga-plus-size-ref-900821-preto': cat('macacoes'),
  'macacao-longo-feminino-sem-manga-plus-size-ref-900821-marrom': cat('macacoes'),
  // Rascunho que o WordPress jogou na lixeira e o Google indexou assim mesmo.
  __trashed: '/categoria',
};

/**
 * O SLUG DE LOJA DO WORDPRESS → O SLUG DAQUI.
 *
 * O WordPress escrevia tudo emendado (`analiafranco`, `praiagrande`,
 * `saojosedoscampos`); o `lojas.json` usa hífen (`analia-franco`). Sem este
 * mapa, repassar `:cidade` adiante mandaria a cliente de Anália Franco pra um
 * 404 novo em folha — o oposto do que a mudança quer.
 *
 * As chaves saíram da Search Console (90 dias, filtro `nossaslojas`), não de
 * palpite: são exatamente as URLs que o Google ainda serve.
 *
 * ⚠️ `itu` aparece lá mas NÃO está no `lojas.json` — a unidade saiu da rede.
 * Fica de fora de propósito: o curinga manda pro índice, que é o certo pra
 * quem procura uma loja que fechou.
 */
const LOJA_POR_SLUG_ANTIGO: Record<string, string> = {
  analiafranco: 'analia-franco',
  campinas: 'campinas',
  indaiatuba: 'indaiatuba',
  itanhaem: 'itanhaem',
  jundiai: 'jundiai',
  limeira: 'limeira',
  moema: 'moema',
  piracicaba: 'piracicaba',
  praiagrande: 'praia-grande',
  santos: 'santos',
  saojosedoscampos: 'sao-jose-dos-campos',
  sorocaba: 'sorocaba',
  suzano: 'suzano',
  vinhedo: 'vinhedo',
};

/**
 * As cidades que aparecem SOLTAS na raiz do domínio (`/CAMPINAS`).
 *
 * Sai do mesmo mapa acima pra não existirem duas listas de loja divergindo —
 * é o slug NOVO que vale aqui, porque a página é `/lojas/<slug novo>`.
 * `praia-grande` já tem regra própria mais abaixo (8.401 impressões) e entra
 * de novo sem prejuízo: a primeira que casar vence.
 */
const LOJAS_NA_RAIZ = [...new Set(Object.values(LOJA_POR_SLUG_ANTIGO))];

export const redirectsLegado: RedirectLegado[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. O PREFIXO `/index.php/` — o WordPress fazia, a Vercel não faz
  // ═══════════════════════════════════════════════════════════════════════════
  // Vem PRIMEIRO porque `/index.php/politicas-de-trocas/` precisa virar
  // `/politicas-de-trocas` antes de a regra da página legal poder casar.
  // Não é URL de museu: a descrição importada de VÁRIOS produtos linka pra
  // `lurds.com.br/index.php/politicas-de-trocas/` no meio do texto — depois da
  // virada esse link aponta pra dentro de casa e daria 404 na própria PDP.
  { source: '/index.php/:caminho*', destination: '/:caminho*', permanent: true },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. AS 17 PEÇAS QUE SAÍRAM DO CATÁLOGO
  // ═══════════════════════════════════════════════════════════════════════════
  // Regras EXATAS, nunca com curinga: `/produto/:s(vestido.*)` sequestraria as
  // 624 peças vivas, porque redirect roda ANTES do roteamento.
  ...Object.entries(PRODUTOS_MORTOS).map(([slug, destino]) => ({
    source: `/produto/${slug}`,
    destination: destino,
    permanent: true,
  })),

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CATEGORIAS — 34% do clique do domínio
  // ═══════════════════════════════════════════════════════════════════════════
  // Filhas específicas primeiro (a mãe cairia em cima delas).
  { source: '/categoria-produto/outono_inverno/vestidos-inverno', destination: cat('vestidos'), permanent: true },
  { source: '/categoria-produto/outono_inverno2/vestidos-inverno', destination: cat('vestidos'), permanent: true },
  { source: '/categoria-produto/outono_inverno/conjuntos-de-inverno', destination: cat('conjuntos'), permanent: true },
  { source: '/categoria-produto/outono_inverno2/conjuntos-de-inverno', destination: cat('conjuntos'), permanent: true },
  { source: '/categoria-produto/outono_inverno/blusas_outono_inverno', destination: cat('blusas'), permanent: true },
  { source: '/categoria-produto/outono_inverno2/blusas_outono_inverno', destination: cat('blusas'), permanent: true },

  // As duas maiores do domínio. A forma sem `2` é a que tem o tráfego
  // (2.866 e 782 cliques); a com `2` é a que está no sitemap. As duas valem.
  ...familia('vestidos-plus-size', cat('vestidos')),
  ...familia('vestidos-plus-size2', cat('vestidos')),
  ...familia('outono_inverno', cat('jaquetas')),
  ...familia('outono_inverno2', cat('jaquetas')),

  // `plus_size` é a MAIOR categoria do site antigo (3.938 cliques) e não tem
  // equivalente aqui: era o "tudo plus size" do Woo. Vai pro índice de
  // categorias até existir uma vitrine de verdade pra ela.
  ...familia('plus_size', '/categoria'),

  ...familia('blusas_plus_size', cat('blusas')),
  ...familia('conjuntos', cat('conjuntos')),
  ...familia('calcas_plus_size', cat('calcas')),
  ...familia('saias_plus_size', cat('saias')),
  ...familia('shorts-bermudas-plus-size', cat('shorts')),
  ...familia('macacao-macaquinho-plus-size', cat('macacoes')),
  ...familia('moda_praia', cat('moda-praia')),
  // Moda íntima e cinta modeladora viram a mesma vitrine: `lingerie` é a
  // categoria que existe aqui, e é onde as duas famílias se encontram.
  ...familia('moda_intima', cat('lingerie')),
  ...familia('cinta_modeladora', cat('lingerie')),
  // Blazer e cardigã não têm vitrine própria; jaquetas é o vizinho honesto.
  ...familia('blazer', cat('jaquetas')),
  ...familia('inverno', cat('jaquetas')),
  ...familia('t-shirts', cat('blusas')),
  // Festa e ano-novo eram coleção de vestido, não categoria de peça.
  ...familia('festas', cat('vestidos')),
  ...familia('ano-novo', cat('vestidos')),
  ...familia('live-verao', cat('moda-praia')),

  // Recortes que aqui são página própria, não categoria.
  ...familia('outlet', '/outlet'),
  ...familia('lancamentos-de-moda-plus-size', '/novidades'),
  ...familia('maiores-tendencias-em-moda-plus-size', '/novidades'),
  ...familia('primavera-verao-2024', '/novidades'),
  ...familia('especial-dia-das-maes', '/novidades'),
  ...familia('queridinhos', '/mais-top-da-semana'),
  ...familia('best01', '/mais-top-da-semana'),
  ...familia('best02', '/mais-top-da-semana'),
  // Faixa de preço: o site novo tem a mesma ideia com URL própria.
  ...familia('ate-9990', '/ate/99-90'),
  ...familia('5990', '/ate/59-90'),
  // Marca, não categoria — a busca é quem sabe responder isso.
  ...familia('marrie-plus-size', '/busca?q=marrie'),
  // Categoria da live e uma numérica órfã: sem equivalente, vão pro índice.
  ...familia('live', '/categoria'),
  ...familia('207372', '/categoria'),

  // Curinga: qualquer categoria antiga que não esteja mapeada acima cai no
  // índice em vez de 404. Fica no FIM, senão engole todas as regras acima.
  { source: '/categoria-produto/:qualquer*', destination: '/categoria', permanent: true },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. TAGS DE PRODUTO — 978 URLs, das quais só 71 tiveram algum clique
  // ═══════════════════════════════════════════════════════════════════════════
  // Página magra do WooCommerce ("vestido-rosa", "calca-jeans-para-gordinha").
  // A regra é por palavra: o prefixo do slug já diz a categoria em 690 delas.
  // O regex mora no próprio parâmetro — recurso do Next, não gambiarra.
  { source: '/produto-tag/:s(vestido.*)', destination: cat('vestidos'), permanent: true },
  { source: '/produto-tag/:s(blusa.*)', destination: cat('blusas'), permanent: true },
  { source: '/produto-tag/:s(camis.*)', destination: cat('blusas'), permanent: true },
  { source: '/produto-tag/:s(cropped.*)', destination: cat('blusas'), permanent: true },
  { source: '/produto-tag/:s(regata.*)', destination: cat('blusas'), permanent: true },
  { source: '/produto-tag/:s(t-shirt.*)', destination: cat('blusas'), permanent: true },
  { source: '/produto-tag/:s(calca.*)', destination: cat('calcas'), permanent: true },
  { source: '/produto-tag/:s(pantalona.*)', destination: cat('calcas'), permanent: true },
  { source: '/produto-tag/:s(conjunto.*)', destination: cat('conjuntos'), permanent: true },
  { source: '/produto-tag/:s(macac.*)', destination: cat('macacoes'), permanent: true },
  { source: '/produto-tag/:s(saia.*)', destination: cat('saias'), permanent: true },
  { source: '/produto-tag/:s(short.*)', destination: cat('shorts'), permanent: true },
  { source: '/produto-tag/:s(bermuda.*)', destination: cat('shorts'), permanent: true },
  { source: '/produto-tag/:s(biquini.*)', destination: cat('moda-praia'), permanent: true },
  { source: '/produto-tag/:s(maio.*)', destination: cat('moda-praia'), permanent: true },
  { source: '/produto-tag/:s(saida-de-praia.*)', destination: cat('moda-praia'), permanent: true },
  { source: '/produto-tag/:s(lingerie.*)', destination: cat('lingerie'), permanent: true },
  { source: '/produto-tag/:s(sutia.*)', destination: cat('lingerie'), permanent: true },
  { source: '/produto-tag/:s(calcinha.*)', destination: cat('lingerie'), permanent: true },
  { source: '/produto-tag/:s(cinta.*)', destination: cat('lingerie'), permanent: true },
  { source: '/produto-tag/:s(body.*)', destination: cat('lingerie'), permanent: true },
  { source: '/produto-tag/:s(jaqueta.*)', destination: cat('jaquetas'), permanent: true },
  { source: '/produto-tag/:s(casaco.*)', destination: cat('jaquetas'), permanent: true },
  { source: '/produto-tag/:s(cardigan.*)', destination: cat('jaquetas'), permanent: true },
  { source: '/produto-tag/:s(blazer.*)', destination: cat('jaquetas'), permanent: true },
  // As outras 288 são cor, tecido e ocasião solta ("animal-print", "viscose").
  // Sem categoria óbvia: caem no índice, que ao menos é vitrine.
  { source: '/produto-tag/:qualquer*', destination: '/categoria', permanent: true },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. LOJAS — e a ponte dupla do `/tree`
  // ═══════════════════════════════════════════════════════════════════════════
  // `/tree` era o link da bio do Instagram, uma página por loja. Foi invadido,
  // e por isso o WordPress passou a redirecioná-lo pra `/nossaslojas`. Some o
  // WordPress, some o desvio: as duas famílias precisam apontar pra cá.
  //
  // ── CADA CIDADE PRA SUA PÁGINA (23/08/2026) ──
  //
  // Até aqui as duas famílias caíam na `/lojas` genérica, porque a página por
  // cidade não existia. Ela existe desde hoje (`app/(public)/lojas/[cidade]`),
  // e o desperdício era medido: na Search Console, 90 dias,
  // `/nossaslojas/<cidade>` traz clique com nome de cidade em quase toda
  // unidade (jundiai 36, moema 33, analiafranco 27, piracicaba 24,
  // indaiatuba 23, itanhaem 22, campinas 20, saojosedoscampos 17…) e o `/tree`
  // sozinho ~50 por semana. Tudo isso aterrissava num índice de 14 lojas.
  //
  // ⚠️ O SLUG ANTIGO NÃO É O NOVO — ver `LOJA_POR_SLUG_ANTIGO` no topo.
  //
  // As específicas vêm primeiro; os curingas logo abaixo continuam existindo
  // pra cidade que não casar (a `itu`, que fechou, e qualquer lixo inventado).
  ...Object.entries(LOJA_POR_SLUG_ANTIGO).flatMap(([antigo, novo]) => [
    { source: `/tree/${antigo}`, destination: `/lojas/${novo}`, permanent: true },
    { source: `/nossaslojas/${antigo}`, destination: `/lojas/${novo}`, permanent: true },
  ]),

  // A raiz das duas famílias e o que não casou acima: índice das 14.
  { source: '/tree', destination: '/lojas', permanent: true },
  { source: '/tree/:cidade*', destination: '/lojas', permanent: true },
  { source: '/nossaslojas', destination: '/lojas', permanent: true },
  { source: '/nossaslojas/:cidade*', destination: '/lojas', permanent: true },
  // Loja que ganhou URL na raiz do domínio, fora do padrão (8.401 impressões).
  // Agora tem página própria pra onde ir.
  { source: '/praia-grande', destination: '/lojas/praia-grande', permanent: true },

  /**
   * CIDADE SOLTA NA RAIZ, EM CAIXA ALTA (23/08/2026).
   *
   * Achado na amostra de 404 da Search Console: `/CAMPINAS`, rastreado em
   * 22/08. Não é `/tree/campinas` nem `/nossaslojas/campinas` — é o nome da
   * cidade direto na raiz, do jeito que alguém escreveu num link de bio.
   * Cada uma dessas hoje cai em erro, e o destino existe.
   *
   * O `source` do Next casa sem diferenciar caixa, então uma regra por loja
   * cobre `/CAMPINAS`, `/campinas` e `/Campinas`.
   */
  ...LOJAS_NA_RAIZ.map((slug) => ({
    source: `/${slug}`,
    destination: `/lojas/${slug}`,
    permanent: true,
  })),

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. RASTREIO — a 2ª página mais clicada do domínio
  // ═══════════════════════════════════════════════════════════════════════════
  // 2.060 cliques em 90 dias, CTR de 33%: é a cliente que JÁ COMPROU digitando
  // "rastreio lurds" pra ver onde está a encomenda. Quatro endereços diferentes
  // acumulados ao longo dos anos, todos pro mesmo lugar.
  { source: '/orders-tracking', destination: '/rastreio', permanent: true },
  { source: '/acompanhar_pedidos', destination: '/rastreio', permanent: true },
  { source: '/track-order', destination: '/rastreio', permanent: true },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. TAMANHO — o WooCommerce tinha uma landing por número
  // ═══════════════════════════════════════════════════════════════════════════
  // `/tamanho-46/` → `/tamanhos/46`. Casa direto, um pra um.
  { source: '/tamanho-:numero(\\d{2})', destination: '/tamanhos/:numero', permanent: true },
  /**
   * A FORMA COM BARRA — `/tamanho/54/` (23/08/2026).
   *
   * A regra acima cobria só o hífen. A Search Console mostrou `/tamanho/54/` e
   * `/tamanho/54/page/4/` em 404, rastreados em 21/08. É a mesma landing por
   * número do WooCommerce, escrita do outro jeito — e "tamanho 54" é a busca
   * mais valiosa que existe nesta loja.
   *
   * A paginada vai pro mesmo lugar: `/tamanhos/54` já é a lista inteira.
   */
  { source: '/tamanho/:numero(\\d{2})', destination: '/tamanhos/:numero', permanent: true },
  { source: '/tamanho/:numero(\\d{2})/page/:p*', destination: '/tamanhos/:numero', permanent: true },
  { source: '/tamanho/:resto*', destination: '/tamanhos', permanent: true },

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. PÁGINAS DO WORDPRESS
  // ═══════════════════════════════════════════════════════════════════════════
  { source: '/shop', destination: '/categoria', permanent: true },
  /**
   * A vitrine do Woo era paginada e filtrada por query — `/shop/page/10/?...`
   * apareceu em 404 na amostra de 23/08. A raiz já ia pra `/categoria`; as
   * páginas 2 em diante não iam a lugar nenhum.
   */
  { source: '/shop/:resto*', destination: '/categoria', permanent: true },
  /**
   * `/colecoes/alfaiataria` e irmãs: a coleção editorial do WordPress não tem
   * equivalente um-a-um aqui. Vai pro índice de categorias, que é o lugar mais
   * próximo da intenção — melhor que erro, honesto sobre não ser a mesma página.
   */
  { source: '/colecoes/:resto*', destination: '/categoria', permanent: true },
  { source: '/colecoes', destination: '/categoria', permanent: true },
  { source: '/destaques', destination: '/mais-top-da-semana', permanent: true },
  { source: '/cupom', destination: '/novidades', permanent: true },

  // Políticas: o Woo tinha três endereços pra cada assunto.
  { source: '/politicas-de-trocas', destination: '/politica-de-trocas', permanent: true },
  { source: '/politica-de-privacidade', destination: '/privacidade', permanent: true },
  { source: '/politica-de-cookies', destination: '/privacidade', permanent: true },
  { source: '/exclusao-de-dados', destination: '/privacidade', permanent: true },
  { source: '/termosdeuso', destination: '/termos', permanent: true },
  { source: '/termos-de-servico', destination: '/termos', permanent: true },
  { source: '/politicas-de-vendas', destination: '/termos', permanent: true },

  // Conta e carrinho do WooCommerce.
  // ⚠️ A senha antiga NÃO veio: aqui o login é por CPF. Quem chegar por estes
  // links precisa da tela de conta explicando isso, não de um formulário mudo.
  { source: '/minha-conta', destination: '/conta', permanent: true },
  { source: '/minha-conta/:resto*', destination: '/conta', permanent: true },
  { source: '/my-account', destination: '/conta', permanent: true },
  { source: '/my-account/:resto*', destination: '/conta', permanent: true },
  { source: '/cart', destination: '/carrinho', permanent: true },
  { source: '/cart-2', destination: '/carrinho', permanent: true },
  { source: '/faleconosco', destination: '/lojas', permanent: true },

  // Programa de afiliados e painel: não existem nesta loja e não vão existir.
  // Vão pra home em vez de 404 porque ainda há link solto apontando pra lá.
  { source: '/area-afiliado', destination: '/', permanent: true },
  { source: '/affiliate-login', destination: '/', permanent: true },
  { source: '/registro-de-afiliados', destination: '/', permanent: true },
  { source: '/painel', destination: '/', permanent: true },

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. O QUE NÃO ENTRA AQUI DE PROPÓSITO
  // ═══════════════════════════════════════════════════════════════════════════
  // As ~82 URLs de demonstração do tema Flatsome (`/elements/*`, `/demos/*`,
  // `/banner-4/`, `/home-teste/`) e os 8 posts de blog que nunca foram nossos
  // ("welcome-to-flatsome") NÃO ganham redirect. Mandar lixo de tema pra home
  // só ensina o Google que a home responde por qualquer coisa. Eles caem no
  // 404 desta loja, que é a resposta correta pra página que nunca deveria ter
  // existido.
];
