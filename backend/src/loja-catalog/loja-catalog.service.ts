import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  /** Facetas custam um scan do catálogo — 10 min de cache resolve. */
  private cacheFiltros: { at: number; data: any } | null = null;
  private readonly TTL_FILTROS = 10 * 60_000;

  constructor(private readonly prisma: PrismaService) {}

  private normRef(v?: string | null) {
    return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
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
  private static readonly RUIDO_NO_NOME = [
    'plus size', 'plus-size', 'plussize', 'feminina', 'feminino', 'fem',
  ];

  /**
   * O nome como a cliente lê no card — venha da ficha, do cadastro ou do ERP.
   *
   * Passa em TODOS os caminhos de propósito: o título sujo não vinha só da
   * descrição do ERP. "Regata Feminina Plus Size Ref 700979 Estampa Verde" é
   * nome importado do WooCommerce, e nenhuma limpeza anterior o tocava.
   *
   * Nunca devolve vazio: se a limpeza comer o nome inteiro (peça cujo título
   * era só "Blusa Feminina Plus Size Preto"), volta o original. Peça sem nome
   * na vitrine é pior que peça com nome redundante.
   */
  private limparNomeVitrine(
    nome: string | null | undefined,
    ref: string,
    cores: string[],
    marca?: string | null,
  ): string {
    const original = String(nome || '').trim();
    if (!original) return '';

    const escapar = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const semAcento = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '');
    let txt = original;

    // "Ref 700979", "REF: 700979" e a REF solta — ela vai pro card em campo
    // próprio, em negrito, em vez de diluída no meio da frase.
    txt = txt.replace(new RegExp(`\\bref\\s*:?\\s*${escapar(ref)}\\b`, 'gi'), ' ');
    txt = txt.replace(new RegExp(`\\b${escapar(ref)}\\b`, 'gi'), ' ');
    txt = txt.replace(/\bref\s*:?\s*\d{3,}\b/gi, ' ');

    for (const ruido of LojaCatalogService.RUIDO_NO_NOME) {
      txt = txt.replace(new RegExp(`\\b${escapar(ruido)}\\b`, 'gi'), ' ');
    }

    if (marca) txt = txt.replace(new RegExp(`\\b${escapar(marca)}\\b`, 'gi'), ' ');

    /**
     * A COR — E TUDO O QUE VEM DEPOIS DELA.
     *
     * Nestes nomes (importados do site antigo) a cor MARCA O FIM da parte
     * descritiva; o que sobra atrás é sufixo interno. Exemplos reais:
     *
     *   "T-shirt Feminina Plus Size Manga Curta Ref Vogue Preto LENE"
     *   "T-Shirt Feminina Plus Size Manga Curta STITCH-004 Preto ANA"
     *
     * "LENE" e "ANA" não são marca (as duas são MARRIE) nem cor: são resto de
     * cadastro. Apagar só a palavra da cor deixava esse rabo pendurado.
     *
     * Cores da MAIS LONGA pra mais curta: "ROSA QUEIMADO" tem que casar
     * inteira antes de "ROSA" cortar no meio dela.
     */
    for (const cor of [...cores].sort((a, b) => b.length - a.length)) {
      const alvo = escapar(semAcento(cor).trim());
      if (alvo.length < 3) continue; // "PP", "GG" — arriscado demais
      txt = txt.replace(new RegExp(`\\b${alvo}\\b.*$`, 'i'), ' ');
    }

    /**
     * Qualificador de cor que ficou órfão. "Blusa Manga Curta Estampa
     * Marinho" com a cor gravada só como "MARINHO" perde o "Marinho" e deixa
     * "Estampa" pendurado no fim, qualificando o nada. Some só quando está no
     * FIM: "Blusa Estampa Floral" não é o caso, e "Saia Midi" não é atingida.
     */
    const ORFAOS = /\s+(estampa|estampada?o?|mescla|claro?a?|escuro?a?|m[ée]dio?a?)$/i;
    let limpo = txt.replace(/\s{2,}/g, ' ').trim();
    while (ORFAOS.test(limpo)) limpo = limpo.replace(ORFAOS, '');

    limpo = limpo
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s·,-]+/, '')
      .replace(/[\s·,-]+$/, '')
      .trim();

    return limpo || original;
  }

  /**
   * A descrição CRUA do ERP virando nome de vitrine — sem a cor de outra peça.
   *
   * 🔴 Bug visto no pedido `#LP-000002` (06/08): a peça saiu como
   * **"T-shirt Feminina Plus Size Manga Curta Ref Vogue Preto LENE · VINHO"**.
   * "Preto" não é parte do nome do produto — é a cor da variação que por acaso
   * ficou em primeiro na consulta. Como a descrição do ERP é POR VARIAÇÃO, ela
   * sempre carrega uma cor; usá-la como nome da peça inteira gruda a cor de
   * uma no título de todas, e aí a cliente lê "Preto · VINHO" no próprio
   * carrinho.
   *
   * Tira o que é identificação interna (REF, "Ref XXX", marca) e QUALQUER cor
   * conhecida daquela REF. Conservador: só remove o que sabe ser cor — não sai
   * adivinhando palavra por palavra, senão come pedaço do nome de verdade
   * ("Vinho" pode ser cor, mas "Vogue" é modelo).
   *
   * Isto é REMENDO do dado ruim. O certo é a ficha ter `nomeCurto` — e é por
   * isso que ela ganha desta função na ordem de preferência.
   */
  private nomeDaDescricaoErp(
    descricao: string | null | undefined,
    ref: string,
    cores: string[],
    marca?: string | null,
  ): string {
    let txt = String(descricao || '').trim();
    if (!txt) return '';

    const escapar = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const semAcento = (v: string) =>
      v.normalize('NFD').replace(/[̀-ͯ]/g, '');

    // Remove "Ref VOGUE", "REF: VOGUE" e a REF solta.
    txt = txt.replace(new RegExp(`\\bref\\s*:?\\s*${escapar(ref)}\\b`, 'gi'), ' ');
    txt = txt.replace(new RegExp(`\\b${escapar(ref)}\\b`, 'gi'), ' ');

    if (marca) txt = txt.replace(new RegExp(`\\b${escapar(marca)}\\b`, 'gi'), ' ');

    /**
     * Cores da MAIS LONGA pra mais curta: "ROSA QUEIMADO" tem que sair inteira
     * antes de "ROSA" comer só um pedaço e deixar "QUEIMADO" solto no nome.
     */
    for (const cor of [...cores].sort((a, b) => b.length - a.length)) {
      const alvo = escapar(semAcento(cor).trim());
      if (alvo.length < 3) continue; // "PP", "GG" — arriscado demais
      txt = txt.replace(new RegExp(`\\b${alvo}\\b`, 'gi'), ' ');
    }

    return txt.replace(/\s{2,}/g, ' ').replace(/[\s·,-]+$/, '').trim();
  }

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

  /**
   * Das linhas de uma REF, devolve SÓ as do produto que a retaguarda publicou.
   * REF com uma família só (o caso normal) passa direto, sem custo.
   */
  private familiaPublicada(ref: string, linhas: LinhaErp[], site: any): LinhaErp[] {
    if (linhas.length < 2) return linhas;

    const porFamilia = new Map<string, LinhaErp[]>();
    for (const l of linhas) {
      const f = this.familiaDe(l.descricao);
      if (!porFamilia.has(f)) porFamilia.set(f, []);
      porFamilia.get(f)!.push(l);
    }
    if (porFamilia.size < 2) return linhas;

    // 1) A família do NOME PUBLICADO manda — é a peça que a loja escolheu pôr
    //    no site, e o nome dela veio de quem cadastrou, não do ERP.
    const familiaDoSite = this.familiaDe(site?.nome);
    let escolhida = familiaDoSite !== '_outros' ? porFamilia.get(familiaDoSite) : undefined;
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

  private readonly SQL_VARIACOES = `
    SELECT
      UPPER(TRIM(p.ref))                          AS ref,
      p.codigo                                    AS codigo,
      NULLIF(TRIM(p.cor), '')                     AS cor,
      NULLIF(TRIM(p.tamanho), '')                 AS tamanho,
      NULLIF(TRIM(p.marca), '')                   AS marca,
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
     * Cor SEM FOTO não vai pro site (decisão do dono, 03/08): bolinha que
     * abre galeria vazia é pior que cor a menos. A ficha (`produto_ficha_cor`)
     * traz a bolinha — hex do conta-gotas ou recorte da foto pra estampa.
     */
    const fichaPorCor = new Map<string, any>(
      ((ficha?.cores ?? []) as any[]).map((c) => [String(c.cor || '').toUpperCase(), c]),
    );
    const fotosPorCor = new Map<string, any[]>();
    for (const f of fotos) {
      const k = String(f.cor || '').toUpperCase();
      if (!fotosPorCor.has(k)) fotosPorCor.set(k, []);
      fotosPorCor.get(k)!.push(f);
    }

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
      // TRANSIÇÃO: enquanto a REF não tiver NENHUMA foto própria (o acervo
      // ainda está vindo do WooCommerce, sem cor associada), mostra todas as
      // cores. A partir da primeira foto no R2, vale a regra: cor sem foto
      // não aparece.
      .filter((c) => c.fotos.length > 0 || fotos.length === 0);

    const dataAlt = linhas.map((l) => l.dataAlt).filter(Boolean).sort()
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

    return {
      ref,
      slug: site?.slug || `ref-${ref.toLowerCase()}`,
      /**
       * Ordem: ficha → cadastro do site → descrição do ERP LIMPA → a REF.
       * A crua nunca entra inteira: ela carrega a cor de UMA variação, e isso
       * gruda "Preto" no nome de uma peça vinho.
       */
      nome: this.limparNomeVitrine(
        nomeDaFicha ||
          site?.nome ||
          this.nomeDaDescricaoErp(
            linhas[0]?.descricao,
            ref,
            Array.from(cores.keys()),
            linhas.find((l) => l.marca)?.marca,
          ) ||
          ref,
        ref,
        Array.from(cores.keys()),
        linhas.find((l) => l.marca)?.marca,
      ) || ref,
      descricaoCurta: site?.descricaoCurta ?? null,
      descricaoCompleta: descricaoDaFicha || site?.descricaoCompleta || null,
      marca: linhas.find((l) => l.marca)?.marca ?? null,
      // Categoria COMERCIAL (do cadastro do site). O grupo do Giga vai
      // separado: é classificação fiscal, não serve pro menu da loja.
      categoria: site?.categoria ?? null,
      grupoErp: linhas.find((l) => l.categoria)?.categoria ?? null,

      preco,
      /** Vazio = preço único. Com 2+, o site mostra os dois: "44–54" e "56–60". */
      faixasPreco,
      // Pix e parcelamento são convenção da marca (5% / 12x), não dado do ERP.
      precoPix: preco > 0 ? Number((preco * 0.95).toFixed(2)) : null,
      parcelamento: preco > 0 ? { vezes: 12, valor: Number((preco / 12).toFixed(2)) } : null,

      cores: coresDetalhadas,
      tamanhos,
      estoqueTotal,
      disponivel: estoqueTotal > 0,

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
      lancamento: !!site?.lancamento,
      promocao: !!site?.promocao,
      atualizadoEm: dataAlt ?? null,

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

  /** Listagem paginada — o que a página de categoria e a busca consomem. */
  async listar(params: ListarParams) {
    const page = Math.max(1, Number(params.page) || 1);
    const perPage = Math.min(60, Math.max(1, Number(params.perPage) || 24));

    // 1) REFs publicadas (curadoria) — a lista de saída nunca é maior que isso
    const wherePub: any = { publicado: true };
    if (params.categoria) wherePub.categoria = String(params.categoria).trim().toLowerCase();
    if (params.soPromocao) wherePub.promocao = true;
    if (params.soNovidade) wherePub.lancamento = true;
    const publicadas: any[] = await (this.prisma as any).siteProduto.findMany({
      where: wherePub, select: { ref: true },
    });
    if (!publicadas.length) {
      return { itens: [], total: 0, page, perPage, totalPages: 0, fonte: 'erp', aviso: 'nenhuma REF publicada — rode o sync de conteúdo' };
    }
    const refsPub = publicadas.map((p) => p.ref);

    // 2) Variações do ERP dessas REFs
    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = ANY($1)`, refsPub,
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
    const { site, fit, fotos, fichas } = await this.complementos(Array.from(porRef.keys()));

    let pecas = Array.from(porRef.entries()).map(([ref, ls]) =>
      this.montarPeca(
        ref, ls, site.get(ref), fit.get(ref), fotos.get(ref) ?? [],
        this.escolherFicha(fichas.get(ref), ls.find((l) => l.marca)?.marca),
      ),
    );

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

    /**
     * PEÇA SEM FOTO NUNCA CHEGA À VITRINE (item 39).
     *
     * Card sem imagem é buraco na grade e destrói a confiança na loja inteira.
     * Vale pra listagem; a PDP continua abrindo por link direto (é o que
     * permite conferir a peça antes de publicar).
     */
    const semFoto = pecas.filter((p) => !p.imagens.length);
    if (semFoto.length) {
      pecas = pecas.filter((p) => p.imagens.length > 0);
      this.logger.warn(
        `[catalogo] ${semFoto.length} REF(s) publicada(s) sem foto — fora da vitrine: ` +
          semFoto.slice(0, 15).map((p) => p.ref).join(', '),
      );
    }

    // 4) Ordenação
    const ord = params.ordenar || 'relevancia';
    pecas.sort((a, b) => {
      switch (ord) {
        case 'preco-asc': return a.preco - b.preco;
        case 'preco-desc': return b.preco - a.preco;
        case 'nome': return a.nome.localeCompare(b.nome, 'pt-BR');
        case 'novidades':
          return new Date(b.atualizadoEm ?? 0).getTime() - new Date(a.atualizadoEm ?? 0).getTime();
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

  /** Detalhe da peça — por slug (site) ou pela própria REF. */
  async porSlug(slug: string) {
    const chave = String(slug || '').trim();
    if (!chave) return null;

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
    );
  }

  /** Peças da mesma categoria — o "você também pode gostar". */
  async relacionados(slug: string, limite = 8) {
    const peca = await this.porSlug(slug);
    if (!peca) return [];
    const lista = await this.listar({ categoria: peca.categoria ?? undefined, perPage: limite + 1 });
    return lista.itens.filter((p: any) => p.ref !== peca.ref).slice(0, limite);
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
    this.cacheFiltros = null;

    if (existente) {
      return (this.prisma as any).siteProduto.update({ where: { ref: chave }, data });
    }
    // Peça que nunca passou pelo site antigo: nasce direto no Flow.
    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = $1`, chave,
    );
    if (!linhas.length) throw new Error(`REF ${chave} não existe no ERP`);
    return (this.prisma as any).siteProduto.create({
      data: {
        ref: chave,
        slug: data.slug || `ref-${chave.toLowerCase()}`,
        nome: data.nome || linhas[0].descricao || chave,
        publicado: data.publicado ?? false,
        ...data,
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
