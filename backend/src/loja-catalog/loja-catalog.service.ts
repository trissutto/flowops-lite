import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { refBaseOf } from '../common/ref-base';
import { avisarVitrine } from '../common/avisar-vitrine';
import { limparNomeVitrine, nomeDaDescricaoErp } from './nome-vitrine';
import { classificarPorNome } from './classificacao-por-nome';

/**
 * CATÁLOGO DO E-COMMERCE (sprint 008) — ERP é a fonte da verdade.
 *
 * Uma "peça" do site = uma REF. As variações (cor × tamanho) são as linhas
 * do ERP com aquela REF. Nada é duplicado:
 *
 *   preço, grade, cor, EAN, NCM, marca  → wincred_produtos  (espelho do ERP)
 *   estoque por loja                    → wincred_estoque   (espelho, hora em hora)
 *   nome, descrição, SEO, coleção       → site_produto      (CADASTRO do Flow)
 *   fotos                               → product_photos    (R2 da Lurd's) e,
 *                                         enquanto a migração de imagem não
 *                                         roda, o que veio do WC no import
 *   modelagem, elastano, caimento       → fit_product       (camada Lurd's)
 *
 * O site NUNCA consulta WooCommerce nem Giga ao vivo: tudo sai do Postgres
 * local, então a página aguenta ISR/prefetch sem risco pra operação.
 *
 * CURADORIA: só sai no site REF com linha em `site_produto` e `publicado`.
 * Sem isso o site listaria o catálogo inteiro do ERP (milhares de itens de
 * loja física que nunca foram pensados pra venda online).
 */

export interface ListarParams {
  page?: number;
  perPage?: number;
  busca?: string;
  categoria?: string;
  /** Segundo nível da árvore do site: 'manga-curta' dentro de 'blusas'. */
  subcategoria?: string;
  marca?: string;
  cor?: string;
  tamanho?: string;
  precoMin?: number;
  precoMax?: number;
  modelagem?: string;
  /** Atributos da ficha do CRM — os eixos do menu (item 44). */
  tecido?: string;
  ocasiao?: string;
  colecao?: string;
  soPromocao?: boolean;
  soNovidade?: boolean;
  /**
   * `true` esconde o esgotado. Vazio/`false` MOSTRA (item 37): a cliente vê
   * que a peça existe e acabou, em vez de achar que o site quebrou.
   */
  soDisponivel?: boolean;
  ordenar?: 'relevancia' | 'novidades' | 'preco-asc' | 'preco-desc' | 'nome';
}

type LinhaErp = {
  ref: string;
  codigo: string;
  cor: string | null;
  tamanho: string | null;
  marca: string | null;
  categoria: string | null;
  descricao: string | null;
  preco: number;
  custo: number | null;
  ean: string | null;
  ncm: string | null;
  cst: string | null;
  estoque: number;
  dataAlt: Date | null;
};

@Injectable()
export class LojaCatalogService {
  private readonly logger = new Logger(LojaCatalogService.name);

  /**
   * PISO DE ESTOQUE POR COR (regra do dono, 13/08): variação com menos que
   * isto no total sai do site sozinha — e volta sozinha quando repõe. `1`
   * desliga a regra (só cor zerada some). Env pra ajustar sem deploy.
   */
  private static readonly ESTOQUE_MINIMO_COR = Math.max(
    1,
    Number(process.env.ESTOQUE_MINIMO_COR ?? 10) || 10,
  );

  /** Facetas custam um scan do catálogo — 10 min de cache resolve. */
  private cacheFiltros: { at: number; data: any } | null = null;
  private readonly TTL_FILTROS = 10 * 60_000;

  /**
   * Catálogo montado (todas as peças publicadas). Ver `catalogoPublicado` —
   * o TTL acompanha o `revalidate: 60` da borda do site.
   */
  private cacheCatalogo: { at: number; pecas: any[] } | null = null;
  private catalogoEmVoo: Promise<any[]> | null = null;
  private readonly TTL_CATALOGO = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  private normRef(v?: string | null) {
    return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  /**
   * Zera os caches de leitura. Quem MUDA o catálogo (edição da retaguarda,
   * classificação em lote, sync) chama isto — senão a vitrine continua
   * servindo a versão anterior por até um minuto e quem cadastrou acha que a
   * ferramenta não salvou.
   */
  invalidarCache() {
    this.cacheCatalogo = null;
    this.cacheFiltros = null;
    this.cacheTaxonomia = null;
  }

  /** Slug de categoria/subcategoria normalizado — a comparação é sempre por aqui. */
  private slugTaxonomia(v?: string | null) {
    return String(v || '').trim().toLowerCase();
  }

  /**
   * A ORDEM DA VITRINE, em um lugar só. `listar` e o feed da PDP
   * (`descobrir`) precisam ordenar igual: duas cópias divergiriam no primeiro
   * ajuste de relevância. Ordena in-place (o array já é cópia de quem chama).
   */
  private ordenarPecas(pecas: any[], ordenar?: ListarParams['ordenar']) {
    const ord = ordenar || 'relevancia';
    pecas.sort((a, b) => {
      switch (ord) {
        case 'preco-asc': return a.preco - b.preco;
        case 'preco-desc': return b.preco - a.preco;
        case 'nome': return a.nome.localeCompare(b.nome, 'pt-BR');
        case 'novidades': {
          /**
           * "Novidade" é quando a peça ENTROU NO AR (`publicadoEm`), não
           * quando o ERP mexeu nela (13/08) — o critério antigo (`dataAlt`)
           * subia peça velha pro topo a cada acerto de estoque. Empate ou
           * peça sem carimbo cai pro `atualizadoEm`, só pra ordem ser
           * estável.
           */
          const pubB = new Date(b.publicadoEm ?? 0).getTime();
          const pubA = new Date(a.publicadoEm ?? 0).getTime();
          if (pubB !== pubA) return pubB - pubA;
          return new Date(b.atualizadoEm ?? 0).getTime() - new Date(a.atualizadoEm ?? 0).getTime();
        }
        default:
          // Relevância: destaque > lançamento > estoque saudável
          if (a.destaque !== b.destaque) return a.destaque ? -1 : 1;
          if (a.lancamento !== b.lancamento) return a.lancamento ? -1 : 1;
          return b.estoqueTotal - a.estoqueTotal;
      }
    });

    // Esgotado aparece (item 37), mas por último — em QUALQUER ordenação.
    // Sem isto, "menor preço" encheria a primeira tela de peça que não vende.
    pecas.sort((a, b) => Number(b.disponivel) - Number(a.disponivel));
    return pecas;
  }

  /**
   * NOME DE COR AMIGÁVEL (item 46) — o ERP guarda cor de etiqueta.
   *
   * "VD MUSGO ESC" é o que a vendedora bipa; "Verde Musgo Escuro" é o que a
   * cliente lê. A tradução é conservadora de propósito: expande só as
   * abreviações que a casa usa de fato e ajeita a caixa. Palavra desconhecida
   * passa intacta — inventar nome de cor é pior que mostrar a técnica, porque
   * a cliente compara com a foto e perde a confiança na peça.
   *
   * Quando a ficha tiver `tituloComercial` naquela cor, ELE ganha: é escolha
   * humana, e escolha humana sempre vence heurística.
   */
  private static readonly ABREV_COR: Record<string, string> = {
    VD: 'Verde', VM: 'Vermelho', AZ: 'Azul', AM: 'Amarelo', BR: 'Branco',
    PR: 'Preto', RS: 'Rosa', RX: 'Roxo', LR: 'Laranja', MR: 'Marrom',
    CZ: 'Cinza', BG: 'Bege', ESC: 'Escuro', CL: 'Claro', MED: 'Médio',
    ESTP: 'Estampado', EST: 'Estampado', FLR: 'Floral', MESC: 'Mescla',
  };

  /**
   * A GRADE DA CASA — 46 ao 60, de dois em dois (decisão do dono, 06/08).
   *
   * O ERP carrega décadas de rótulo herdado: "42", "44", "G", "GG", "M", "P",
   * "01", "24-29", "G7". Nenhum deles é numeração que a Lurd's vende hoje, e
   * cada um vira uma pílula a mais na barra lateral — filtro que a cliente
   * clica pra achar duas peças de acervo.
   *
   * Numeração DUPLA existe e é legítima ("46/48", "50/52"), mas chega escrita
   * de três jeitos: com barra, com hífen e com espaço. Aqui viram um só.
   */
  // 44 entrou por decisão do dono (07/08): "deixar no filtro 44 46 ... 60".
  private static readonly GRADE_DA_CASA = [44, 46, 48, 50, 52, 54, 56, 58, 60];

  /**
   * OS NÚMEROS QUE UM RÓTULO COBRE, dentro da grade da casa. Fora dela, vazio.
   *
   *   "48"      → [48]
   *   "46/48"   → [46, 48]   (e "46 48", "46-48" — o mesmo escrito de 3 jeitos)
   *   "38", "G" → []          (rótulo herdado, não é o que a loja vende)
   *
   * ⚠️ É a MESMA função pro filtro e pra comparação, de propósito. Se a barra
   * lateral for montada por um critério e o clique casado por outro, o filtro
   * que a cliente acabou de clicar devolve zero peça.
   *
   * O filtro mostra só número SOLTO (decisão do dono, 06/08) — mas a peça
   * marcada "46/48" continua aparecendo tanto no 46 quanto no 48, porque ela
   * veste os dois. Tirar a dupla da lista sem isso faria 38 peças pararem de
   * ser encontradas por tamanho nenhum.
   */
  private numerosDaGrade(bruto?: string | null): number[] {
    const txt = String(bruto || '').trim().toUpperCase();
    if (!txt) return [];
    // Sobrou letra depois de tirar dígito e separador? É "G7", "46A", "GG".
    // A vírgula entra na lista de separadores pra aceitar MULTISSELEÇÃO do
    // filtro ("46,50,58" — cliente marcou três pílulas) sem tratar como texto
    // inválido (bug real, 07/08: filtro de tamanho só aplicava o 1º marcado).
    if (txt.replace(/[\d\s/\-,]/g, '')) return [];
    const numeros = (txt.match(/\d+/g) ?? []).map(Number);
    if (!numeros.length) return [];
    if (!numeros.every((n) => LojaCatalogService.GRADE_DA_CASA.includes(n))) return [];
    return numeros;
  }

  /**
   * O que a vitrine NÃO repete em toda peça (decisão do dono, 06/08).
   *
   * A loja inteira é feminina e plus size: dizer isso em cada título gasta a
   * linha inteira do card com o que não diferencia nada, e empurra pra fora o
   * que a cliente usa pra pedir a peça no WhatsApp — a referência.
   */
  // A limpeza de nome (cor/REF/tamanho/caixa alta) e a classificação pelo
  // nome moram em módulos próprios — ./nome-vitrine.ts e
  // ./classificacao-por-nome.ts — porque o publicar() também usa e porque
  // regra de string sem teste é regressão esperando deploy.

  private corAmigavel(cor: string): string {
    const bruto = String(cor || '').trim();
    if (!bruto) return '';
    return bruto
      .split(/\s+/)
      .map((p) => {
        const chave = p.toUpperCase().replace(/[^A-Z]/g, '');
        const expandida = LojaCatalogService.ABREV_COR[chave];
        if (expandida) return expandida;
        // Título simples: "MARINHO" → "Marinho". Números e códigos passam.
        return /^[A-Za-zÀ-ÿ]+$/.test(p)
          ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
          : p;
      })
      .join(' ');
  }

  /**
   * SQL base das variações publicadas. Junta ERP + estoque somado + curadoria.
   * Estoque: SOMA de todas as lojas (o site vende do consolidado; a reserva
   * por loja entra na fase 2 junto com retirada em loja).
   *
   * 🔴 SÓ FEMININO/PLUS SIZE (corrigido 07/08). O espelho `wincred_produtos`
   * cobre o CATÁLOGO INTEIRO desde que o filtro PLUS_SIZE foi tirado da
   * sincronização (02/07) — inclusive linha masculina e infantil que a rede
   * vende na loja física. Achado do dono: "CALÇA MASCULINA CARGO" apareceu na
   * vitrine do site.
   *
   * Esta é a ÚNICA função que monta variação pro site (`listar`, `filtros`,
   * `porSlug`, `relacionados` — todas passam por aqui), então o filtro entra
   * uma vez só, na fonte, em vez de em cada tela que lê catálogo.
   *
   * A mesma regra de palavra-chave (MASCULIN/INFANTIL na descrição) já existe
   * em três lugares — `product-native.service.ts`, `live-pdv.service.ts`,
   * `product-registration.service.ts` — e nunca tinha chegado aqui, porque
   * o site novo lê o espelho cru direto, não a tabela nativa curada.
   */
  /**
   * FAMÍLIA de uma descrição: a primeira palavra "de produto" que aparece.
   * "CALCA CIGARRETE FEMININA PLUS SIZE 9099 MANIF" → "calca".
   * Mesma heurística do ProductSearchService.familiaOf — se mudar lá, muda aqui.
   */
  private static readonly FAMILIA_IGNORAR = new Set([
    'feminina', 'feminino', 'plus', 'size', 'plussize', 'moda', 'plus-size',
  ]);

  private familiaDe(desc?: string | null): string {
    const palavras = String(desc || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/\s+/)
      .filter(Boolean);
    return (
      palavras.find(
        (w) => w.length >= 4 && !/\d/.test(w) && !LojaCatalogService.FAMILIA_IGNORAR.has(w),
      ) || '_outros'
    );
  }

  /* ── TIPO DE PEÇA: o que a cliente vê no cabide ──────────────────────────
   *
   * 🔴 O ERRO QUE ISTO CONSERTA (Limeira, 13/08/2026): a página "Regata
   * Estampa Mostarda" (REF 132908) tinha DUAS bolinhas — a regata estampada e
   * uma CAMISA LISTRADA AZUL, com outra grade (54, 56, 58, 46/48, 50/52).
   * Dois produtos diferentes vendidos como duas cores da mesma peça. A cliente
   * escolhia a "cor" e recebia outra roupa.
   *
   * A defesa contra REF reciclada existia e não pegou: ela separava pela
   * PRIMEIRA PALAVRA da descrição, e no ERP as duas estão cadastradas como
   * "BLUSA ..." — regata é blusa, camisa é blusa. Primeira palavra igual,
   * produtos diferentes, e a REF reciclada passou direto pela porta.
   *
   * Aqui o que separa é o TIPO: regata ≠ camisa ≠ vestido ≠ calça. Sinônimos
   * caem no mesmo balde de propósito (t-shirt/camiseta/cropped são "blusa"),
   * senão o cadastro irregular racharia peça boa — que é o erro oposto e
   * também custa venda ([[marca-vazia-funde-produtos]]).
   *
   * `familiaDe` fica como estava: é a heurística que o `ProductSearchService`
   * também usa, e divergir ali quebraria o bipe da live. O tipo entra como
   * discriminador ADICIONAL, só do catálogo.
   */
  private static readonly TIPO_POR_PALAVRA: Record<string, string> = {
    regata: 'regata',
    camisa: 'camisa', camisao: 'camisa', chemise: 'camisa',
    vestido: 'vestido', vestidos: 'vestido',
    macacao: 'macacao', macaquinho: 'macacao', jardineira: 'macacao',
    conjunto: 'conjunto',
    saia: 'saia',
    calca: 'calca', calcas: 'calca', pantalona: 'calca', legging: 'calca', leggin: 'calca',
    short: 'short', shorts: 'short', bermuda: 'short',
    jaqueta: 'casaco', casaco: 'casaco', blazer: 'casaco', cardigan: 'casaco',
    colete: 'casaco', kimono: 'casaco', sobretudo: 'casaco',
    body: 'body',
    pijama: 'pijama', robe: 'pijama', camisola: 'pijama',
    blusa: 'blusa', camiseta: 'blusa', tshirt: 'blusa', cropped: 'blusa', bata: 'blusa',
  };

  /**
   * Do mais específico pro mais genérico: "BLUSA REGATA" é REGATA, e "BLUSA
   * MANGA CURTA" é blusa. Sem a ordem, quem chegasse primeiro na frase venceria
   * — e "blusa" chega primeiro justamente nos casos que precisam ser separados.
   */
  private static readonly PRIORIDADE_TIPO = [
    'regata', 'camisa', 'vestido', 'macacao', 'conjunto', 'saia', 'calca',
    'short', 'casaco', 'body', 'pijama', 'blusa',
  ];

  private tipoDePeca(desc?: string | null): string {
    const palavras = new Set(
      String(desc || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        // Hífen e ponto CAEM DENTRO da palavra, não a partem: quebrando em
        // "t" + "shirt", a T-shirt não casava com nada e caía no fallback —
        // o que separava a VOGUE das próprias irmãs.
        .replace(/[^a-z0-9\s]+/g, '')
        .split(/\s+/)
        .filter(Boolean),
    );
    const achados = new Set<string>();
    for (const p of palavras) {
      const t = LojaCatalogService.TIPO_POR_PALAVRA[p];
      if (t) achados.add(t);
    }
    return LojaCatalogService.PRIORIDADE_TIPO.find((t) => achados.has(t)) || '';
  }

  /**
   * A chave que diz "isto é o mesmo produto". Tipo quando dá pra reconhecer;
   * senão a família de sempre, pra descrição fora do vocabulário não virar um
   * balde só ('' agruparia peças que não têm nada a ver).
   */
  private chaveDeProduto(desc?: string | null): string {
    return this.tipoDePeca(desc) || this.familiaDe(desc);
  }

  /**
   * Das linhas de uma REF, devolve SÓ as do produto que a retaguarda publicou.
   * REF com um produto só (o caso normal) passa direto, sem custo.
   */
  private familiaPublicada(ref: string, linhas: LinhaErp[], site: any): LinhaErp[] {
    if (linhas.length < 2) return linhas;

    const porFamilia = new Map<string, LinhaErp[]>();
    for (const l of linhas) {
      const f = this.chaveDeProduto(l.descricao);
      if (!porFamilia.has(f)) porFamilia.set(f, []);
      porFamilia.get(f)!.push(l);
    }
    if (porFamilia.size < 2) return linhas;

    /* 1) O TIPO DO NOME PUBLICADO manda — é a peça que a loja escolheu pôr no
     *    site, e o nome dela veio de quem cadastrou, não do ERP.
     *
     *    Casar por TIPO (e não pela primeira palavra) também conserta um
     *    silêncio antigo: o nome do site é "Regata Estampa Mostarda" e a
     *    descrição do ERP é "BLUSA REGATA FEMININA PLUS SIZE" — primeira
     *    palavra "regata" contra "blusa", nunca casava, e a escolha caía no
     *    desempate por estoque. Ou seja: a peça que ia pro ar era a que tinha
     *    mais peça na arara, não a que a loja publicou.
     */
    const tipoDoSite = this.chaveDeProduto(site?.nome);
    let escolhida = tipoDoSite !== '_outros' ? porFamilia.get(tipoDoSite) : undefined;
    let criterio = 'nome publicado';

    // 2) Sem casar pelo nome: a que tem mais PEÇA EM ESTOQUE — é a que a
    //    cliente realmente consegue comprar. Desempate por nº de variações.
    if (!escolhida) {
      criterio = 'maior estoque';
      let melhorEstoque = -1;
      let melhorLinhas = -1;
      for (const [, ls] of porFamilia) {
        const est = ls.reduce((s, l) => s + (l.estoque || 0), 0);
        if (est > melhorEstoque || (est === melhorEstoque && ls.length > melhorLinhas)) {
          melhorEstoque = est;
          melhorLinhas = ls.length;
          escolhida = ls;
        }
      }
    }

    const descartadas = linhas.length - (escolhida?.length ?? 0);
    this.logger.warn(
      `[catalogo] REF ${ref} tem ${porFamilia.size} PRODUTOS diferentes no ERP ` +
        `(${Array.from(porFamilia.keys()).join(', ')}) — REF reciclada. ` +
        `Fiquei com "${criterio}" e ignorei ${descartadas} variação(ões). ` +
        `Cadastro precisa separar essas REFs.`,
    );
    return escolhida ?? linhas;
  }

  /**
   * A REF-BASE em SQL — a MESMA regra de `common/ref-base.ts`, no banco.
   *
   * `refBaseOf` corta tudo depois do último dígito e devolve a REF inteira
   * quando não sobra nada ("GRAVATA"). O `NULLIF/COALESCE` é justamente esse
   * "senão a própria REF": sem ele, toda REF sem dígito viraria string vazia e
   * cairia no mesmo balde.
   *
   * Existe pra buscar a FAMÍLIA numa consulta só. Se a regra do TypeScript
   * mudar, esta muda junto — duas versões da mesma regra é o erro que criou
   * este arquivo.
   */
  private static readonly SQL_REF_BASE = `COALESCE(NULLIF(regexp_replace(UPPER(TRIM(p.ref)), '[^0-9]+$', ''), ''), UPPER(TRIM(p.ref)))`;

  private readonly SQL_VARIACOES = `
    SELECT
      UPPER(TRIM(p.ref))                          AS ref,
      p.codigo                                    AS codigo,
      NULLIF(TRIM(p.cor), '')                     AS cor,
      NULLIF(TRIM(p.tamanho), '')                 AS tamanho,
      NULLIF(TRIM(p.marca), '')                     AS marca,
      NULLIF(TRIM(p."nomeGrupo"), '')              AS categoria,
      NULLIF(TRIM(p."descricaoCompleta"), '')      AS descricao,
      COALESCE(p."vendaUn", 0)::float8             AS preco,
      p.custo::float8                             AS custo,
      NULLIF(TRIM(p.ean), '')                     AS ean,
      NULLIF(TRIM(p.ncm), '')                     AS ncm,
      NULLIF(TRIM(p.cst), '')                     AS cst,
      COALESCE(e.total, 0)::int                   AS estoque,
      p."dataAlt"                                 AS "dataAlt"
    FROM wincred_produtos p
    LEFT JOIN (
      SELECT codigo, SUM(COALESCE(estoque, 0)) AS total
        FROM wincred_estoque GROUP BY codigo
    ) e ON e.codigo = p.codigo
    WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> ''
      AND UPPER(COALESCE(p."descricaoCompleta", '')) NOT LIKE '%MASCULIN%'
      AND UPPER(COALESCE(p."descricaoCompleta", '')) NOT LIKE '%INFANTIL%'
      AND UPPER(COALESCE(p."nomeGrupo", '')) NOT LIKE '%MASCULIN%'
      AND UPPER(COALESCE(p."nomeGrupo", '')) NOT LIKE '%INFANTIL%'
  `;

  /**
   * Peça montada a partir das variações de uma REF.
   *
   * A PÁGINA DO SITE É UMA SÓ POR REF (decisão do dono, 03/08): a cliente
   * escolhe a COR numa bolinha e só depois o tamanho. Por isso `cores` não é
   * mais uma lista de nomes — cada cor carrega o que muda ao ser escolhida:
   * fotos, grade de tamanhos com estoque, preço e a bolinha.
   */
  private montarPeca(
    ref: string, linhas: LinhaErp[], site: any, fit: any, fotos: any[] = [], ficha?: any,
    /** Peças da família já vendidas (loja + site + histórico do ERP antigo). */
    vendas = 0,
    /**
     * TODAS as fichas da família — não só a escolhida. O "não publicar" de uma
     * cor pode ter sido gravado na ficha da REF irmã (é lá que a cor mora), e
     * olhar só a ficha escolhida faria a decisão da retaguarda não valer nada.
     */
    fichasTodas: any[] = [],
  ) {
    /* ── ⚠️ UMA REF PODE SER TRÊS PRODUTOS (bug de preço, 07/08) ───────────
     *
     * O Giga RECICLA referência. A REF 9099, por exemplo, é ao mesmo tempo:
     *   BOLERO MANGA LONGA (tam 10–16, R$ 59,90)
     *   CALCA CIGARRETE PLUS SIZE (tam 46–60, R$ 339,90)
     *   VESTIDO MANGA CURTA (tam 46–56, R$ 129,90)
     *
     * Juntando tudo numa peça só, o site anunciou a CALÇA DE R$ 339,90 POR
     * R$ 59,90 — o `Math.min` dos preços pegou o do bolero — com grade "do 14
     * ao 60". Preço errado no ar é prejuízo em cada venda, não estética.
     *
     * Aqui a REF é separada por FAMÍLIA (a primeira palavra significativa da
     * descrição — a mesma regra que a live usa pra não bipar peça errada) e a
     * peça é montada com UMA família só. Qual: a que casa com o nome que a
     * retaguarda publicou; sem casar, a que tem mais peça em estoque.
     */
    linhas = this.familiaPublicada(ref, linhas, site);

    /* ── DEDUPE: a mesma cor+tamanho não pode aparecer duas vezes ──────────
     * O catálogo tem REF cadastrada mais de uma vez (códigos diferentes pra
     * MESMO cor+tamanho). Sem tratar, a cliente via "44 46 46 48 48 50 50".
     *
     * Regra do dono (03/08): NUNCA duplicar; entre os cadastros duplicados
     * fica o de MAIOR QUANTIDADE — e a duplicidade é REPORTADA. Somar os dois
     * seria pior: inflaria o estoque de um erro de cadastro e o site venderia
     * peça que não existe.
     */
    const chaveVar = (l: LinhaErp) =>
      `${(l.cor || '').trim().toUpperCase()}|${(l.tamanho || '').trim().toUpperCase()}`;

    const melhorPorVariacao = new Map<string, LinhaErp>();
    const duplicadas: Array<{ cor: string | null; tamanho: string | null; codigos: string[] }> = [];
    for (const l of linhas) {
      const k = chaveVar(l);
      const atual = melhorPorVariacao.get(k);
      if (!atual) {
        melhorPorVariacao.set(k, l);
        continue;
      }
      // Empate de estoque: fica o de código menor, só pra ser determinístico
      // (duas respostas diferentes pra mesma peça confundem mais que o erro).
      const vence =
        (l.estoque || 0) > (atual.estoque || 0) ||
        ((l.estoque || 0) === (atual.estoque || 0) && String(l.codigo) < String(atual.codigo));
      if (vence) melhorPorVariacao.set(k, l);

      const registro = duplicadas.find(
        (d) => (d.cor || '') === (l.cor || '') && (d.tamanho || '') === (l.tamanho || ''),
      );
      if (registro) {
        if (!registro.codigos.includes(l.codigo)) registro.codigos.push(l.codigo);
      } else {
        duplicadas.push({ cor: l.cor, tamanho: l.tamanho, codigos: [atual.codigo, l.codigo] });
      }
    }
    if (duplicadas.length) {
      this.logger.warn(
        `[catalogo] REF ${ref} tem ${duplicadas.length} variação(ões) duplicada(s) — ` +
          `vale a de maior estoque: ${duplicadas
            .map((d) => `${d.cor ?? '?'}/${d.tamanho ?? '?'} [${d.codigos.join(', ')}]`)
            .join(' · ')}`,
      );
    }
    let unicas = Array.from(melhorPorVariacao.values());

    /**
     * O SITE VENDE 44 AO 60 (dono 07/08). Tamanho fora da grade da casa é
     * acervo de loja física ("38", "G", "01", "24-29") e não pode aparecer na
     * vitrine — nem na grade, nem puxando o preço "a partir de" pra baixo.
     *
     * Guarda: se a peça INTEIRA estiver fora da grade (peça de letra, por
     * exemplo), mantém como está. Melhor uma grade herdada visível do que uma
     * peça publicada sem tamanho nenhum pra escolher.
     */
    const daGrade = unicas.filter((l) => this.numerosDaGrade(l.tamanho).length > 0);
    if (daGrade.length) unicas = daGrade;

    /**
     * O 44 CUSTA O MESMO QUE O 46 (dono 07/08).
     *
     * Em várias peças o fornecedor cobra menos pelo 44, e esse preço menor
     * virava o "a partir de" do card — a cliente de 52 via um valor que não
     * existe pra ela e descobria a diferença só no carrinho. Na Lurd's o 44 é
     * vendido pelo preço do 46.
     */
    const precoDo46 = unicas.find((l) => this.numerosDaGrade(l.tamanho).includes(46) && l.preco > 0)?.preco;
    if (precoDo46) {
      unicas = unicas.map((l) =>
        this.numerosDaGrade(l.tamanho).includes(44) && l.preco !== precoDo46
          ? { ...l, preco: precoDo46 }
          : l,
      );
    }

    /* ── COR SEM FOTO NÃO EXISTE PRO SITE — E NEM SEU ESTOQUE ──────────────
     *
     * Regra do dono, reafirmada em 13/08: **não libere cor sem foto**. Por 6
     * horas o site mostrou cor sem foto usando a foto das irmãs; a medição
     * mostrou o tamanho disso — 320 cores, 8.925 peças — e uma bolinha
     * mostrando a peça errada custa mais que a venda que ela traria.
     *
     * O QUE MUDA DE VERDADE AQUI: o corte passou pra ANTES da conta.
     *
     * Antes, a cor sumia da bolinha mas o estoque dela CONTINUAVA somando no
     * total e na grade da peça. Deu no que deu na REF VOGUE: o site anunciava
     * 570 peças e "91 no 46", e só tinha bolinha pra 178 — 392 peças
     * anunciadas que a cliente não tinha como comprar. Prometer o que não se
     * vende é pior que a cor a menos.
     *
     * Agora a peça inteira (preço, faixas, grade, estoque total e bolinhas)
     * nasce das MESMAS linhas: as das cores que têm foto. O que não aparece
     * não conta.
     *
     * Cor sem foto continua invisível mesmo com peça na arara — a saída é
     * subir a foto na tela master, e aí ela volta sozinha.
     */
    const fotosPorCor = new Map<string, any[]>();
    for (const f of fotos) {
      const k = String(f.cor || '').toUpperCase();
      if (!fotosPorCor.has(k)) fotosPorCor.set(k, []);
      fotosPorCor.get(k)!.push(f);
    }
    /**
     * Duas guardas, e as duas já salvaram tela:
     *
     * - `fotos.length === 0`: peça sem foto NENHUMA (acervo antigo, sem cor
     *   associada) mostra todas as cores, como sempre mostrou.
     * - linha SEM cor entra sempre: peça de cor única não tem o que casar, e
     *   filtrar por cor a apagaria inteira.
     */
    const semFotoNaPeca = fotos.length === 0;
    const visivel = (l: LinhaErp) =>
      !l.cor || semFotoNaPeca || fotosPorCor.has(String(l.cor).trim().toUpperCase());
    const comFoto = unicas.filter(visivel);
    /**
     * Se NENHUMA linha sobrou, as fotos existem mas nenhuma está associada a
     * cor (import antigo). Rachar a peça aqui a deixaria sem preço, sem grade
     * e sem estoque — pior que a bolinha errada. Fica como estava.
     */
    if (comFoto.length) unicas = comFoto;

    // Preço e estoque saem das ÚNICAS: somar cadastro duplicado inflaria o
    // estoque do site e faria vender peça que não existe na arara.
    const precos = unicas.map((l) => l.preco).filter((p) => p > 0);
    const preco = precos.length ? Math.min(...precos) : 0;
    const estoqueTotal = unicas.reduce((s, l) => s + (l.estoque || 0), 0);

    /**
     * QUEBRA DE PREÇO POR FAIXA (dono 07/08): "do 44 ao 54 mesmo preço, às
     * vezes do 56 ao 60 muda — precisamos mostrar os 2 preços".
     *
     * Mostrar só o menor faz a cliente do 58 descobrir o preço real no
     * carrinho, que é onde ela desiste. Aqui sai a lista de faixas contíguas
     * de tamanho por preço; o site mostra "R$ 199,90 (44–54) · R$ 219,90
     * (56–60)" quando há mais de uma.
     */
    const faixasPreco = (() => {
      const porNumero = new Map<number, number>();
      for (const l of unicas) {
        if (!(l.preco > 0)) continue;
        for (const n of this.numerosDaGrade(l.tamanho)) {
          // Mesma numeração em preços diferentes (cor cara e cor barata): o
          // menor manda, senão a faixa promete o que a cliente não acha.
          const atual = porNumero.get(n);
          if (atual == null || l.preco < atual) porNumero.set(n, l.preco);
        }
      }
      const numeros = Array.from(porNumero.keys()).sort((a, b) => a - b);
      const faixas: Array<{ de: number; ate: number; preco: number }> = [];
      for (const n of numeros) {
        const p = porNumero.get(n)!;
        const ultima = faixas[faixas.length - 1];
        if (ultima && ultima.preco === p) ultima.ate = n;
        else faixas.push({ de: n, ate: n, preco: p });
      }
      // Uma faixa só = preço único: o card já mostra isso, não precisa repetir.
      return faixas.length > 1 ? faixas : [];
    })();

    // Grade: tamanho na ordem da numeração plus, com estoque somado por tamanho
    const porTamanho = new Map<string, number>();
    const cores = new Map<string, { nome: string; estoque: number }>();
    for (const l of unicas) {
      if (l.tamanho) porTamanho.set(l.tamanho, (porTamanho.get(l.tamanho) || 0) + (l.estoque || 0));
      if (l.cor) {
        const c = cores.get(l.cor) || { nome: l.cor, estoque: 0 };
        c.estoque += l.estoque || 0;
        cores.set(l.cor, c);
      }
    }
    const ordemTam = (t: string) => {
      const n = parseInt(String(t).replace(/\D/g, ''), 10);
      return Number.isFinite(n) ? n : 999;
    };
    const tamanhos = Array.from(porTamanho.entries())
      .sort((a, b) => ordemTam(a[0]) - ordemTam(b[0]))
      .map(([label, est]) => ({ label, estoque: est, disponivel: est > 0 }));

    /* ── CORES como VARIAÇÃO ESCOLHÍVEL ─────────────────────────────────
     * Cada cor devolve tudo que muda quando a cliente clica na bolinha:
     * suas fotos, sua grade (só os tamanhos daquela cor) e seu preço.
     *
     * Três coisas decidem se a cor aparece, e as três são independentes:
     * FOTO (aplicada lá em cima, nas linhas), ESTOQUE (no filtro adiante) e o
     * "não publicar" da ficha. A foto voltou a ser critério em 13/08, algumas
     * horas depois de ter sido solta — ver o bloco "COR SEM FOTO NÃO EXISTE
     * PRO SITE". A ficha (`produto_ficha_cor`) traz a bolinha — hex do
     * conta-gotas ou recorte da foto pra estampa.
     */
    // A ficha ESCOLHIDA entra primeiro e ganha no empate; as das irmãs
    // completam as cores que só existem nelas.
    const fichaPorCor = new Map<string, any>();
    for (const fx of [ficha, ...fichasTodas]) {
      for (const c of ((fx?.cores ?? []) as any[])) {
        const k = String(c.cor || '').toUpperCase();
        if (!fichaPorCor.has(k)) fichaPorCor.set(k, c);
      }
    }
    // `fotosPorCor` já foi montado LÁ EM CIMA, antes das contas — é ele que
    // decide quais linhas entram na peça (ver "COR SEM FOTO NÃO EXISTE PRO
    // SITE"). Montar de novo aqui não quebraria nada, mas esconderia que o
    // corte acontece antes do preço e da grade, que é o ponto todo.

    const coresDetalhadas = Array.from(cores.keys())
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map((nomeCor) => {
        const chave = nomeCor.toUpperCase();
        const daCor = unicas.filter((l) => (l.cor || '').toUpperCase() === chave);
        const suasFotos = fotosPorCor.get(chave) ?? [];
        const f = fichaPorCor.get(chave);
        const precosCor = daCor.map((l) => l.preco).filter((p) => p > 0);
        const capa = suasFotos[0]?.url ?? null;

        return {
          nome: nomeCor,
          /** REF e marca DONAS da cor (numa família pode ser a irmã) — é onde
           *  a tela de cores grava o "não publicar" da ficha. */
          refDona: (daCor[0] as any)?.ref || ref,
          marcaDona: (daCor[0] as any)?.marca ?? null,
          /** O que a cliente lê. Título da ficha ganha da tradução automática. */
          nomeAmigavel: String(f?.tituloComercial || '').trim() || this.corAmigavel(nomeCor),
          estoque: daCor.reduce((s, l) => s + (l.estoque || 0), 0),
          preco: precosCor.length ? Math.min(...precosCor) : 0,
          // Bolinha: 'cor' = hex tirado da foto; 'foto' = recorte da estampa,
          // enquadrado pelo ponto que a retaguarda clicou.
          swatch: {
            tipo: f?.swatchTipo === 'foto' ? 'foto' : 'cor',
            hex: f?.corHex ?? null,
            focoX: f?.swatchFocoX ?? null,
            focoY: f?.swatchFocoY ?? null,
            imagem: capa,
          },
          fotos: suasFotos.map((x: any) => ({
            src: x.url,
            alt: `${site?.nome || ref} ${nomeCor}`,
          })),
          titulo: f?.tituloComercial ?? null,
          youtubeUrl: f?.youtubeUrl ?? null,
          tamanhos: daCor
            .filter((l) => l.tamanho)
            .sort((a, b) => ordemTam(a.tamanho!) - ordemTam(b.tamanho!))
            .map((l) => ({
              label: l.tamanho!,
              sku: l.codigo,
              ean: l.ean,
              preco: l.preco,
              estoque: l.estoque || 0,
              disponivel: (l.estoque || 0) > 0,
            })),
        };
      })
      /* ── QUEM VIRA BOLINHA: TEM FOTO **E** TEM PEÇA ────────────────────
       *
       * As duas condições vieram de decisões do dono no mesmo dia (13/08), e
       * cada uma conserta um erro oposto que convivia na MESMA peça:
       *
       *   FOTO  — "não libere cor sem foto". Sem ela, 320 cores da rede
       *           entravam mostrando a foto de uma cor irmã. Bolinha que
       *           mostra a peça errada custa mais que a venda que traz.
       *   PEÇA  — "quando zerar, tirar do site — caso da VINHO". Ela estava
       *           zerada nos 8 tamanhos e seguia na tela por ter foto bonita:
       *           bolinha que só leva a "esgotado" gasta o clique da cliente.
       *
       * O filtro de FOTO já foi aplicado lá em cima, nas linhas — de propósito.
       * Cortar só aqui deixava o estoque da cor invisível somando no total e na
       * grade da peça, e foi assim que a VOGUE anunciou 570 peças tendo bolinha
       * pra 178. Aqui sobra a condição de ESTOQUE, que não distorce conta
       * nenhuma: cor zerada soma zero.
       *
       * Peça inteira zerada = nenhuma cor, e aí a PDP cai no caminho de
       * esgotado que já existe ("pode ter na loja, chame uma consultora").
       */
      .filter((c) => c.estoque > 0);

    /**
     * DOIS FILTROS por cor, além do estoque zero acima:
     *
     * 1. "NÃO PUBLICAR" da ficha (13/08): o botão MANUAL da tela
     *    /retaguarda/cores-sem-foto — a retaguarda marcava e a vitrine
     *    ignorava.
     * 2. ESTOQUE MÍNIMO POR COR (regra do dono, 13/08 à tarde): "toda
     *    variação (cor) com menos de 10 unidades no total desativa — e fica
     *    como regra". Cor de grade rala vende número quebrado e vira troca;
     *    ela SOME sozinha e VOLTA sozinha quando a reposição passar do piso.
     *    Medição na hora da regra: 210 das 554 cores no ar (38%), 1.078
     *    peças físicas, e 127 peças ficariam sem nenhuma cor (caem no
     *    caminho de esgotado que já existe). `ESTOQUE_MINIMO_COR` ajusta o
     *    piso sem deploy; `1` desliga (só a zerada some, como antes).
     *
     * As descartadas seguem no payload (`coresOcultas`, com motivo) pra
     * tela de cores listar — esgotamento não pode ser mistério.
     */
    const coresOcultas: Array<{
      nome: string; estoque: number; refDona: string; marcaDona: string | null; motivo: string;
    }> = [];
    const coresVisiveis = coresDetalhadas.filter((c) => {
      if (fichaPorCor.get(c.nome.toUpperCase())?.statusPublicacao === 'nao_publicar') {
        coresOcultas.push({
          nome: c.nome, estoque: c.estoque, refDona: c.refDona, marcaDona: c.marcaDona,
          motivo: 'nao_publicar',
        });
        return false;
      }
      if (c.estoque < LojaCatalogService.ESTOQUE_MINIMO_COR) {
        coresOcultas.push({
          nome: c.nome, estoque: c.estoque, refDona: c.refDona, marcaDona: c.marcaDona,
          motivo: 'estoque_baixo',
        });
        return false;
      }
      return true;
    });

    /**
     * Com cor escondida, TOTAL e GRADE exibidos têm que ser o que dá pra
     * COMPRAR — "91 no 46" contando cor invisível é a mentira da VOGUE ao
     * contrário. Peça SEM cor cadastrada (linhas do ERP sem cor) não tem
     * bolinha pra filtrar: mantém os números crus.
     */
    const temCores = coresDetalhadas.length > 0;
    const estoqueExibido = temCores
      ? coresVisiveis.reduce((s, c) => s + (c.estoque || 0), 0)
      : estoqueTotal;
    const porTamanhoVisivel = new Map<string, number>();
    for (const c of coresVisiveis) {
      for (const t of c.tamanhos) {
        porTamanhoVisivel.set(t.label, (porTamanhoVisivel.get(t.label) || 0) + (t.estoque || 0));
      }
    }
    const tamanhosExibidos = temCores
      ? Array.from(porTamanhoVisivel.entries())
          .sort((a, b) => ordemTam(a[0]) - ordemTam(b[0]))
          .map(([label, est]) => ({ label, estoque: est, disponivel: est > 0 }))
      : tamanhos;

    // Comparador numérico de propósito: `.sort()` sem ele ordena Date como
    // STRING ("Mon Jul..." antes de "Thu Aug...") e o "mais recente" da peça
    // — que é o que ordena a página de Novidades — sai sorteado.
    const dataAlt = linhas
      .map((l) => l.dataAlt)
      .filter(Boolean)
      .sort((a, b) => new Date(a as any).getTime() - new Date(b as any).getTime())
      .slice(-1)[0] as Date | undefined;

    /**
     * CONTEÚDO DE VENDA vem da FICHA primeiro (itens 33 e 34).
     *
     * Ordem: ficha do CRM → cadastro do site (import do WooCommerce) → a
     * descrição CRUA do ERP. A crua é o último recurso de propósito: é texto
     * de etiqueta ("BLUSA FEM MC VISCOSE"), não título de vitrine — mas é
     * melhor que a peça aparecer sem nome nenhum.
     */
    const nomeDaFicha = String(ficha?.nomeCurto || '').trim();
    const descricaoDaFicha = String(ficha?.descricao || '').trim();

    /** JSON `[{id,nome}]` do cadastro → lista de nomes pro filtro e pra tela. */
    const nomesDe = (raw: any): string[] => {
      if (!raw) return [];
      try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(arr)) return [];
        return arr.map((x: any) => String(x?.nome || x || '').trim()).filter(Boolean);
      } catch {
        return [];
      }
    };

    /**
     * Ordem do NOME: ficha → cadastro do site → descrição do ERP LIMPA → a
     * REF. A crua nunca entra inteira: ela carrega a cor de UMA variação, e
     * isso gruda "Preto" no nome de uma peça vinho.
     */
    const nomeVitrine =
      limparNomeVitrine(
        nomeDaFicha ||
          site?.nome ||
          nomeDaDescricaoErp(
            linhas[0]?.descricao,
            ref,
            Array.from(cores.keys()),
            linhas.find((l) => l.marca)?.marca,
          ) ||
          ref,
        ref,
        Array.from(cores.keys()),
        linhas.find((l) => l.marca)?.marca,
      ) || ref;

    /**
     * CLASSIFICAÇÃO DERIVADA PELO NOME (caso 407012, 13/08): a primeira peça
     * nascida no sistema chegou publicada com categoria NULA — visível na PDP
     * e invisível em TODO menu do site. O fallback aplica em LEITURA as
     * mesmas regras do lote de 10/08 (classificar-em-massa). Escolha humana
     * vence: só preenche o que o cadastro deixou vazio, e a subcategoria
     * derivada só vale dentro da MESMA categoria (nome que diz "blusa" não
     * pendura manga em cima de um cadastro que diz "vestidos").
     */
    const derivada = classificarPorNome(nomeVitrine);
    const categoria = site?.categoria ?? derivada?.categoria ?? null;
    const subcategoria =
      site?.subcategoria ??
      (derivada && derivada.categoria === categoria ? derivada.subcategoria : null);

    return {
      ref,
      slug: site?.slug || `ref-${ref.toLowerCase()}`,
      nome: nomeVitrine,
      /**
       * RESUMO DA FICHA na frente do `descricaoCurta` (12/08): a curta veio do
       * WooCommerce e costuma ser a primeira frase da descrição gigante; o
       * resumo é o texto destilado (2-3 frases) que a IA extraiu do que já
       * existia. Quando não há resumo, nada muda.
       */
      descricaoCurta: String(ficha?.resumo || '').trim() || site?.descricaoCurta || null,
      descricaoCompleta: descricaoDaFicha || site?.descricaoCompleta || null,
      /**
       * FICHA TÉCNICA — `[{rotulo,valor}]`: forro, transparência, decote,
       * manga, comprimento. É o que a cliente plus size pergunta e o parágrafo
       * de venda escondia.
       */
      fichaTecnica: this.lerLista(ficha?.fichaTecnica)
        .filter((i: any) => i?.rotulo && i?.valor)
        .map((i: any) => ({ rotulo: String(i.rotulo), valor: String(i.valor) })),
      /**
       * PROVA SOCIAL REAL: peças desta família já vendidas, somando loja
       * física, site e o histórico importado do ERP antigo. Número cru — quem
       * decide o piso de exibição é a vitrine, num lugar só.
       */
      vendas,
      marca: linhas.find((l) => l.marca)?.marca ?? null,
      // Categoria COMERCIAL: cadastro do site primeiro; sem ele, a derivada
      // pelo nome (ver bloco acima). O grupo do Giga vai separado: é
      // classificação fiscal, não serve pro menu da loja.
      categoria,
      /**
       * Segundo nível da árvore do site ("Blusas" → "Manga curta"). Sai aqui
       * porque a PDP começa o feed de descoberta pela subcategoria da peça que
       * a cliente está vendo — sem este campo ela não saberia onde está.
       */
      subcategoria,
      grupoErp: linhas.find((l) => l.categoria)?.categoria ?? null,

      preco,
      /** Vazio = preço único. Com 2+, o site mostra os dois: "44–54" e "56–60". */
      faixasPreco,
      // Pix e parcelamento são convenção da marca (5% / 12x), não dado do ERP.
      precoPix: preco > 0 ? Number((preco * 0.95).toFixed(2)) : null,
      parcelamento: preco > 0 ? { vezes: 12, valor: Number((preco / 12).toFixed(2)) } : null,

      cores: coresVisiveis,
      /** Cores escondidas (ficha ou estoque mínimo) — a tela de cores lista. */
      coresOcultas,
      tamanhos: tamanhosExibidos,
      estoqueTotal: estoqueExibido,
      disponivel: estoqueExibido > 0,

      // FOTO PRÓPRIA VENCE (decisão 30/07): o R2 é da Lurd's; o que veio do
      // WC é só o resto do acervo até a migração de imagem terminar.
      imagens: fotos.length
        ? fotos.map((f) => ({ src: f.url, alt: `${site?.nome || ref}${f.cor ? ` ${f.cor}` : ''}`, tipo: 'imagem', cor: f.cor ?? null, origem: 'flow' }))
        : ((site?.imagens as any[]) ?? []).map((i) => ({ ...i, origem: 'wc' })),
      seo: site?.seo ?? null,

      // Ficha de caimento (Lurd's Fit AI) — alimenta filtro e recomendação
      modelagem: nomesDe(ficha?.modelagens)[0] ?? fit?.modelagem ?? null,
      elastano: fit?.elastano ?? null,
      caimento: fit?.caimento ?? null,
      composicao: fit?.composicao ?? null,
      medidas: fit?.medidas ?? null,

      /**
       * ATRIBUTOS DA FICHA — o que os 7 eixos do menu filtram (item 44).
       * Vinham só do `fit_product` (a camada antiga de IA); a ficha do CRM é
       * quem tem o dado digitado por gente.
       */
      tecido: ficha?.tecidoNome ?? null,
      colecao: ficha?.colecaoNome ?? null,
      ocasioes: nomesDe(ficha?.ocasioes),
      modelagens: nomesDe(ficha?.modelagens),
      /** 'nao' | 'pouco' | 'muito' — a pergunta que a cliente plus size mais faz. */
      elasticidade: ficha?.elasticidade ?? null,

      /**
       * TABELA DE MEDIDAS (itens 42 e 49) — grade do cadastro, com o ajuste
       * daquela peça por cima. O ajuste sobrescreve LINHA A LINHA: a grade é
       * template da modelagem, e a peça específica sempre foge em algum ponto.
       */
      gradeMedidas: this.montarGrade(ficha),

      destaque: !!site?.destaque,
      /**
       * NOVIDADE É IDADE, NÃO ETIQUETA (dono, 13/08). O critério antigo era a
       * tag "Novidade" herdada do WooCommerce — editorial do site velho que
       * nunca expirava: regata de meses atrás ficava em "Novidades" pra
       * sempre, e peça recém-publicada sem a tag nunca entrava. Agora:
       * publicou há até 30 dias = novidade; envelheceu = sai sozinha.
       */
      lancamento: !!(
        site?.publicadoEm &&
        Date.now() - new Date(site.publicadoEm).getTime() <= 30 * 24 * 60 * 60 * 1000
      ),
      promocao: !!site?.promocao,
      atualizadoEm: dataAlt ?? null,
      /** Quando a peça entrou no ar — o eixo da ordenação "novidades". */
      publicadoEm: site?.publicadoEm ?? null,

      // Fiscal (pro checkout futuro) — do ERP, nunca digitado
      fiscal: { ncm: linhas.find((l) => l.ncm)?.ncm ?? null, cst: linhas.find((l) => l.cst)?.cst ?? null },

      // Cadastro duplicado (mesma cor+tamanho em códigos diferentes). Vai no
      // payload pra retaguarda REPORTAR — o site ignora, mas alguém tem que
      // limpar o cadastro: código duplicado é etiqueta ambígua no bipe.
      duplicidades: duplicadas,

      // Só as variações que sobreviveram ao dedupe — é o que o carrinho e a
      // separação enxergam.
      variacoes: unicas.map((l) => ({
        sku: l.codigo,
        cor: l.cor,
        tamanho: l.tamanho,
        ean: l.ean,
        preco: l.preco,
        estoque: l.estoque,
        disponivel: (l.estoque || 0) > 0,
      })),
    };
  }

  /**
   * Grade de medidas da peça: template da modelagem + ajuste próprio.
   *
   * O ajuste sobrescreve por TAMANHO, não o objeto inteiro — a grade é o
   * template (ex.: "Reta P/M/G"), e a peça foge dele em um ou dois pontos.
   * Trocar tudo obrigaria a redigitar a grade toda pra mudar um busto.
   */
  private montarGrade(ficha: any): Array<Record<string, any>> | null {
    const ler = (raw: any): any[] => {
      if (!raw) return [];
      try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };

    const base = ler(ficha?.gradeMedidas?.linhas);
    const ajuste = ler(ficha?.medidasAjuste);
    if (!base.length && !ajuste.length) return null;

    const chave = (l: any) => String(l?.tamanho ?? l?.label ?? '').trim().toUpperCase();
    const porTamanho = new Map<string, any>();
    for (const l of base) porTamanho.set(chave(l), { ...l });
    for (const l of ajuste) {
      const k = chave(l);
      porTamanho.set(k, { ...(porTamanho.get(k) ?? {}), ...l });
    }
    const linhas = Array.from(porTamanho.values());
    return linhas.length ? linhas : null;
  }

  /**
   * As tabelas de medida ativas, prontas pro guia de tamanhos do site.
   *
   * Devolve só grade com LINHA — grade cadastrada e vazia vira tabela em
   * branco na tela, que é pior que não ter a seção: a cliente conclui que a
   * loja não sabe as próprias medidas.
   */
  async gradesMedidas() {
    const grades: any[] = await (this.prisma as any).gradeMedidas
      .findMany({ where: { ativo: true }, orderBy: { nome: 'asc' } })
      .catch(() => []);

    const itens = grades
      .map((g) => {
        let linhas: any[] = [];
        try {
          const v = JSON.parse(String(g.linhas || '[]'));
          if (Array.isArray(v)) linhas = v;
        } catch {
          /* grade com JSON torto não derruba o guia inteiro */
        }
        return { nome: g.nome, observacao: g.observacao ?? null, linhas };
      })
      .filter((g) => g.linhas.length > 0);

    return { itens };
  }

  /**
   * JSON de texto do banco → lista. Devolve vazio em qualquer defeito: campo
   * torto de uma peça não pode derrubar a montagem do catálogo inteiro.
   */
  private lerLista(raw: any): any[] {
    if (!raw) return [];
    try {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  /** Carrega curadoria + ficha de caimento de um conjunto de REFs. */
  private async complementos(refs: string[]) {
    const [sites, fits, fotos, fichas] = await Promise.all([
      (this.prisma as any).siteProduto.findMany({ where: { ref: { in: refs } } }),
      (this.prisma as any).fitProduct.findMany({ where: { ref: { in: refs } } }),
      // Fotos próprias (R2) — o mesmo acervo que a Live já usa.
      // `ordem` primeiro: é ela que define a capa da cor (a galeria da tela
      // master é ordenável). `createdAt` só desempata.
      (this.prisma as any).productPhoto.findMany({
        where: { ref: { in: refs } },
        orderBy: [{ cor: 'asc' }, { ordem: 'asc' }, { createdAt: 'asc' }],
      }),
      // Ficha do CRM: é de lá que vem a bolinha de cada cor.
      (this.prisma as any).produtoFicha.findMany({
        where: { ref: { in: refs } },
        // `gradeMedidas` junto: é a tabela de medidas da PDP (itens 42 e 49).
        // Sem o include, a peça chegava ao site sem medida nenhuma.
        include: { cores: true, gradeMedidas: true },
      }),
    ]);
    const porRefFotos = new Map<string, any[]>();
    for (const f of fotos as any[]) {
      const k = String(f.ref || '').toUpperCase();
      if (!porRefFotos.has(k)) porRefFotos.set(k, []);
      porRefFotos.get(k)!.push(f);
    }
    const porRefFichas = new Map<string, any[]>();
    for (const f of fichas as any[]) {
      const k = String(f.ref || '').toUpperCase();
      if (!porRefFichas.has(k)) porRefFichas.set(k, []);
      porRefFichas.get(k)!.push(f);
    }
    return {
      site: new Map<string, any>((sites as any[]).map((s) => [s.ref, s])),
      fit: new Map<string, any>((fits as any[]).map((f) => [f.ref, f])),
      fotos: porRefFotos,
      fichas: porRefFichas,
    };
  }

  /**
   * Ficha da peça. A chave é REF + MARCA, nunca REF sozinha: REF numérica é
   * reciclada entre fornecedores e pegar a ficha errada colocaria a bolinha
   * (e a descrição) de outra peça na página. Ver [[giga-ref-reciclada]].
   *
   * ⚠️ 06/08 — a última linha era `fichas.length === 1 ? fichas[0] : undefined`:
   * REF com DUAS fichas e nenhuma casando com a marca da peça devolvia
   * `undefined`, ou seja, **peça sem bolinha, sem título e sem vídeo no site**,
   * em silêncio. Combinado com a marca não-determinística do lado de quem
   * GRAVA a bolinha (`marcaDaFamilia`), era o par que produzia "a varredura
   * pintou e o site não mostra".
   *
   * Agora: marca exata primeiro (segue sendo a resposta certa); se não houver,
   * vale a ficha mais PREENCHIDA — que é justamente aquela onde a varredura
   * gravou. Melhor uma ficha da família do que peça pelada; e o log diz quando
   * o desempate aconteceu, porque a correção de verdade é limpar o cadastro.
   */
  private escolherFicha(fichas: any[] | undefined, marca?: string | null) {
    if (!fichas?.length) return undefined;
    const m = String(marca || '').trim().toUpperCase();
    if (m) {
      const exata = fichas.find((f) => String(f.marca || '').toUpperCase() === m);
      if (exata) return exata;
    }
    if (fichas.length === 1) return fichas[0];

    const preenchimento = (f: any) =>
      ((f?.cores ?? []) as any[]).filter((c) => c?.corHex || c?.tituloComercial).length;
    const melhor = [...fichas].sort(
      (a, b) =>
        preenchimento(b) - preenchimento(a) ||
        String(a.marca || '').localeCompare(String(b.marca || '')),
    )[0];

    this.logger.warn(
      `[catalogo] REF ${fichas[0]?.ref} tem ${fichas.length} fichas e a marca da peça ` +
        `("${m || '—'}") não casou com nenhuma; usando a de marca "${melhor?.marca ?? '?'}" ` +
        `(a mais preenchida). Cadastro precisa de limpeza.`,
    );
    return melhor;
  }

  /**
   * TODAS AS PEÇAS PUBLICADAS, MONTADAS — com cache de 60s.
   *
   * Montar o catálogo custa uma query nas REFs publicadas, uma nas variações
   * do ERP e uma rodada de `montarPeca` por peça. Antes isso acontecia A CADA
   * requisição de listagem, com o recorte (categoria/subcategoria) aplicado no
   * `where` — barato pra UMA página de categoria, caro pro feed infinito da
   * PDP, que pede página atrás de página.
   *
   * O TTL é o MESMO da borda do site (`revalidate: 60` no BFF), então nada
   * fica mais velho do que já ficava: o que muda é quantas vezes o Postgres é
   * lido pra entregar a mesma resposta.
   *
   * `catalogoEmVoo` é o guarda contra estouro: N requisições chegando com o
   * cache frio esperam a MESMA montagem em vez de dispararem N montagens.
   */
  private async catalogoPublicado(): Promise<any[]> {
    if (this.cacheCatalogo && Date.now() - this.cacheCatalogo.at < this.TTL_CATALOGO) {
      return this.cacheCatalogo.pecas;
    }
    if (this.catalogoEmVoo) return this.catalogoEmVoo;

    this.catalogoEmVoo = this.carimbarPublicadoEm()
      .then(() => this.montarCatalogo())
      .then((pecas) => {
        this.cacheCatalogo = { at: Date.now(), pecas };
        return pecas;
      })
      .finally(() => {
        this.catalogoEmVoo = null;
      });
    return this.catalogoEmVoo;
  }

  /**
   * CARIMBO DE "QUANDO ENTROU NO AR" — idempotente, roda junto da remontagem
   * do catálogo (no máximo 1×/60s) e só toca quem está publicado SEM carimbo.
   *
   * É a fundação do "Novidades" automático (dono, 13/08): peça nova publicada
   * ganha `publicado_em` em até um minuto, sem caçar cada tela e sync que
   * escreve `publicado = true`. O backfill do acervo usa a PRIMEIRA foto R2
   * da REF (é quando a peça passou a existir pro site de verdade) e cai pro
   * `synced_at` quando não há foto — roda uma vez, vira data fixa, envelhece
   * e sai de Novidades sozinha.
   */
  private async carimbarPublicadoEm(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE site_produto sp
            SET publicado_em = COALESCE(
              (SELECT MIN(pp.created_at) FROM product_photos pp WHERE pp.ref = sp.ref),
              sp.synced_at,
              NOW()
            )
          WHERE sp.publicado = true AND sp.publicado_em IS NULL`,
      );
    } catch (err) {
      // Sem carimbo o catálogo continua de pé — só o "Novidades" fica manco.
      this.logger.warn(`carimbo de publicado_em falhou: ${String(err)}`);
    }
  }

  /**
   * QUANTAS PEÇAS DESTA FAMÍLIA JÁ SAÍRAM — loja física + site + live.
   *
   * É a prova social que a loja PODE mostrar: número verdadeiro, conferível no
   * próprio caixa. A alternativa que estava no ar até 06/08 era depoimento
   * inventado, com as mesmas quatro frases em toda peça — removido, e não
   * volta ([[prova-social-e-ficha-por-ia]]).
   *
   * TRÊS fontes, porque a rede vendeu em três sistemas ao longo do tempo:
   *
   * - `giga_caixa_mov` — o caixa do ERP antigo, IMPORTADO pro Postgres:
   *   02/01/2025 a 12/08/2026, 227 mil peças. É a maior parte do histórico e
   *   some se a conta olhar só pro Flow.
   * - `pdv_sale_items` — o PDV do Flow. Definição de venda válida IGUAL à do
   *   motor de comissão (finalizada, fora do treino, sem MARCADO — marcado é
   *   "provar em casa", não venda). Critério próprio faria este número não
   *   bater com o de nenhuma outra tela.
   * - `order_items` — pedido do site e da live; guarda SKU (código), não REF,
   *   então casa pelo espelho do catálogo.
   *
   * ⚠️ DUPLA CONTAGEM: enquanto o Giga esteve de pé, o PDV do Flow gravava a
   * venda NOS DOIS (o outbox replicava no caixa). Essas linhas carregam
   * `obs_pedido` começando em "flowops" — 18.421 delas, desde 07/05/2026, que
   * batem com as 18.530 peças do `pdv_sale_items`. Sem excluí-las, todo o
   * período de convivência contaria em dobro.
   *
   * Soma por REF-BASE: as cores da peça são REFs irmãs e a cliente lê "esta
   * peça", não "esta cor". Devolução entra com quantidade negativa e abate.
   *
   * Cache PRÓPRIO de 10 min: o histórico quase não muda de um minuto pro
   * outro, e são ~1,2s de agregação que não precisam entrar em toda remontagem
   * do catálogo.
   */
  private cacheVendas: { at: number; mapa: Map<string, number> } | null = null;
  private readonly TTL_VENDAS = 10 * 60_000;

  private async vendasPorFamilia(): Promise<Map<string, number>> {
    if (this.cacheVendas && Date.now() - this.cacheVendas.at < this.TTL_VENDAS) {
      return this.cacheVendas.mapa;
    }
    const total = new Map<string, number>();
    const somar = (linhas: Array<{ ref: string; unidades: number }>) => {
      for (const l of linhas) {
        const base = refBaseOf(l.ref);
        if (!base) continue;
        total.set(base, (total.get(base) ?? 0) + (Number(l.unidades) || 0));
      }
    };
    try {
      const [historico, pdv, site] = await Promise.all([
        this.prisma.$queryRawUnsafe<Array<{ ref: string; unidades: number }>>(
          `SELECT UPPER(TRIM(p.ref)) AS ref, COALESCE(SUM(m.quantidade), 0)::int AS unidades
             FROM giga_caixa_mov m
             JOIN wincred_produtos p ON p.codigo = TRIM(m.codigo)
            WHERE COALESCE(m.obs_pedido, '') NOT LIKE 'flowops%'
              AND (m.marcado IS NULL OR TRIM(m.marcado) = '')
            GROUP BY 1`,
        ),
        this.prisma.$queryRawUnsafe<Array<{ ref: string; unidades: number }>>(
          `SELECT UPPER(TRIM(i.ref)) AS ref, COALESCE(SUM(i.qty), 0)::int AS unidades
             FROM pdv_sale_items i
             JOIN pdv_sales s ON s.id = i.sale_id
            WHERE i.ref IS NOT NULL
              AND s.status = 'finalized'
              AND s.is_training = false
              AND (s.payment_method IS NULL OR s.payment_method <> 'MARCADO')
            GROUP BY 1`,
        ),
        this.prisma.$queryRawUnsafe<Array<{ ref: string; unidades: number }>>(
          `SELECT UPPER(TRIM(p.ref)) AS ref, COALESCE(SUM(i.quantity), 0)::int AS unidades
             FROM order_items i
             JOIN orders o ON o.id = i.order_id
             JOIN wincred_produtos p ON p.codigo = TRIM(i.sku)
            WHERE o.status <> 'cancelled'
            GROUP BY 1`,
        ),
      ]);
      somar(historico);
      somar(pdv);
      somar(site);
      this.cacheVendas = { at: Date.now(), mapa: total };
    } catch (e: any) {
      // Prova social é acréscimo: se a contagem falha, a vitrine continua de
      // pé sem o selo. Não cacheia o erro — a próxima montagem tenta de novo.
      this.logger.warn(`[catalogo] vendas por família indisponíveis: ${e?.message || e}`);
    }
    return total;
  }

  private async montarCatalogo(): Promise<any[]> {
    // 1) REFs publicadas (curadoria) — a lista de saída nunca é maior que isso
    const publicadas: any[] = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true }, select: { ref: true },
    });
    if (!publicadas.length) return [];
    const refsPub = publicadas.map((p) => p.ref);
    const publicada = new Set(refsPub.map((r) => String(r).trim().toUpperCase()));
    const basesPub = [...new Set(refsPub.map((r) => refBaseOf(r)))];

    /**
     * 2) Variações do ERP — DA FAMÍLIA, não só da REF publicada (12/08/2026).
     *
     * A cor virou REF nova no catálogo legado, e quase sempre só UMA delas foi
     * publicada. Medido na produção: 290 REFs irmãs existem no espelho sem
     * cadastro no site, segurando 297 cores — cores com FOTO no acervo e PEÇA
     * na arara, que simplesmente não existiam pro site.
     *
     * Aqui a consulta abre pra família inteira (mesma REF-BASE de alguma
     * publicada). Quem entra de fato é decidido embaixo: cor de irmã sem
     * cadastro só vale com foto e estoque — publicar por tabela encheria a
     * vitrine de peça morta.
     */
    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES}
         AND (UPPER(TRIM(p.ref)) = ANY($1) OR ${LojaCatalogService.SQL_REF_BASE} = ANY($2))`,
      refsPub, basesPub,
    );

    const porRef = new Map<string, LinhaErp[]>();
    for (const l of linhas) {
      if (!porRef.has(l.ref)) porRef.set(l.ref, []);
      porRef.get(l.ref)!.push(l);
    }
    /**
     * ⚠️ A FICHA ENTRA NA LISTAGEM (corrigido 06/08).
     *
     * `complementos` sempre carregou as fichas, mas aqui elas eram descartadas
     * — só a PDP (`porSlug`) passava a ficha pro `montarPeca`. Consequência na
     * vitrine: **card sem bolinha de cor, sem título comercial e sem os
     * atributos** (tecido, ocasião, modelagem) que os filtros do menu usam.
     * A ficha do CRM é a fonte do conteúdo desde 03/08; metade do site não
     * estava lendo.
     */
    /**
     * As REFs-BASE entram no carregamento MESMO SEM LINHA NO ERP: a foto é
     * gravada sempre na base (`ProductPhotosService.upload`), e a peça
     * publicada pode ser a irmã sufixada. Sem isto, 159 REFs publicadas ficam
     * "sem foto" com a galeria inteira guardada uma REF ao lado.
     */
    const refsComplementos = new Set<string>(refsPub.map((r) => String(r).toUpperCase()));
    for (const ref of porRef.keys()) {
      refsComplementos.add(ref);
      refsComplementos.add(refBaseOf(ref));
    }
    const [{ site, fit, fotos, fichas }, vendas] = await Promise.all([
      this.complementos([...refsComplementos]),
      this.vendasPorFamilia(),
    ]);

    /**
     * JUNTA AS REFs QUE SÃO A MESMA PEÇA (10/08/2026, refeito em 12/08).
     *
     * No catálogo legado a cor virava REF nova: `900887` era o macaquinho
     * preto e `900887B` o mesmo macaquinho bege. A vitrine mostrava os dois
     * lado a lado, e a cliente escolhia entre o que parece ser o mesmo produto
     * repetido.
     *
     * A chave da família é o `grupoRef` quando a retaguarda decidiu, e a
     * **REF-BASE** quando não — antes era a própria REF, e por isso a fusão
     * dependia do sync ter rodado e ter passado nas travas. Medido em 12/08:
     * das 122 famílias publicadas só 76 tinham `grupoRef`, e as outras 46
     * apareciam como 166 cards repetidos.
     *
     * `grupoRefManual` sem grupo é DESAGRUPAMENTO explícito: alguém olhou e
     * disse "esta peça é sozinha". A base não pode reagrupá-la.
     */
    const chaveDaFamilia = (ref: string): string => {
      const cadastro = site.get(ref) as any;
      if (cadastro?.grupoRefManual && !cadastro?.grupoRef) return ref;
      return this.normRef(cadastro?.grupoRef) || refBaseOf(ref);
    };

    const agrupadas = new Map<string, LinhaErp[]>();
    for (const [ref, ls] of porRef) {
      const chave = chaveDaFamilia(ref);
      if (!agrupadas.has(chave)) agrupadas.set(chave, []);
      agrupadas.get(chave)!.push(...ls);
    }

    const pecas: any[] = [];
    for (const [ref, todas] of agrupadas) {
      /**
       * A identidade (nome, slug, ficha) vem do cadastro da RAIZ quando ele
       * existe — é a peça "principal". Se a raiz não estiver publicada, usa o
       * cadastro da primeira irmã disponível: melhor a peça aparecer com o
       * nome da irmã do que não aparecer.
       */
      const refsDaFamilia = [...new Set([ref, ...todas.map((l) => l.ref)])];
      const dono =
        site.get(ref) !== undefined
          ? ref
          : (refsDaFamilia.find((r) => site.get(r) !== undefined) ?? ref);

      /**
       * A GALERIA É DA FAMÍLIA. O acervo está gravado na REF-BASE e as cores
       * moram nas irmãs: ler só as fotos do `dono` deixava 1.230 fotos (34% do
       * acervo) apontando pra uma cor que "não existe" na peça — e a bolinha
       * dessa cor sumia do site, porque cor sem foto não vai pra vitrine.
       *
       * As do dono vêm primeiro: `ordem` 0 dele é que tem de ser a capa.
       */
      const fotosDaFamilia = [
        ...(fotos.get(dono) ?? []),
        ...refsDaFamilia.filter((r) => r !== dono).flatMap((r) => fotos.get(r) ?? []),
      ];
      const coresComFoto = new Set(
        fotosDaFamilia.map((f) => String(f.cor || '').trim().toUpperCase()).filter(Boolean),
      );

      /**
       * A IRMÃ SEM CADASTRO ENTRA PELA COR, não pela REF (decisão do dono,
       * 12/08): a cor dela vira bolinha desta peça quando tem FOTO e ESTOQUE.
       * Sem as duas condições ela é acervo morto — cor que abre galeria vazia
       * ou que a cliente escolhe e descobre esgotada no carrinho.
       */
      const linhas = todas.filter(
        (l) =>
          publicada.has(l.ref) ||
          ((l.estoque || 0) > 0 &&
            coresComFoto.has(String(l.cor || '').trim().toUpperCase())),
      );
      if (!linhas.length) continue;

      // A ficha também é da família: a bolinha pode ter sido gravada sob a
      // base enquanto a peça publicada é a irmã (a varredura usa REF-BASE).
      const fichasDaFamilia = refsDaFamilia.flatMap((r) => fichas.get(r) ?? []);

      pecas.push(
        this.montarPeca(
          ref, linhas, site.get(dono), fit.get(dono), fotosDaFamilia,
          this.escolherFicha(fichasDaFamilia, linhas.find((l) => l.marca)?.marca),
          /**
           * A venda é da FAMÍLIA — a cliente lê "esta peça", não "esta cor".
           *
           * Soma sobre as BASES DISTINTAS: as irmãs compartilham a mesma
           * REF-BASE, e somar ref a ref multiplicaria o número pelo tamanho da
           * família (uma peça de 4 cores viraria 4× o que vendeu).
           */
          [...new Set(refsDaFamilia.map(refBaseOf))].reduce(
            (s, base) => s + (vendas.get(base) ?? 0), 0,
          ),
          fichasDaFamilia,
        ),
      );
    }

    /**
     * PEÇA SEM FOTO NUNCA CHEGA À VITRINE (item 39).
     *
     * Card sem imagem é buraco na grade e destrói a confiança na loja inteira.
     * Vale pra listagem; a PDP continua abrindo por link direto (é o que
     * permite conferir a peça antes de publicar).
     */
    const semFoto = pecas.filter((p) => !p.imagens.length);
    if (semFoto.length) {
      this.logger.warn(
        `[catalogo] ${semFoto.length} REF(s) publicada(s) sem foto — fora da vitrine: ` +
          semFoto.slice(0, 15).map((p) => p.ref).join(', '),
      );
    }
    return pecas.filter((p) => p.imagens.length > 0);
  }

  /** Listagem paginada — o que a página de categoria e a busca consomem. */
  async listar(params: ListarParams) {
    const page = Math.max(1, Number(params.page) || 1);
    const perPage = Math.min(60, Math.max(1, Number(params.perPage) || 24));

    // Cópia: o array do cache é compartilhado entre requisições, e a ordenação
    // abaixo é in-place — ordenar o cache embaralharia a lista de quem estiver
    // lendo ao mesmo tempo.
    let pecas = [...(await this.catalogoPublicado())];
    if (!pecas.length) {
      return { itens: [], total: 0, page, perPage, totalPages: 0, fonte: 'erp', aviso: 'nenhuma REF publicada — rode o sync de conteúdo' };
    }

    /**
     * Aceita UMA categoria ("blusas") ou uma LISTA ("blusas,vestidos").
     *
     * A lista nasceu com o filtro de categoria na barra lateral (10/08): fora
     * da página de categoria — em `/tamanhos/56`, `/novidades`, `/outlet` — a
     * cliente pode marcar mais de um tipo de peça. Sem isto, a tela deixaria
     * ela marcar duas e só a primeira valeria, em silêncio: exatamente o bug
     * do filtro de tamanho de 07/08 (dois botões acesos, um filtro aplicado).
     */
    if (params.categoria) {
      const cats = String(params.categoria)
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      if (cats.length) pecas = pecas.filter((p) => cats.includes(this.slugTaxonomia(p.categoria)));
    }
    /**
     * SUBCATEGORIA — o segundo nível da árvore do site ("Blusas" → "Manga
     * curta"). Filtra junto com a categoria, e é o que a página da categoria
     * oferece como recorte fino.
     */
    if (params.subcategoria) {
      const sub = this.slugTaxonomia(params.subcategoria);
      pecas = pecas.filter((p) => this.slugTaxonomia(p.subcategoria) === sub);
    }
    if (params.soPromocao) pecas = pecas.filter((p) => p.promocao);
    if (params.soNovidade) pecas = pecas.filter((p) => p.lancamento);

    // 3) Filtros (em memória: o universo é o publicado, não o catálogo todo)
    const norm = (v: any) => String(v ?? '').trim().toUpperCase();
    if (params.busca) {
      const termos = norm(params.busca).split(/\s+/).filter(Boolean);
      pecas = pecas.filter((p) => {
        const alvo = norm(`${p.nome} ${p.marca} ${p.categoria} ${p.ref} ${p.descricaoCurta ?? ''}`);
        return termos.every((t) => alvo.includes(t));
      });
    }
    if (params.marca) pecas = pecas.filter((p) => norm(p.marca) === norm(params.marca));
    if (params.cor) pecas = pecas.filter((p) => p.cores.some((c) => norm(c.nome) === norm(params.cor)));
    if (params.tamanho) {
      /**
       * Casa por NÚMERO COBERTO (ver `numerosDaGrade`), não por texto.
       *
       * Quem clica em "46" quer o que veste 46 — inclusive a peça gravada como
       * "46/48", "46 48" ou "46-48". Comparar o rótulo cru deixaria essas 38
       * peças de fora de todo filtro de tamanho.
       */
      const numerosAlvo = this.numerosDaGrade(params.tamanho);
      if (numerosAlvo.length) {
        pecas = pecas.filter((p) =>
          p.tamanhos.some(
            (t) =>
              t.disponivel &&
              this.numerosDaGrade(t.label).some((n) => numerosAlvo.includes(n)),
          ),
        );
      } else {
        // Tamanho fora da grade (link antigo, busca colada): compara texto.
        pecas = pecas.filter((p) =>
          p.tamanhos.some((t) => norm(t.label) === norm(params.tamanho) && t.disponivel),
        );
      }
    }
    if (params.modelagem) pecas = pecas.filter((p) => norm(p.modelagem) === norm(params.modelagem));
    if (params.precoMin != null) pecas = pecas.filter((p) => p.preco >= Number(params.precoMin));
    if (params.precoMax != null) pecas = pecas.filter((p) => p.preco <= Number(params.precoMax));
    if (params.tecido) pecas = pecas.filter((p) => norm(p.tecido) === norm(params.tecido));
    if (params.ocasiao) pecas = pecas.filter((p) => p.ocasioes.some((o: string) => norm(o) === norm(params.ocasiao)));
    if (params.colecao) pecas = pecas.filter((p) => norm(p.colecao) === norm(params.colecao));

    /**
     * ESGOTADO NÃO SOME (item 37 — decisão do dono, 04/08).
     *
     * O filtro era `soDisponivel !== false`, ou seja, **esconder era o padrão**:
     * a peça esgotada sumia da vitrine sem explicação. A cliente que viu a peça
     * no Instagram voltava e achava que o site estava quebrado.
     *
     * Agora ela aparece, com `disponivel: false` pro card riscar e escrever
     * "esgotado" — a cliente vê que a peça EXISTE e que acabou, o que também
     * alimenta a lista de espera. Esconder só quando pedido explicitamente
     * (`soDisponivel: true`).
     *
     * A ordenação abaixo empurra o esgotado pro fim: aparecer não é o mesmo
     * que competir com quem tem estoque.
     */
    if (params.soDisponivel === true) pecas = pecas.filter((p) => p.disponivel);

    // 4) Ordenação (peça sem foto já ficou fora na montagem do catálogo)
    this.ordenarPecas(pecas, params.ordenar);

    const total = pecas.length;
    const inicio = (page - 1) * perPage;
    return {
      itens: pecas.slice(inicio, inicio + perPage),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      fonte: 'erp',
    };
  }

  /**
   * DE-PARA de categorias, pronto pra tela: o que o WooCommerce manda de um
   * lado, os destinos possíveis do outro.
   *
   * `destinos` sai das categorias que JÁ existem no site (peça publicada
   * nelas) somadas às que a retaguarda já escolheu. Não há lista fixa de
   * categorias válidas em lugar nenhum — categoria existe porque tem peça
   * dentro (mesma regra do `SiteCategoria`), então a lista se monta do que é
   * real.
   */
  async listarCategoriasMapa() {
    const [mapa, doCatalogo] = await Promise.all([
      (this.prisma as any).siteCategoriaMapa.findMany({
        orderBy: [{ destino: 'asc' }, { pecas: 'desc' }],
      }),
      (this.prisma as any).siteProduto.findMany({
        where: { categoria: { not: null }, publicado: true },
        select: { categoria: true },
        distinct: ['categoria'],
      }),
    ]);

    const destinos = new Set<string>(
      (doCatalogo as any[]).map((c) => String(c.categoria)).filter(Boolean),
    );
    for (const m of mapa as any[]) if (m.destino) destinos.add(String(m.destino));

    return {
      /** `destino: null` = esperando decisão. `''` = ignorar de propósito. */
      origens: (mapa as any[]).map((m) => ({
        origem: m.origem,
        rotulo: m.origemRotulo || m.origem,
        destino: m.destino,
        pecas: m.pecas,
        vistoEm: m.vistoEm,
      })),
      destinos: [...destinos].sort(),
    };
  }

  async salvarCategoriaMapa(origem: string, destino: string | null, quem: string) {
    const chave = String(origem || '').trim().toLowerCase();
    if (!chave) throw new Error('origem obrigatória');
    // `null` volta a categoria pra "sem decisão"; '' marca "ignorar".
    const valor = destino === null ? null : String(destino).trim().toLowerCase();
    await (this.prisma as any).siteCategoriaMapa.upsert({
      where: { origem: chave },
      update: { destino: valor, atualizadoPor: quem },
      create: { origem: chave, origemRotulo: origem, destino: valor, atualizadoPor: quem },
    });
    // A classificação só muda de fato no próximo sync — a tela avisa isso.
    return { ok: true, origem: chave, destino: valor };
  }

  /**
   * CATÁLOGO INTEIRO PRO FEED DO META — uma ida só, sem paginar.
   *
   * O feed de produtos é o que destrava anúncio DINÂMICO (mostrar pra cliente
   * a peça exata que ela olhou). Pra moda costuma ser a campanha de melhor
   * retorno, e sem catálogo cadastrado ela simplesmente não roda.
   *
   * Por que endpoint próprio em vez de paginar o `/produtos`: aquele teto é de
   * 60 por página de propósito (é tela de cliente). O Meta lê o catálogo
   * inteiro uma vez por dia — vinte requisições em sequência levariam dez
   * segundos e correriam risco de estourar o tempo da função. Aqui o custo é
   * pago uma vez por dia, e devolve só os campos que o feed usa.
   *
   * ⚠️ ESGOTADO ENTRA, e é de propósito. O Meta quer o catálogo COMPLETO com
   * a disponibilidade correta em cada item: peça marcada `out of stock` para
   * de ser anunciada e volta sozinha quando reabastece. Some do feed e o Meta
   * trata como produto morto — quando voltar, recomeça o aprendizado do zero.
   */
  async catalogoParaFeed(): Promise<
    Array<{
      ref: string;
      slug: string;
      nome: string;
      descricao: string | null;
      marca: string | null;
      categoria: string | null;
      subcategoria: string | null;
      preco: number;
      precoPromocional: number | null;
      disponivel: boolean;
      imagens: string[];
      tamanhos: string[];
      cores: string[];
    }>
  > {
    /**
     * `listar` trava `perPage` em 60 (proteção da rota pública de vitrine),
     * então pedir 5.000 numa chamada só devolvia a PRIMEIRA página — o feed
     * do Meta ficava com as 60 peças mais novas e o resto do catálogo nunca
     * era anunciado. Percorre as páginas até o fim; teto de 84 páginas
     * (~5.000 itens) como para-choque. `catalogoPublicado` é cacheado, o
     * custo extra é paginação em memória.
     */
    const PAGINA = 60;
    const MAX_PAGINAS = 84;
    const primeira = await this.listar({ page: 1, perPage: PAGINA, ordenar: 'novidades' });
    const itens = [...(primeira.itens as any[])];
    const totalPaginas = Math.min(Number(primeira.totalPages) || 1, MAX_PAGINAS);
    for (let pagina = 2; pagina <= totalPaginas; pagina++) {
      const r = await this.listar({ page: pagina, perPage: PAGINA, ordenar: 'novidades' });
      if (!(r.itens as any[]).length) break;
      itens.push(...(r.itens as any[]));
    }
    return itens.map((p) => ({
      ref: p.ref,
      slug: p.slug,
      nome: p.nome,
      descricao: p.descricaoCurta || p.descricaoCompleta || null,
      marca: p.marca ?? null,
      categoria: p.categoria ?? null,
      subcategoria: p.subcategoria ?? null,
      preco: Number(p.preco) || 0,
      // O Meta compara `sale_price` com `price` pra desenhar o "de/por". Só
      // faz sentido quando há promoção de verdade.
      precoPromocional: p.promocao && p.precoPix ? Number(p.precoPix) : null,
      disponivel: Boolean(p.disponivel),
      imagens: (p.imagens ?? []).map((i: any) => i.src).filter(Boolean),
      tamanhos: (p.tamanhos ?? []).filter((t: any) => t.disponivel).map((t: any) => t.label),
      cores: (p.cores ?? []).map((c: any) => c.nome).filter(Boolean),
    }));
  }

  /**
   * RADAR da tela /retaguarda/cores-sem-foto.
   *
   * Duas listas, tiradas do MESMO catálogo montado que o site serve (cache de
   * 60s — mesma verdade da vitrine):
   *   · `semFoto`  — cores NO AR vendendo com foto de irmã + aviso "ainda não
   *     temos foto" (regra da VOGUE, 13/08). É a fila de quem precisa de foto.
   *   · `ocultas`  — cores escondidas à mão (`nao_publicar` na ficha), pra
   *     tela poder desfazer.
   */
  async coresSemFoto() {
    const pecas = await this.catalogoPublicado();
    const linhas: any[] = [];
    for (const p of pecas as any[]) {
      const semFoto = (p.cores ?? []).filter((c: any) => !(c.fotos?.length));
      const ocultas = p.coresOcultas ?? [];
      if (!semFoto.length && !ocultas.length) continue;
      linhas.push({
        ref: p.ref,
        slug: p.slug,
        nome: p.nome,
        marca: p.marca ?? null,
        capa:
          (p.cores ?? []).find((c: any) => c.fotos?.length)?.fotos?.[0]?.src ??
          p.imagens?.[0]?.src ?? null,
        semFoto: semFoto.map((c: any) => ({
          nome: c.nome,
          estoque: c.estoque,
          refDona: c.refDona ?? p.ref,
          marcaDona: c.marcaDona ?? p.marca ?? null,
        })),
        ocultas,
      });
    }
    return {
      pecas: linhas,
      totais: {
        pecasAfetadas: linhas.length,
        coresSemFoto: linhas.reduce((s, l) => s + l.semFoto.length, 0),
        coresOcultas: linhas.reduce((s, l) => s + l.ocultas.length, 0),
      },
    };
  }

  /**
   * Depois que a tela grava na ficha: derruba o cache do backend E avisa a
   * vitrine, e devolve o radar já recalculado. Sem isto o clique "funciona"
   * no banco e a tela/site seguem mostrando o passado por até 1 hora — o
   * clássico "fiz e não mudou".
   */
  async coresSemFotoRecarregar() {
    this.invalidarCache();
    avisarVitrine(['catalogo', 'categorias', 'filtros'], this.logger, 'cores-sem-foto');
    return this.coresSemFoto();
  }

  /** Detalhe da peça — por slug (site) ou pela própria REF. */
  async porSlug(slug: string) {
    const chave = String(slug || '').trim();
    if (!chave) return null;

    /**
     * A PDP É O MESMO CARD DA VITRINE (12/08/2026).
     *
     * 🔴 Bug encontrado na revisão: a listagem funde a família e a PDP não —
     * ela montava a peça só com as linhas da PRÓPRIA REF. A cliente clicava
     * num card com quatro bolinhas e abria uma página com duas, sem que nada
     * no site explicasse a diferença. Toda regra nova de agrupamento nascia
     * torta pelo mesmo motivo: eram dois caminhos montando "a peça".
     *
     * Agora a PDP procura no catálogo já montado (cache de 60s, o mesmo TTL da
     * borda) e só cai no caminho REF a REF quando a peça não está na vitrine —
     * que é o que permite conferir por link direto uma peça ainda sem foto.
     */
    const refPedida = this.normRef(chave.replace(/^ref-/i, ''));
    const daVitrine = (await this.catalogoPublicado()).find(
      (p: any) =>
        p.slug === chave ||
        this.normRef(p.ref) === refPedida ||
        this.normRef(p.ref) === refBaseOf(refPedida),
    );
    if (daVitrine) return daVitrine;

    let registro = await (this.prisma as any).siteProduto.findUnique({ where: { slug: chave } });
    if (!registro) {
      const ref = this.normRef(chave.replace(/^ref-/i, ''));
      registro = await (this.prisma as any).siteProduto.findUnique({ where: { ref } });
      if (!registro) {
        // Sem curadoria ainda: deixa abrir pela REF se o ERP tiver a peça —
        // é o que permite testar o site antes do primeiro sync de conteúdo.
        const linhasSoltas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
          `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = $1`, ref,
        );
        if (!linhasSoltas.length) return null;
        const c = await this.complementos([ref]);
        return this.montarPeca(
          ref, linhasSoltas, null, c.fit.get(ref), c.fotos.get(ref) ?? [],
          this.escolherFicha(c.fichas.get(ref), linhasSoltas.find((l) => l.marca)?.marca),
          0, c.fichas.get(ref) ?? [],
        );
      }
    }

    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = $1`, registro.ref,
    );
    if (!linhas.length) return null;
    const c = await this.complementos([registro.ref]);
    return this.montarPeca(
      registro.ref, linhas, registro, c.fit.get(registro.ref), c.fotos.get(registro.ref) ?? [],
      this.escolherFicha(c.fichas.get(registro.ref), linhas.find((l) => l.marca)?.marca),
      0, c.fichas.get(registro.ref) ?? [],
    );
  }

  /** Peças da mesma categoria — o "você também pode gostar". */
  async relacionados(slug: string, limite = 8) {
    const peca = await this.porSlug(slug);
    if (!peca) return [];
    const lista = await this.listar({ categoria: peca.categoria ?? undefined, perPage: limite + 1 });
    return lista.itens.filter((p: any) => p.ref !== peca.ref).slice(0, limite);
  }

  /* ── LOOK — "estas peças saem na mesma foto e se vendem juntas" ──────────
   *
   * Dono, 13/08: a Regata 403048 e a Calça Aladdin 406027 são o MESMO look e
   * cada PDP tem que puxar a outra. Fase 1: bloco "Complete o look" na PDP.
   * Fase 2 (quando houver mais fotos de conjunto): botão "Comprar o look".
   *
   * O look guarda REFs cruas; a resolução pro card usa o CATÁLOGO MONTADO
   * (mesma verdade da vitrine, cache de 60s) — nome, preço e foto nunca
   * divergem do que a cliente vê no resto do site. Membro fora da vitrine
   * (despublicado, sem foto) simplesmente não aparece; look que resolver
   * menos de 2 peças não vale um bloco.
   */

  /** O card compacto de um membro do look, resolvido pelo catálogo. */
  private cartaoDoLook(catalogo: any[], ref: string): any | null {
    const alvo = this.normRef(ref);
    const c = catalogo.find(
      (p: any) => this.normRef(p.ref) === alvo || this.normRef(p.ref) === refBaseOf(alvo),
    );
    if (!c) return null;
    return {
      ref: c.ref,
      slug: c.slug,
      nome: c.nome,
      preco: c.preco,
      precoPix: c.precoPix,
      imagem: c.imagens?.[0]?.src ?? null,
      disponivel: !!c.disponivel,
    };
  }

  /**
   * O look de uma peça já montada (chamado só pela PDP). Best-effort de
   * propósito: look quebrado não pode derrubar a página do produto.
   */
  async lookDaPeca(peca: any): Promise<any | null> {
    try {
      const refs = new Set<string>([this.normRef(peca.ref), refBaseOf(this.normRef(peca.ref))]);
      for (const c of peca.cores ?? []) {
        if (c?.refDona) refs.add(this.normRef(c.refDona));
      }
      const membros: any[] = await (this.prisma as any).siteLookPeca.findMany({
        where: { ref: { in: [...refs] } },
        select: { lookId: true },
      });
      if (!membros.length) return null;
      const look = await (this.prisma as any).siteLook.findFirst({
        where: { id: { in: membros.map((m) => m.lookId) } },
        include: { pecas: true },
        orderBy: { criadoEm: 'desc' },
      });
      if (!look) return null;

      const catalogo = await this.catalogoPublicado();
      const vistos = new Set<string>();
      const pecas = (look.pecas as any[])
        .map((m) => {
          const cartao = this.cartaoDoLook(catalogo, m.ref);
          if (!cartao || vistos.has(cartao.ref)) return null;
          vistos.add(cartao.ref);
          return { ...cartao, atual: refs.has(this.normRef(m.ref)) || cartao.ref === peca.ref };
        })
        .filter(Boolean);
      if (pecas.length < 2) return null;
      return { id: look.id, nome: look.nome, pecas };
    } catch (e: any) {
      this.logger.warn(`[look] falha ao resolver look da peça ${peca?.ref}: ${e?.message || e}`);
      return null;
    }
  }

  /** A tela da retaguarda: todos os looks, com o que resolver do catálogo. */
  async listarLooks() {
    const looks: any[] = await (this.prisma as any).siteLook.findMany({
      include: { pecas: true },
      orderBy: { criadoEm: 'desc' },
    });
    const catalogo = await this.catalogoPublicado();
    return looks.map((l) => ({
      id: l.id,
      nome: l.nome,
      criadoPor: l.criadoPor,
      criadoEm: l.criadoEm,
      pecas: (l.pecas as any[]).map((m) => ({
        ref: m.ref,
        // null = fora da vitrine agora (sem foto/despublicada) — a tela avisa.
        cartao: this.cartaoDoLook(catalogo, m.ref),
      })),
    }));
  }

  async criarLook(nome: string, refs: string[], usuario?: string) {
    const limpo = String(nome || '').trim().slice(0, 80);
    if (!limpo) throw new Error('Nome do look é obrigatório');
    const unicas = [...new Set((refs || []).map((r) => this.normRef(r)).filter(Boolean))];
    if (unicas.length < 2) throw new Error('Um look precisa de pelo menos 2 REFs');
    return (this.prisma as any).siteLook.create({
      data: {
        nome: limpo,
        criadoPor: usuario ?? null,
        pecas: { create: unicas.map((ref) => ({ ref })) },
      },
      include: { pecas: true },
    });
  }

  async adicionarPecaAoLook(lookId: string, ref: string) {
    const limpa = this.normRef(ref);
    if (!limpa) throw new Error('REF obrigatória');
    await (this.prisma as any).siteLookPeca.upsert({
      where: { lookId_ref: { lookId, ref: limpa } },
      create: { lookId, ref: limpa },
      update: {},
    });
    return { ok: true };
  }

  async removerPecaDoLook(lookId: string, ref: string) {
    await (this.prisma as any).siteLookPeca.deleteMany({
      where: { lookId, ref: this.normRef(ref) },
    });
    return { ok: true };
  }

  async excluirLook(lookId: string) {
    await (this.prisma as any).siteLook.delete({ where: { id: lookId } });
    return { ok: true };
  }

  /**
   * Nome e ordem de cada categoria/subcategoria — o rótulo dos trechos do
   * feed. Tabela pequena e que quase nunca muda; 5 min de cache evita uma ida
   * ao banco por página do scroll infinito.
   */
  private cacheTaxonomia: { at: number; linhas: any[] } | null = null;
  private async taxonomia(): Promise<any[]> {
    if (this.cacheTaxonomia && Date.now() - this.cacheTaxonomia.at < this.TTL_FILTROS) {
      return this.cacheTaxonomia.linhas;
    }
    let linhas: any[] = [];
    try {
      linhas = await (this.prisma as any).siteCategoria.findMany({
        select: { slug: true, nome: true, paiSlug: true, ordem: true, ativo: true },
        orderBy: { ordem: 'asc' },
      });
    } catch (e: any) {
      // Sem a tabela configurada o feed continua: cai no nome derivado do slug.
      this.logger.warn(`[catalogo] taxonomia indisponível: ${e?.message || e}`);
    }
    this.cacheTaxonomia = { at: Date.now(), linhas };
    return linhas;
  }

  /** "moda-praia" → "Moda praia". Fallback de quem não tem nome cadastrado. */
  private nomeDoSlug(slug: string): string {
    const s = String(slug || '').replace(/[-_]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
  }

  /**
   * FEED DE DESCOBERTA DA PDP — o catálogo inteiro em UMA sequência, começando
   * de onde a cliente está (dono, 12/08/2026).
   *
   * A PDP mostrava quatro peças num carrossel e acabava ali: quem gostou da
   * regata tinha que voltar pro menu, achar a categoria e recomeçar. Aqui a
   * página não termina — ela continua na ordem que a cliente já estava
   * seguindo:
   *
   *   1. o resto da SUBCATEGORIA da peça  ("Regatas", se ela abriu uma regata)
   *   2. o resto da CATEGORIA             ("Mais em Blusas")
   *   3. as outras CATEGORIAS na ordem do menu (Vestidos, e assim por diante)
   *   4. o que não tem categoria, por último
   *
   * A ordem é montada NO SERVIDOR, sobre o catálogo já em cache, porque é o
   * único jeito de a página 7 saber o que a página 1 mostrou: paginar cada
   * trecho no cliente repetiria peça na virada de um bloco pro outro.
   *
   * `contexto` em cada item diz de que trecho ela veio — é o que deixa o site
   * escrever "Vestidos" no meio do rolo em vez de emendar tudo em silêncio.
   */
  async descobrir(slug: string, page = 1, perPage = 12) {
    const pagina = Math.max(1, Number(page) || 1);
    const porPagina = Math.min(48, Math.max(1, Number(perPage) || 12));

    const catalogo = await this.catalogoPublicado();
    // A peça-semente sai do próprio catálogo (custo zero); só quando ela não
    // está na vitrine — sem foto, por exemplo — é que vale uma consulta.
    const semente =
      catalogo.find((p: any) => p.slug === slug || this.normRef(p.ref) === this.normRef(slug)) ??
      (await this.porSlug(slug));
    if (!semente) return { itens: [], total: 0, page: pagina, perPage: porPagina, totalPages: 0 };

    const catSemente = this.slugTaxonomia(semente.categoria);
    const subSemente = this.slugTaxonomia(semente.subcategoria);

    const taxonomia = await this.taxonomia();
    const rotuloDe = new Map<string, string>();
    const ordemDe = new Map<string, number>();
    for (const c of taxonomia) {
      const s = this.slugTaxonomia(c.slug);
      if (c.nome) rotuloDe.set(s, c.nome);
      ordemDe.set(s, Number(c.ordem) || 0);
    }
    const rotulo = (s: string) => rotuloDe.get(s) || this.nomeDoSlug(s);

    /** Peça por peça em baldes; a peça aberta nunca entra no próprio feed. */
    const daSub: any[] = [];
    const daCategoria: any[] = [];
    const porCategoria = new Map<string, any[]>();
    const semCategoria: any[] = [];

    for (const p of catalogo) {
      if (p.ref === semente.ref) continue;
      const cat = this.slugTaxonomia(p.categoria);
      if (!cat) {
        semCategoria.push(p);
      } else if (cat === catSemente) {
        if (subSemente && this.slugTaxonomia(p.subcategoria) === subSemente) daSub.push(p);
        else daCategoria.push(p);
      } else {
        if (!porCategoria.has(cat)) porCategoria.set(cat, []);
        porCategoria.get(cat)!.push(p);
      }
    }

    // As outras categorias entram na ORDEM DO MENU (a mesma que a cliente vê
    // no topo do site) — empate resolve por quantidade de peça, como no menu.
    const outras = Array.from(porCategoria.entries()).sort(
      (a, b) =>
        (ordemDe.get(a[0]) ?? 999) - (ordemDe.get(b[0]) ?? 999) ||
        b[1].length - a[1].length ||
        a[0].localeCompare(b[0], 'pt-BR'),
    );

    const trechos: Array<{ grupo: string; rotulo: string; tipo: string; pecas: any[] }> = [];
    if (subSemente && daSub.length) {
      trechos.push({
        grupo: `sub:${subSemente}`,
        rotulo: rotulo(subSemente),
        tipo: 'subcategoria',
        pecas: daSub,
      });
    }
    if (daCategoria.length) {
      trechos.push({
        grupo: `cat:${catSemente}`,
        // Com a subcategoria antes, este trecho é o RESTO da categoria — o
        // rótulo tem que dizer isso, senão parece que a lista recomeçou.
        rotulo: trechos.length ? `Mais em ${rotulo(catSemente)}` : rotulo(catSemente),
        tipo: 'categoria',
        pecas: daCategoria,
      });
    }
    for (const [cat, pecas] of outras) {
      trechos.push({ grupo: `cat:${cat}`, rotulo: rotulo(cat), tipo: 'outra-categoria', pecas });
    }
    if (semCategoria.length) {
      trechos.push({ grupo: 'sem-categoria', rotulo: 'Outras peças', tipo: 'outra-categoria', pecas: semCategoria });
    }

    // Cada trecho é ordenado como a vitrine ordena (relevância, esgotado por
    // último) — o que muda é só a ordem ENTRE os trechos.
    for (const t of trechos) this.ordenarPecas((t.pecas = [...t.pecas]));

    /**
     * Só a JANELA pedida vira objeto novo. Materializar a sequência inteira a
     * cada página faria o servidor copiar o catálogo todo umas 60 vezes
     * durante um scroll — o feed é longo justamente por desenho.
     */
    const total = trechos.reduce((n, t) => n + t.pecas.length, 0);
    const inicio = (pagina - 1) * porPagina;
    const fim = inicio + porPagina;
    const itens: any[] = [];
    let cursor = 0;
    for (const t of trechos) {
      const inicioT = cursor;
      cursor += t.pecas.length;
      if (cursor <= inicio) continue;
      if (inicioT >= fim) break;
      const de = Math.max(0, inicio - inicioT);
      const ate = Math.min(t.pecas.length, fim - inicioT);
      for (const p of t.pecas.slice(de, ate)) {
        itens.push({ ...p, contexto: { grupo: t.grupo, rotulo: t.rotulo, tipo: t.tipo } });
      }
    }

    return {
      itens,
      total,
      page: pagina,
      perPage: porPagina,
      totalPages: Math.ceil(total / porPagina),
      semente: {
        ref: semente.ref,
        slug: semente.slug,
        categoria: semente.categoria ?? null,
        subcategoria: semente.subcategoria ?? null,
      },
      fonte: 'erp',
    };
  }

  /**
   * FACETAS geradas do catálogo real — nada de lista fixa no front.
   * Só conta o que está publicado E com estoque (filtro que leva a zero
   * resultado é pior que filtro que não existe).
   */
  async filtros() {
    if (this.cacheFiltros && Date.now() - this.cacheFiltros.at < this.TTL_FILTROS) {
      return { ...this.cacheFiltros.data, cache: true };
    }
    const publicadas: any[] = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true }, select: { ref: true, nome: true },
    });
    const refs = publicadas.map((p) => p.ref);
    const linhasCruas: LinhaErp[] = refs.length
      ? await this.prisma.$queryRawUnsafe(`${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = ANY($1)`, refs)
      : [];

    /**
     * A BARRA LATERAL LÊ A MESMA PEÇA QUE A VITRINE (07/08).
     *
     * Estas contagens iam nas linhas CRUAS, sem passar pela separação de REF
     * reciclada — então o "de R$ X até Y" do filtro de preço somava o bolero
     * de R$ 59,90 que nem é a peça publicada, e a lista de tamanhos ganhava o
     * 14 e o 16 de um produto que não está no site.
     */
    const nomePorRef = new Map<string, any>(publicadas.map((p) => [String(p.ref).toUpperCase(), p]));
    const agrupadas = new Map<string, LinhaErp[]>();
    for (const l of linhasCruas) {
      if (!agrupadas.has(l.ref)) agrupadas.set(l.ref, []);
      agrupadas.get(l.ref)!.push(l);
    }
    const linhas: LinhaErp[] = Array.from(agrupadas.entries()).flatMap(([ref, ls]) =>
      this.familiaPublicada(ref, ls, nomePorRef.get(String(ref).toUpperCase())),
    );

    const conta = (mapa: Map<string, number>, chave?: string | null) => {
      const k = String(chave || '').trim();
      if (!k) return;
      mapa.set(k, (mapa.get(k) || 0) + 1);
    };
    const categorias = new Map<string, number>();
    const marcas = new Map<string, number>();
    const cores = new Map<string, number>();
    const tamanhos = new Map<string, number>();
    let precoMin = Infinity, precoMax = 0;

    const refsVistas = new Set<string>();
    for (const l of linhas) {
      if ((l.estoque || 0) <= 0) continue;
      conta(cores, l.cor);
      // Só NÚMERO SOLTO no filtro: a peça marcada "46/48" conta pro 46 E pro
      // 48, em vez de criar uma pílula própria que reparte as peças em duas
      // listas e some da busca por número.
      for (const n of this.numerosDaGrade(l.tamanho)) conta(tamanhos, String(n));
      if (!refsVistas.has(l.ref)) {
        refsVistas.add(l.ref);
        conta(marcas, l.marca);
      }
      if (l.preco > 0) {
        precoMin = Math.min(precoMin, l.preco);
        precoMax = Math.max(precoMax, l.preco);
      }
    }

    // Categoria vem do cadastro comercial, não do grupo fiscal do Giga
    const cadastros: any[] = await (this.prisma as any).siteProduto.findMany({
      where: { ref: { in: Array.from(refsVistas) } },
      select: { categoria: true },
    });
    for (const c of cadastros) conta(categorias, c.categoria);

    const fits: any[] = await (this.prisma as any).fitProduct.findMany({
      where: { ref: { in: Array.from(refsVistas) } },
      select: { modelagem: true },
    });
    const modelagens = new Map<string, number>();
    for (const f of fits) conta(modelagens, f.modelagem);

    /**
     * FILTRO DA VITRINE ≠ CATÁLOGO CRU.
     *
     * O ERP carrega décadas de rótulo herdado: "01", "24-29", "46 48",
     * "50/52", "G7"… A barra lateral ficava com ~30 tamanhos e ~30 cores, e
     * lista desse tamanho não é filtro, é ruído — empurra a peça pra baixo da
     * dobra e a cliente desiste antes de ver produto.
     *
     * O corte é por PRESENÇA (quantas variações usam aquele rótulo), não por
     * lista fixa: rótulo novo legítimo aparece sozinho quando a loja passar a
     * usá-lo, sem ninguém mexer no código.
     */
    const paraLista = (
      m: Map<string, number>,
      opcoes: { ordemNumerica?: boolean; minimo?: number; teto?: number } = {},
    ) => {
      const { ordemNumerica = false, minimo = 2, teto = 18 } = opcoes;
      return Array.from(m.entries())
        .filter(([, qtd]) => qtd >= minimo)
        .sort((a, b) => b[1] - a[1])
        .slice(0, teto)
        .map(([valor, qtd]) => ({ valor, qtd }))
        .sort((a, b) => {
          if (!ordemNumerica) return b.qtd - a.qtd;
          // Numérico na ordem da grade; letra (P, M, G, GG) depois dos números.
          const na = parseInt(a.valor.replace(/\D/g, ''), 10);
          const nb = parseInt(b.valor.replace(/\D/g, ''), 10);
          const aNum = Number.isFinite(na);
          const bNum = Number.isFinite(nb);
          if (aNum && bNum) return na - nb;
          if (aNum) return -1;
          if (bNum) return 1;
          return a.valor.localeCompare(b.valor, 'pt-BR');
        });
    };

    const data = {
      categorias: paraLista(categorias),
      marcas: paraLista(marcas),
      cores: paraLista(cores, { minimo: 3, teto: 16 }),
      /**
       * Tamanho não passa mais por corte de frequência: quem tira o ruído
       * agora é a GRADE (`tamanhoDaCasa`), que é lista fechada. Manter o
       * `minimo: 3` junto com ela sumiria com um 60 legítimo só por ele ter
       * poucas peças — e é justamente a numeração maior que tem menos.
       */
      tamanhos: paraLista(tamanhos, { ordemNumerica: true, minimo: 1, teto: 24 }),
      modelagens: paraLista(modelagens),
      preco: {
        min: Number.isFinite(precoMin) ? Math.floor(precoMin) : 0,
        max: Math.ceil(precoMax),
      },
      pecasPublicadas: refsVistas.size,
      cache: false,
    };
    this.cacheFiltros = { at: Date.now(), data };
    return data;
  }

  /**
   * EDITA o cadastro comercial da peça — e o Flow TOMA POSSE dela.
   *
   * A partir daqui `origemConteudo='flow'` e o importador do site antigo
   * nunca mais sobrescreve essa peça (ver SiteSyncService). É assim que a
   * migração acontece produto a produto, sem data de corte.
   */
  async editar(ref: string, dados: any, usuario?: string) {
    const chave = this.normRef(ref);
    if (!chave) throw new Error('ref obrigatória');

    const texto = (v: any, max: number) =>
      v === undefined ? undefined : (String(v ?? '').trim().slice(0, max) || null);

    const data: any = {
      nome: dados.nome !== undefined ? String(dados.nome).trim().slice(0, 160) : undefined,
      descricaoCurta: texto(dados.descricaoCurta, 2000),
      descricaoCompleta: texto(dados.descricaoCompleta, 20000),
      colecao: texto(dados.colecao, 60),
      linha: texto(dados.linha, 60),
      seo: dados.seo !== undefined ? dados.seo : undefined,
      publicado: dados.publicado !== undefined ? !!dados.publicado : undefined,
      destaque: dados.destaque !== undefined ? !!dados.destaque : undefined,
      lancamento: dados.lancamento !== undefined ? !!dados.lancamento : undefined,
      promocao: dados.promocao !== undefined ? !!dados.promocao : undefined,
      origemConteudo: 'flow',
      editadoPor: usuario ?? null,
      editadoEm: new Date(),
    };
    if (dados.slug) {
      data.slug = String(dados.slug).trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 160);
    }

    const existente = await (this.prisma as any).siteProduto.findUnique({ where: { ref: chave } });
    // Edição da retaguarda aparece na hora: publicar/despublicar uma peça e
    // ela continuar na vitrine por um minuto é o tipo de coisa que faz quem
    // cadastra clicar de novo achando que não salvou.
    this.cacheFiltros = null;
    this.cacheCatalogo = null;

    if (existente) {
      return (this.prisma as any).siteProduto.update({ where: { ref: chave }, data });
    }
    // Peça que nunca passou pelo site antigo: nasce direto no Flow.
    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = $1`, chave,
    );
    if (!linhas.length) throw new Error(`REF ${chave} não existe no ERP`);
    const coresDaRef = Array.from(
      new Set(linhas.map((l) => l.cor).filter(Boolean)),
    ) as string[];
    return (this.prisma as any).siteProduto.create({
      data: {
        ref: chave,
        slug: data.slug || `ref-${chave.toLowerCase()}`,
        publicado: data.publicado ?? false,
        ...data,
        // Depois do spread de propósito: o nome que NASCE aqui já nasce limpo.
        // A descrição do ERP é por VARIAÇÃO ("CAMISA MANGA LONGA POÁ MARROM
        // 46") — gravada crua, virou o título da primeira peça do sistema
        // (13/08). Nome escolhido por gente (data.nome) continua vencendo.
        nome:
          data.nome ||
          limparNomeVitrine(
            linhas[0].descricao,
            chave,
            coresDaRef,
            linhas.find((l) => l.marca)?.marca,
          ) ||
          chave,
      },
    });
  }

  /**
   * VALIDAÇÃO ERP × SITE (exigência do sprint): mostra, com número, tudo que
   * está divergente. É o que responde "o site está fiel ao ERP?".
   */
  async validacao() {
    const [erpAgg] = await this.prisma.$queryRawUnsafe<Array<any>>(`
      SELECT COUNT(DISTINCT UPPER(TRIM(ref)))::int AS refs,
             COUNT(*)::int                          AS skus
        FROM wincred_produtos
       WHERE ref IS NOT NULL AND TRIM(ref) <> ''
    `);

    const [publicadas, comImagem, comFicha, semEstoque] = await Promise.all([
      (this.prisma as any).siteProduto.count({ where: { publicado: true } }),
      (this.prisma as any).siteProduto.count({ where: { publicado: true, imagens: { not: null } } }),
      (this.prisma as any).fitProduct.count(),
      this.prisma.$queryRawUnsafe<Array<{ n: number }>>(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT UPPER(TRIM(p.ref)) AS ref, SUM(COALESCE(e.total,0)) AS est
            FROM wincred_produtos p
            LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque,0)) AS total FROM wincred_estoque GROUP BY codigo) e
              ON e.codigo = p.codigo
           WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> ''
           GROUP BY 1 HAVING SUM(COALESCE(e.total,0)) <= 0
        ) x
      `),
    ]);

    // Publicadas que sumiram do ERP (produto descontinuado ainda no ar)
    const orfas: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT s.ref, s.nome
        FROM site_produto s
       WHERE s.publicado = true
         AND NOT EXISTS (
           SELECT 1 FROM wincred_produtos p WHERE UPPER(TRIM(p.ref)) = s.ref
         )
       LIMIT 50
    `);

    // Publicadas sem NENHUM estoque na rede — o site mostra e a cliente não recebe
    const semGrade: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT s.ref, s.nome
        FROM site_produto s
        LEFT JOIN (
          SELECT UPPER(TRIM(p.ref)) AS ref, SUM(COALESCE(e.total,0)) AS est
            FROM wincred_produtos p
            LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque,0)) AS total FROM wincred_estoque GROUP BY codigo) e
              ON e.codigo = p.codigo
           GROUP BY 1
        ) k ON k.ref = s.ref
       WHERE s.publicado = true AND COALESCE(k.est, 0) <= 0
       LIMIT 50
    `);

    const ultimoSync = await (this.prisma as any).siteSyncLog.findFirst({
      where: { tipo: 'conteudo' }, orderBy: { iniciadoEm: 'desc' },
    });

    return {
      erp: { refs: erpAgg?.refs ?? 0, skus: erpAgg?.skus ?? 0, refsSemEstoque: semEstoque?.[0]?.n ?? 0 },
      site: {
        publicadas,
        comImagem,
        semImagem: publicadas - comImagem,
        comFichaDeCaimento: comFicha,
        coberturaFicha: publicadas > 0 ? Math.round((comFicha / publicadas) * 100) : 0,
      },
      divergencias: {
        publicadasForaDoErp: { qtd: orfas.length, exemplos: orfas.slice(0, 20) },
        publicadasSemEstoque: { qtd: semGrade.length, exemplos: semGrade.slice(0, 20) },
      },
      ultimoSync: ultimoSync
        ? {
            em: ultimoSync.iniciadoEm, duracaoMs: ultimoSync.duracaoMs, lidos: ultimoSync.lidos,
            criados: ultimoSync.criados, atualizados: ultimoSync.atualizados,
            ignorados: ultimoSync.ignorados, falhas: ultimoSync.falhas, detalhes: ultimoSync.detalhes,
          }
        : null,
    };
  }
}
