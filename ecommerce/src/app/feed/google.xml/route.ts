import { api } from '@/lib/api';
import { SITE } from '@/lib/seo';
import { tituloShopping, variantes, type PecaFeed, type Variante } from '@/lib/feed/variantes';

/**
 * FEED DO GOOGLE MERCHANT CENTER — o maior canal da loja, medido.
 *
 * Endereço pra cadastrar:
 *   Merchant Center → Fontes de dados → Adicionar → Feed via URL
 *   https://<dominio>/feed/google.xml   (buscar 1× por dia)
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * Até 19/08/2026 o catálogo do Google era alimentado por um plugin do
 * WooCommerce (`PRODUCTS CATALOG PRO`) que gerava o arquivo DENTRO de
 * `lurds.com.br`. Medição do mesmo dia: **16,78 mil cliques em 28 dias** vindos
 * do Merchant — contra 38,9 mil cliques em 16 MESES de busca orgânica. É o
 * canal de maior volume da casa, com folga.
 *
 * Quando o domínio deixou de servir o WordPress, aquele arquivo deixou de
 * existir. Sem este feed no lugar dele, o Google para de conseguir atualizar,
 * os itens expiram em poucos dias e Shopping e listagem gratuita apagam — sem
 * nenhum aviso dentro da loja.
 *
 * ── A DECISÃO DO `id`, QUE É A PARTE QUE NÃO DÁ PRA ERRAR ──
 *
 * `<g:id>` = a REF crua NA COR PRINCIPAL (a de maior estoque), e sufixo
 * `-COR` nas demais (21/08). Antes era uma REF por item; a peça multicor
 * virava um anúncio só, rotulado com a primeira cor e com as fotos das
 * outras embaralhadas — e para vestuário o Google ESPERA a variação.
 *
 * A herança do id é o que torna a virada barata: pro Google o item da cor
 * principal continua sendo o mesmo de sempre ("1134269", "S237791" seguem
 * existindo), o histórico do Shopping não recomeça, e o `content_ids` do
 * pixel continua casando. Só as cores adicionais são itens novos.
 * ("1134269", "S237791" são REFs), é o que o feed do Meta usa, e é o que o
 * pixel manda em `content_ids`. Id novo não é "só um identificador": o Google
 * trata como produto novo, joga fora o histórico do item e o aprendizado do
 * Shopping recomeça do zero.
 *
 * Consequência assumida: **um item por REF, não um por tamanho.** O feed antigo
 * do plugin publicava variação (por isso 3,69 mil itens pra ~700 peças), e o
 * jeito canônico de fazer moda no Google seria `id = REF-TAMANHO` com
 * `item_group_id = REF`. Só que isso trocaria TODOS os ids de uma vez, no mesmo
 * dia da virada de domínio, e não dá pra fazer duas mudanças grandes de uma vez
 * e depois saber qual delas foi a que doeu. Aqui vale o mesmo princípio da
 * página: **uma peça, uma URL, um item**. Se um dia o tamanho por item fizer
 * falta, migra-se com calma, sozinho, medindo antes e depois.
 *
 * `identifier_exists: no` é obrigatório por causa dessa escolha: a peça não tem
 * GTIN nem MPN, e sem essa declaração o Google reprova o item por identificador
 * faltando.
 *
 * ── ESGOTADO CONTINUA NO FEED ──
 *
 * Igual ao feed do Meta, e pelo mesmo motivo: `out_of_stock` para de anunciar e
 * volta sozinho quando reabastece. Sumir do feed faz o Google tratar como
 * produto morto e recomeçar do zero na volta.
 */

export const revalidate = 3600;

/** `&` vira `&amp;` etc. Um nome com "&" invalidaria o XML inteiro. */
function escapar(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** O Google exige moeda junto do número: "199.90 BRL". Ponto, não vírgula. */
function dinheiro(v: number): string {
  return `${(Number(v) || 0).toFixed(2)} BRL`;
}

/**
 * Categoria do Google (taxonomia oficial). Só os ramos que a loja usa — o resto
 * cai em "Vestuário e acessórios", que é verdade pra 100% do catálogo e melhor
 * que mandar categoria errada.
 */
const CATEGORIA_GOOGLE: Record<string, string> = {
  vestidos: 'Vestuário e acessórios > Roupas > Vestidos',
  blusas: 'Vestuário e acessórios > Roupas > Blusas e camisetas',
  calcas: 'Vestuário e acessórios > Roupas > Calças',
  saias: 'Vestuário e acessórios > Roupas > Saias',
  shorts: 'Vestuário e acessórios > Roupas > Shorts',
  macacoes: 'Vestuário e acessórios > Roupas > Macacões e jardineiras',
  conjuntos: 'Vestuário e acessórios > Roupas > Conjuntos',
  jaquetas: 'Vestuário e acessórios > Roupas > Casacos e jaquetas',
  'moda-praia': 'Vestuário e acessórios > Roupas > Roupas de banho',
  lingerie: 'Vestuário e acessórios > Roupas > Roupas íntimas',
  'linha-conforto': 'Vestuário e acessórios > Roupas > Roupas de dormir e loungewear',
  // Faltava, e o efeito era silencioso: as t-shirts caíam no galho genérico
  // (13/09). Mesmo ramo das blusas na taxonomia do Google.
  't-shirts-premium': 'Vestuário e acessórios > Roupas > Blusas e camisetas',
};




/**
 * O ENDEREÇO ESTÁVEL DA PEÇA — o que o feed manda (13/09/2026).
 *
 * O `slug` embute o NOME e a COR PRINCIPAL
 * (`blusa-feminina-manga-curta-plus-size-207372-marrie-207372`). Renomear a
 * peça — ou a cor principal rodar quando a anterior cai abaixo do piso de
 * estoque, o mesmo mecanismo do `common/atributos-do-feed.ts` — muda o slug e
 * MATA o endereço que o Merchant guardou na busca das 00:00.
 *
 * A rede de recuperação existe (`slugAtualDoLegado`), mas só pega slug que
 * contenha o padrão `ref-`, e por um bom motivo: casar por dado, nunca por
 * heurística em cima do texto. Medido em produção no dia:
 *   · `/produto/nome-velho-ref-900834-cor-que-saiu` → 308, volta
 *   · `/produto/nome-velho-900834-cor-que-saiu`     → 404, morre
 * E é exatamente o segundo formato que várias peças têm hoje.
 *
 * O preço disso apareceu no diagnóstico da campanha em 12/09: **"Página do
 * produto indisponível: 3"**, com 128 impressões e R$ 2,59 gastos mandando
 * cliente pra erro.
 *
 * `/produto/ref-<REF>` responde **200 direto** (não é redirect), não depende
 * do nome nem da cor, e a página serve o `canonical` apontando pro slug — que
 * segue sendo o do sitemap e o do SEO. Conferido item a item antes de trocar:
 * as **968 URLs do feed respondem 200** nesta forma.
 */
function enderecoDaPeca(p: PecaFeed): string {
  const chave = String(p.ref ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Peça sem REF utilizável volta pro slug: endereço velho que às vezes quebra
  // ainda é melhor que `/produto/ref-`, que quebra sempre.
  return chave ? `${SITE.url}/produto/ref-${chave}` : `${SITE.url}/produto/${p.slug}`;
}

function item(p: PecaFeed, v: Variante): string {
  // `?cor=` só na peça de várias cores, como sempre foi: a de cor única não
  // tem o que escolher, e a query a mais seria um segundo endereço à toa.
  const base = enderecoDaPeca(p);
  const link = v.grupo ? `${base}?cor=${encodeURIComponent(v.cor)}` : base;
  const [capa, ...resto] = v.fotos;

  const campos: string[] = [
    `<g:id>${escapar(v.id)}</g:id>`,
    ...(v.grupo ? [`<g:item_group_id>${escapar(v.grupo)}</g:item_group_id>`] : []),
    // Tipo da peça + plus size + cor + Ref + marca. Ver `tituloShopping`: o
    // nome sozinho deixava 561 dos 977 itens chamados só de "Blusa Manga
    // Curta", disputando a busca errada. A cor entra sempre que existe — sem
    // ela a peça de 8 cores vira 8 anúncios idênticos.
    `<g:title>${escapar(tituloShopping(p, v))}</g:title>`,
    // Descrição vazia reprova o item. O nome é um fallback honesto: descreve a
    // peça, mesmo que sem charme.
    `<g:description>${escapar(p.descricao || p.nome)}</g:description>`,
    `<g:link>${escapar(link)}</g:link>`,
    `<g:condition>new</g:condition>`,
    `<g:availability>${p.disponivel ? 'in_stock' : 'out_of_stock'}</g:availability>`,
    `<g:price>${dinheiro(p.preco)}</g:price>`,
    // Sem GTIN nem MPN no catálogo — declarar isso é o que evita a reprovação.
    `<g:identifier_exists>no</g:identifier_exists>`,
    `<g:age_group>adult</g:age_group>`,
    `<g:gender>female</g:gender>`,
  ];

  if (capa) campos.push(`<g:image_link>${escapar(capa)}</g:image_link>`);
  // O Google aceita até 10 fotos extras por item.
  for (const extra of resto.slice(0, 10)) {
    campos.push(`<g:additional_image_link>${escapar(extra)}</g:additional_image_link>`);
  }
  // `sale_price` só quando há promoção de verdade — é o que desenha o "de/por".
  if (p.precoPromocional && p.precoPromocional < p.preco) {
    campos.push(`<g:sale_price>${dinheiro(p.precoPromocional)}</g:sale_price>`);
  }
  /**
   * MARCA SEMPRE SAI — mesma regra do feed da Meta (`meta.xml`).
   *
   * 49 das 722 peças não têm marca no cadastro e saíam SEM a tag: o Google
   * pede `brand` em vestuário e, sem ela, o item entra limitado. Quando não
   * há fabricante conhecido, o próprio Google manda usar o nome de quem
   * vende — e quem vende é a loja.
   *
   * ⚠️ O buraco é DE FEED, não de cadastro: não preencher `marca` no banco.
   * Lá ela é o discriminador que separa produto diferente na mesma REF
   * (`bucketKey` = `${ref}|${marca}` na Consulta). Carimbar "Lurd's" em
   * todas jogaria peças distintas no mesmo balde — o bug da REF reciclada.
   */
  campos.push(`<g:brand>${escapar(p.marca || "Lurd's Plus Size")}</g:brand>`);
  if (v.cor) campos.push(`<g:color>${escapar(v.cor)}</g:color>`);

  const categoria = CATEGORIA_GOOGLE[String(p.categoria || '').trim()];
  campos.push(
    `<g:google_product_category>${escapar(categoria || 'Vestuário e acessórios')}</g:google_product_category>`,
  );
  // `product_type` é a NOSSA taxonomia (a do menu), e é por ela que dá pra
  // montar campanha por categoria no Ads sem depender da taxonomia do Google.
  if (p.categoria) {
    const proprio = p.subcategoria ? `${p.categoria} > ${p.subcategoria}` : p.categoria;
    campos.push(`<g:product_type>${escapar(proprio)}</g:product_type>`);
  }

  /**
   * OS RÓTULOS QUE DEIXAM A CAMPANHA SEPARAR GANHADORA DE PERDEDORA (13/09).
   *
   * O feed do Meta carimba cinco `custom_label` desde agosto; o do Google não
   * mandava NENHUM — e sem eles o grupo de listagem do Shopping/PMax só sabe
   * dividir por categoria do Google, que é grossa demais pra decidir verba.
   * Foi medido no dia: 57% do gasto em campanhas com ROAS abaixo de 1,2 e sem
   * como isolar dentro delas o que vende do que não vende.
   *
   * Os DOIS que saem daqui são os que vêm prontos no payload — mesma chave e
   * mesmo vocabulário do Meta, de propósito: campanha que fala idiomas
   * diferentes nos dois canais não dá pra comparar.
   *   · 0 = slug da subcategoria (`blusas-confort`)
   *   · 1 = curadoria da tela: `top-semana` (fixa) ou `colecao-<slug>` (pontual)
   *
   * Os slots 2, 3 e 4 do Meta (novidades e as duas vitrines de estoque) ficam
   * de fora por enquanto: eles são CALCULADOS sobre o catálogo inteiro dentro
   * da rota do Meta, e copiar a conta pra cá criaria a segunda cópia que o
   * `variantes.ts` existe pra evitar. Quando fizerem falta, o caminho é
   * extrair a conta pra `lib/feed/` e os dois lerem dela.
   */
  if (p.subcategoria) campos.push(`<g:custom_label_0>${escapar(p.subcategoria)}</g:custom_label_0>`);
  // Um valor só por peça: a coleção fixa vence quando a REF está nas duas.
  if (p.topSemana) campos.push(`<g:custom_label_1>top-semana</g:custom_label_1>`);
  else if (p.colecaoSlug) campos.push(`<g:custom_label_1>colecao-${escapar(p.colecaoSlug)}</g:custom_label_1>`);

  /**
   * OS DOIS RÓTULOS QUE A CAMPANHA DE LOJA FILTRA (dono, 14/09):
   * *"quero sempre mostrar as novidades que chegam na loja e a linha CONFORTO"*.
   *
   * 🚨 ISTO CONSERTA UMA FALHA SILENCIOSA QUE JÁ ESTAVA NO AR. Os filtros de
   * listagem das 14 PMax apontam para `product_type = novidades` — valor que
   * o feed do WordPress velho tinha e este NÃO tem (os tipos reais são
   * `blusas > manga-curta`, `vestidos > vestido-manga-curta`, `calcas`…).
   * Resultado medido em 14/09: as campanhas cuja árvore de filtro dependia
   * desse valor serviram **ZERO produto em 30 dias** — Campinas, Santos,
   * Sorocaba, Anália Franco, Limeira, Moema, Vinhedo. As três que serviam
   * (Jundiaí 954 impressões, Itanhaém 1.170, Indaiatuba 878) só escapavam por
   * terem um "inclui tudo" sobrando na árvore.
   *
   * Nada dava erro em lugar nenhum: o produto simplesmente não aparecia.
   *
   * Os dois são MUTUAMENTE EXCLUSIVOS por construção (o backend tira o
   * conforto da contagem de novidades) — e isso é requisito, não estética: no
   * filtro de listagem da PMax uma peça só pode pertencer a um grupo de
   * recursos por campanha, e sobreposição faz o Google recusar a configuração.
   */
  if (p.novidade) campos.push(`<g:custom_label_2>novidades</g:custom_label_2>`);
  if (p.linhaConforto) campos.push(`<g:custom_label_3>conforto</g:custom_label_3>`);
  /**
   * A grade num campo só: o Google usa `size` pra filtrar, e mandar a lista é
   * melhor que omitir — quem procura 54 precisa saber que existe 54.
   *
   * O que entra são os tamanhos COMPRÁVEIS; quando a peça inteira zera, entra
   * a grade toda, porque quem diz "agora não" é o `availability` e item sem
   * atributo volta da reposição incompleto. A régua (com o incidente de
   * 13/09) é `common/atributos-do-feed.ts`, no backend, e vale pros dois
   * feeds — aqui só se escreve o XML.
   */
  if (v.tamanhos.length) campos.push(`<g:size>${escapar(v.tamanhos.join(", "))}</g:size>`);

  return `<item>${campos.join('')}</item>`;
}

export async function GET() {
  let pecas: PecaFeed[] = [];
  try {
    pecas = (await api<PecaFeed[]>('/public/loja/feed?rev=1', {
      revalidate,
      tags: ['catalogo'],
      timeoutMs: 25000,
    })) ?? [];
  } catch {
    /* Catálogo fora do ar: feed VAZIO e válido, nunca erro. Resposta com erro
       o Google trata como falha de importação e pode desagendar a busca; feed
       vazio ele registra e tenta de novo amanhã. */
  }

  const validas = pecas.filter((p) => p.ref && p.slug && p.preco > 0);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>` +
    `<title>${escapar(SITE.name)}</title>` +
    `<link>${escapar(SITE.url)}</link>` +
    `<description>${escapar(SITE.description)}</description>` +
    validas.flatMap((p) => variantes(p).map((v) => item(p, v))).join("") +
    `</channel></rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
