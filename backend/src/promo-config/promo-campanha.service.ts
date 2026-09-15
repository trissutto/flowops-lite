import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromoConfigService } from './promo-config.service';
import {
  ConfigCampanha,
  DecisaoCampanha,
  DecisaoExcecao,
  EstruturaCampanha,
  ExcecaoCampanha,
  LinhaCampanha,
  RegraCampanha,
  TextoIndexado,
  chaveDaCampanha,
  chaveDaFamilia,
  compilarTermo,
  criarRegra,
  formaDoTermo,
  normalizarConfig,
  precoComDesconto,
  sugestoesPara,
  termoCasa,
  textoDaLinha,
  textoNormalizado,
} from '../common/promo-por-termo';
import { familiaDaDescricao } from '../common/produto-discriminador';

/** Linha do catálogo com o que a campanha lê e o que a tela mostra. */
export interface LinhaCatalogoCampanha extends LinhaCampanha {
  codigo: string;
  ref: string | null;
  preco: number;
}

/** Grupo/subgrupo do ERP de uma linha — pra régua (por código) e pros filtros da tela. */
interface EstruturaDaLinha {
  grupoId: number | null;
  subgrupoId: number | null;
  /** Nome pela tabela de grupos (o `nomeGrupo` do produto vem vazio em 12 mil códigos). */
  grupoNome: string | null;
  subgrupoNome: string | null;
}

/**
 * De onde a peça entrou pela estrutura — o texto que a tela e o PDV mostram.
 * Subgrupo escolhido fala mais que o grupo (é a escolha mais fina).
 */
function rotuloDaEstrutura(l: EstruturaDaLinha, grupos: Set<number>, subgrupos: Set<number>): string | null {
  if (l.subgrupoId != null && subgrupos.has(l.subgrupoId)) {
    const nome = l.subgrupoNome || `#${l.subgrupoId}`;
    return `subgrupo ${nome}${l.grupoNome ? ` (${l.grupoNome})` : ''}`;
  }
  if (l.grupoId != null && grupos.has(l.grupoId)) return `grupo ${l.grupoNome || `#${l.grupoId}`}`;
  return null;
}

const numeroOuNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

export interface FiltroProdutosCampanha {
  /** REF, código ou palavras da descrição (todas precisam aparecer). */
  busca?: string | null;
  grupo?: number | null;
  subgrupo?: number | null;
  marca?: string | null;
  participacao?: 'todos' | 'dentro' | 'fora';
  pagina?: number;
  porPagina?: number;
}

export interface ProdutoNaBusca {
  chave: string;
  refs: string[];
  descricao: string;
  grupo: string | null;
  subgrupo: string | null;
  marca: string | null;
  precoMin: number;
  precoMax: number;
  /** Menor preço com desconto entre as linhas que entram (0 = nenhuma entra). */
  precoPromoMin: number;
  estoque: number;
  codigos: number;
  codigosNaCampanha: number;
  /**
   * entra/parcial pela regra · fora sem regra · excluida por palavra · basico
   * (linha BÁSICA na Classificação) · tirada/incluida na mão.
   */
  situacao: 'entra' | 'parcial' | 'fora' | 'excluida' | 'basico' | 'tirada' | 'incluida';
  /** Termos e grupos/subgrupos que puseram a peça. */
  origens: string[];
  /** Palavras que tiraram a peça da regra. */
  exclusoes: string[];
  /**
   * Os TIPOS de peça sob a mesma REF-BASE ("CALCA", "BOLERO"…), mais estoque
   * primeiro. Mais de um = REF reciclada: incluir/tirar vale pra família
   * inteira, e a matriz precisa ver que a calça vai junto com o casaco.
   */
  tipos: string[];
  excecao: ExcecaoCampanha | null;
}

export interface BuscaProdutosCampanha {
  campanha: ConfigCampanha;
  chaveCampanha: string;
  total: number;
  totais: { dentro: number; fora: number };
  pagina: number;
  porPagina: number;
  produtos: ProdutoNaBusca[];
}

export interface EstruturaDoCatalogo {
  grupos: Array<{ codigo: number; nome: string; codigos: number; pecas: number }>;
  subgrupos: Array<{ codigo: number; nome: string; grupo: number | null; grupoNome: string | null; codigos: number; pecas: number }>;
  marcas: Array<{ nome: string; pecas: number }>;
  pecasTotal: number;
  pecasSemGrupo: number;
}

export interface FamiliaNaCampanha {
  chave: string;
  refs: string[];
  descricao: string;
  grupo: string | null;
  precoMin: number;
  precoMax: number;
  /** Menor preço com o desconto da campanha (o "a partir de" da vitrine). */
  precoPromoMin: number;
  /** Peças que ENTRAM (na tirada, a família toda). */
  estoque: number;
  /** Peças da família inteira — difere de `estoque` só na família parcial. */
  estoqueFamilia: number;
  codigos: number;
  codigosNaCampanha: number;
  termos: string[];
  /** Termos + grupos/subgrupos que puseram a peça (o que a tela mostra na coluna). */
  origens: string[];
  /** entra = todas as linhas · parcial = REF reciclada, só parte casou. */
  situacao: 'entra' | 'parcial' | 'tirada' | 'incluida';
  excecao: ExcecaoCampanha | null;
}

export interface PreviewCampanha {
  campanha: ConfigCampanha;
  /** A chave da lista de exceções que vale pra esse nome. */
  chaveCampanha: string;
  totais: { familias: number; estoque: number; tiradas: number; incluidas: number; parciais: number };
  familias: FamiliaNaCampanha[];
  sugestoes: Array<{ termo: string; familias: number; estoque: number; exemplos: string[] }>;
  excecoes: ExcecaoCampanha[];
  calculadoEm: string;
}

type LinhaDoCatalogo = LinhaCatalogoCampanha & EstruturaDaLinha & { estoque: number; marca: string | null };
type LinhaIndexada = { l: LinhaDoCatalogo; t: TextoIndexado; chave: string };

/** Devolve a vez pro event loop — varredura do catálogo não pode travar o bipe das lojas. */
const folga = () => new Promise<void>((res) => setImmediate(res));

/**
 * A CAMPANHA POR TERMO em serviço — quem carrega config e exceções e entrega a
 * régua pronta (`common/promo-por-termo.ts`) pra vitrine, trava do carrinho,
 * troca de peça e caixa.
 *
 * Módulo FOLHA (só Prisma): catálogo, pedidos e PDV importam este módulo, e
 * ele não importa nenhum deles — aresta nova no grafo já derrubou o boot em
 * 07/08.
 *
 * ── CACHE ──
 *
 * A régua fica 60s em memória e cai NA HORA quando alguém grava (config ou
 * exceção). O bipe do PDV consulta a campanha a cada leitura: sem cache seriam
 * duas idas ao banco por peça bipada. Se a recarga falhar, vale a última régua
 * boa — os quatro chamadores continuam concordando entre si, que é o que evita
 * pedido recusado no checkout e preço diferente no balcão. Sem régua nenhuma
 * pra devolver, o erro SOBE.
 */
@Injectable()
export class PromoCampanhaService {
  private readonly logger = new Logger(PromoCampanhaService.name);

  private cache: { at: number; regra: RegraCampanha } | null = null;
  private emVoo: Promise<RegraCampanha> | null = null;
  private static readonly TTL = 60_000;

  /**
   * Os códigos dos grupos/subgrupos escolhidos, guardados 5 min: a lista muda
   * só quando nasce produto no ERP, e sem isto seria uma varredura do espelho a
   * cada minuto de régua. A chave é a própria escolha — mudar a config erra o
   * cache sozinha.
   */
  private cacheEstrutura: { chave: string; at: number; estrutura: EstruturaCampanha } | null = null;
  private static readonly TTL_ESTRUTURA = 5 * 60_000;

  /**
   * Catálogo COM ESTOQUE NA REDE, indexado uma vez e guardado 2 min: a matriz
   * digita um termo e confere o efeito na hora, várias vezes seguidas — sem
   * este cache seria uma varredura do espelho inteiro por tecla.
   */
  private baseCatalogo: { at: number; linhas: LinhaIndexada[] } | null = null;

  /** Decisões da última busca da tela: trocar só o filtro não decide o catálogo de novo. */
  private memoDecisoes: { chave: string; decisoes: DecisaoCampanha[] } | null = null;

  /**
   * As REFs marcadas BÁSICO na tela de Classificação (~8,5 mil em 15/09),
   * relidas junto com a régua (60s): reclassificar lá vale no caixa e no site
   * em até um minuto, sem esta tela precisar saber que a outra gravou.
   */
  private cacheBasicos: { at: number; chaves: Set<string> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly promoConfig: PromoConfigService,
  ) {}

  /** Derruba a régua em memória — toda gravação chama. */
  invalidar() {
    this.cache = null;
    this.cacheEstrutura = null;
    this.cacheBasicos = null;
    this.memoDecisoes = null;
    this.promoConfig.clearCache();
  }

  /**
   * Chaves BÁSICO (`chaveDeClassificacao`). Erro de leitura SOBE: sem a lista
   * não se sabe o que é básico, e a régua anterior (que sabia) continua
   * valendo pelo fallback de `regra()` — errar pro lado de dar desconto em
   * linha básica é o que o dono proibiu.
   */
  private async basicos(): Promise<Set<string>> {
    const c = this.cacheBasicos;
    if (c && Date.now() - c.at < PromoCampanhaService.TTL) return c.chaves;
    const rows: any[] = await (this.prisma as any).productClassification.findMany({
      where: { tipoProduto: 1 },
      select: { ref: true },
    });
    const chaves = new Set<string>();
    for (const r of rows) {
      const k = String(r.ref ?? '').trim().toUpperCase();
      if (k) chaves.add(k);
    }
    this.cacheBasicos = { at: Date.now(), chaves };
    return chaves;
  }

  async regra(): Promise<RegraCampanha> {
    if (this.cache && Date.now() - this.cache.at < PromoCampanhaService.TTL) return this.cache.regra;
    if (this.emVoo) return this.emVoo;
    this.emVoo = (async () => {
      try {
        this.promoConfig.clearCache();
        const { campanha } = await this.promoConfig.getConfig();
        const excecoes = await this.excecoesDe(chaveDaCampanha(campanha.nome));
        const estrutura = await this.estruturaDe(campanha.grupos, campanha.subgrupos);
        const basicos = campanha.excluirBasico ? await this.basicos() : null;
        const regra = criarRegra(campanha, excecoes, estrutura, basicos);
        this.cache = { at: Date.now(), regra };
        return regra;
      } catch (e: any) {
        if (this.cache) {
          this.logger.warn(`[campanha] recarga falhou — valendo a última régua boa: ${e?.message || e}`);
          // Tenta de novo em 10s em vez de martelar o banco a cada bipe.
          this.cache = { at: Date.now() - PromoCampanhaService.TTL + 10_000, regra: this.cache.regra };
          return this.cache.regra;
        }
        throw e;
      } finally {
        this.emVoo = null;
      }
    })();
    return this.emVoo;
  }

  /**
   * Os códigos que entram por grupo/subgrupo — do espelho INTEIRO, com ou sem
   * estoque: o caixa vende peça que o espelho conta zerada (divergência de
   * saldo), e ela tem que sair com o mesmo preço que a vitrine mostraria.
   * Sem escolha nenhuma não vai ao banco.
   */
  private async estruturaDe(grupos: number[], subgrupos: number[]): Promise<EstruturaCampanha | null> {
    if (!grupos.length && !subgrupos.length) return null;
    const chave = `${grupos.join(',')}|${subgrupos.join(',')}`;
    const c = this.cacheEstrutura;
    if (c && c.chave === chave && Date.now() - c.at < PromoCampanhaService.TTL_ESTRUTURA) return c.estrutura;

    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT p.codigo,
              p.grupo    AS "grupoId",
              p.subgrupo AS "subgrupoId",
              COALESCE(NULLIF(TRIM(g.grupo), ''), NULLIF(TRIM(p."nomeGrupo"), '')) AS "grupoNome",
              NULLIF(TRIM(s.subgrupo), '') AS "subgrupoNome"
         FROM wincred_produtos p
         LEFT JOIN wincred_grupos g ON g.codigo = p.grupo
         LEFT JOIN wincred_subgrupos s ON s.codigo = p.subgrupo
        WHERE p.grupo = ANY($1::int[]) OR p.subgrupo = ANY($2::int[])`,
      grupos,
      subgrupos,
    );
    const setG = new Set(grupos);
    const setS = new Set(subgrupos);
    const porCodigo = new Map<string, string>();
    for (const r of rows) {
      const rotulo = rotuloDaEstrutura(
        {
          grupoId: numeroOuNull(r.grupoId),
          subgrupoId: numeroOuNull(r.subgrupoId),
          grupoNome: r.grupoNome ?? null,
          subgrupoNome: r.subgrupoNome ?? null,
        },
        setG,
        setS,
      );
      if (rotulo) porCodigo.set(String(r.codigo).trim(), rotulo);
    }
    const estrutura: EstruturaCampanha = { porCodigo };
    this.cacheEstrutura = { chave, at: Date.now(), estrutura };
    return estrutura;
  }

  /** A mesma estrutura, montada das linhas já carregadas (prévia do rascunho). */
  private estruturaDasLinhas(linhas: LinhaIndexada[], config: ConfigCampanha): EstruturaCampanha | null {
    if (!config.grupos.length && !config.subgrupos.length) return null;
    const setG = new Set(config.grupos);
    const setS = new Set(config.subgrupos);
    const porCodigo = new Map<string, string>();
    for (const { l } of linhas) {
      const rotulo = rotuloDaEstrutura(l, setG, setS);
      if (rotulo) porCodigo.set(String(l.codigo).trim(), rotulo);
    }
    return { porCodigo };
  }

  private async excecoesDe(campanha: string): Promise<ExcecaoCampanha[]> {
    const rows: any[] = await (this.prisma as any).promoCampanhaExcecao.findMany({
      where: { campanha },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.excecaoDaLinha(r));
  }

  private excecaoDaLinha(r: any): ExcecaoCampanha {
    return {
      chave: String(r.chave),
      decisao: r.decisao === 'dentro' ? 'dentro' : 'fora',
      motivo: r.motivo ?? null,
      origem: r.origem ?? null,
      storeCode: r.storeCode ?? null,
      usuario: r.usuario ?? null,
      refExemplo: r.refExemplo ?? null,
      descricao: r.descricao ?? null,
      em: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    };
  }

  /**
   * O texto que a campanha lê, por código — do espelho `wincred_produtos`, a
   * MESMA tabela que a vitrine e a trava do carrinho leem. O bipe resolve a
   * peça pela tabela nativa; decidir a campanha por outra fonte que a do site
   * seria abrir espaço pra dois preços.
   */
  async linhasPorCodigo(codigos: string[]): Promise<Map<string, LinhaCatalogoCampanha>> {
    const lista = Array.from(new Set(codigos.map((c) => String(c ?? '').trim()).filter(Boolean)));
    const out = new Map<string, LinhaCatalogoCampanha>();
    if (!lista.length) return out;
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT p.codigo,
              NULLIF(UPPER(TRIM(p.ref)), '') AS ref,
              p."descricaoCompleta" AS descricao,
              p."descricaoPdv"      AS "descricaoPdv",
              p."nomeGrupo"         AS grupo,
              COALESCE(p."vendaUn", 0)::float8 AS preco
         FROM wincred_produtos p
        WHERE p.codigo = ANY($1)`,
      lista,
    );
    for (const r of rows) {
      out.set(String(r.codigo), {
        codigo: String(r.codigo),
        ref: r.ref ?? null,
        descricao: r.descricao ?? null,
        descricaoPdv: r.descricaoPdv ?? null,
        grupo: r.grupo ?? null,
        preco: Number(r.preco) || 0,
      });
    }
    return out;
  }

  /** Uma peça só (consulta do PDV, troca de peça). null = código fora do catálogo. */
  async decidirCodigo(
    codigo: string,
  ): Promise<{ regra: RegraCampanha; linha: LinhaCatalogoCampanha; decisao: DecisaoCampanha } | null> {
    const cod = String(codigo ?? '').trim();
    const [regra, linhas] = await Promise.all([this.regra(), this.linhasPorCodigo([cod])]);
    const linha = linhas.get(cod);
    if (!linha) return null;
    return { regra, linha, decisao: regra.decidir(linha) };
  }

  async listarExcecoes(): Promise<{ campanha: string; excecoes: ExcecaoCampanha[] }> {
    const { campanha } = await this.promoConfig.getConfig();
    const chave = chaveDaCampanha(campanha.nome);
    return { campanha: chave, excecoes: await this.excecoesDe(chave) };
  }

  /**
   * Tira (`fora`) ou põe (`dentro`) a FAMÍLIA na campanha.
   *
   * Chega o código bipado ou a REF digitada; a chave gravada é sempre a da
   * família (`chaveDaFamilia`), e a descrição da peça vai junto pra lista da
   * retaguarda explicar a linha sem precisar do catálogo.
   */
  async gravarExcecao(input: {
    codigo?: string | null;
    ref?: string | null;
    decisao: DecisaoExcecao;
    motivo?: string | null;
    origem: 'pdv' | 'retaguarda';
    storeCode?: string | null;
    usuario?: string | null;
  }): Promise<{ excecao: ExcecaoCampanha; campanha: string }> {
    const decisao: DecisaoExcecao | null =
      input.decisao === 'fora' || input.decisao === 'dentro' ? input.decisao : null;
    if (!decisao) throw new BadRequestException('decisao tem que ser "fora" ou "dentro"');

    const codigo = String(input.codigo ?? '').trim();
    const refDigitada = String(input.ref ?? '').trim().toUpperCase();
    let refExemplo: string | null = refDigitada || null;
    let descricao: string | null = null;
    let chave = '';

    if (codigo) {
      let linha = (await this.linhasPorCodigo([codigo])).get(codigo);
      if (!linha) {
        // Etiqueta antiga traz o EAN do fornecedor, não o código — o bipe do
        // PDV acha pela coluna `ean`, e a retaguarda tem que achar a mesma peça.
        const digitos = codigo.replace(/\D/g, '');
        const porEan: any[] = await this.prisma.$queryRawUnsafe(
          `SELECT codigo FROM wincred_produtos WHERE ean = ANY($1) LIMIT 1`,
          Array.from(new Set([codigo, digitos])).filter((e) => e.length >= 8),
        );
        const cod = porEan[0]?.codigo ? String(porEan[0].codigo) : '';
        if (cod) linha = (await this.linhasPorCodigo([cod])).get(cod);
      }
      if (!linha) throw new NotFoundException(`Código ${codigo} não está no catálogo.`);
      chave = chaveDaFamilia(linha.ref, linha.codigo);
      refExemplo = linha.ref || `#${linha.codigo}`;
      descricao = linha.descricao || linha.descricaoPdv || null;
    } else if (refDigitada) {
      const amostra: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT UPPER(TRIM(ref)) AS ref, "descricaoCompleta" AS descricao
           FROM wincred_produtos
          WHERE UPPER(TRIM(ref)) = $1
          LIMIT 1`,
        refDigitada,
      );
      if (!amostra.length) throw new NotFoundException(`REF ${refDigitada} não está no catálogo.`);
      chave = chaveDaFamilia(refDigitada);
      descricao = amostra[0]?.descricao ?? null;
    }
    if (!chave) throw new BadRequestException('Informe o código ou a REF da peça.');

    const { campanha: cfg } = await this.promoConfig.getConfig();
    const campanha = chaveDaCampanha(cfg.nome);
    const dados = {
      decisao,
      motivo: String(input.motivo ?? '').trim().slice(0, 300) || null,
      origem: input.origem,
      storeCode: input.storeCode ? String(input.storeCode).slice(0, 10) : null,
      usuario: input.usuario ? String(input.usuario).slice(0, 120) : null,
      refExemplo: refExemplo ? refExemplo.slice(0, 40) : null,
      descricao: descricao ? String(descricao).trim().slice(0, 120) : null,
    };
    const row = await (this.prisma as any).promoCampanhaExcecao.upsert({
      where: { campanha_chave: { campanha, chave } },
      create: { campanha, chave, ...dados },
      update: dados,
    });
    this.invalidar();
    await this.registrar('promo-campanha.excecao', { campanha, chave, ...dados });
    this.logger.log(
      `[campanha] ${chave} ${decisao === 'fora' ? 'TIRADA da' : 'POSTA na'} campanha "${cfg.nome}" · ` +
        `${input.origem}${dados.storeCode ? ` loja ${dados.storeCode}` : ''} · por ${dados.usuario || '?'}`,
    );
    return { excecao: this.excecaoDaLinha(row), campanha };
  }

  /** Devolve a família à regra dos termos (apaga a exceção dela). */
  async removerExcecao(chaveEntrada: string, meta: { usuario?: string | null; origem: string }) {
    const chave = String(chaveEntrada ?? '').trim().toUpperCase();
    if (!chave) throw new BadRequestException('chave obrigatória');
    const { campanha: cfg } = await this.promoConfig.getConfig();
    const campanha = chaveDaCampanha(cfg.nome);
    const atual = await (this.prisma as any).promoCampanhaExcecao.findUnique({
      where: { campanha_chave: { campanha, chave } },
    });
    if (!atual) throw new NotFoundException(`A família ${chave} não tem exceção na campanha "${cfg.nome}".`);
    await (this.prisma as any).promoCampanhaExcecao.delete({ where: { id: atual.id } });
    this.invalidar();
    await this.registrar('promo-campanha.excecao-removida', {
      campanha,
      chave,
      eraDecisao: atual.decisao,
      eraMotivo: atual.motivo,
      eraPor: atual.usuario,
      eraLoja: atual.storeCode,
      removidaPor: meta.usuario || null,
      origem: meta.origem,
    });
    this.logger.log(`[campanha] ${chave}: exceção "${atual.decisao}" removida por ${meta.usuario || '?'}`);
    return { ok: true, chave };
  }

  private async registrar(event: string, payload: Record<string, unknown>) {
    try {
      await (this.prisma as any).integrationLog.create({
        data: {
          source: 'crm',
          direction: 'out',
          event,
          status: 200,
          payload: JSON.stringify({ ...payload, quando: new Date().toISOString() }).slice(0, 60000),
        },
      });
    } catch (e: any) {
      // A exceção já está gravada e valendo; o log é o rastro, não a regra.
      this.logger.warn(`[campanha] log de auditoria falhou: ${e?.message || e}`);
    }
  }

  // ── Retaguarda: o que entra, com estoque ─────────────────────────────────

  private async catalogoComEstoque(): Promise<LinhaIndexada[]> {
    if (this.baseCatalogo && Date.now() - this.baseCatalogo.at < 120_000) return this.baseCatalogo.linhas;
    const t0 = Date.now();
    // `grupo` (o `nomeGrupo` do PRODUTO) é o que a régua lê como texto — o
    // mesmo campo da vitrine e da trava do carrinho. O nome pela tabela de
    // grupos (`grupoNome`) é só pra tela e pros filtros: ler outro texto na
    // prévia faria a matriz ver uma peça entrar que o site não daria desconto.
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT p.codigo,
              NULLIF(UPPER(TRIM(p.ref)), '') AS ref,
              p."descricaoCompleta" AS descricao,
              p."descricaoPdv"      AS "descricaoPdv",
              p."nomeGrupo"         AS grupo,
              p.grupo               AS "grupoId",
              p.subgrupo            AS "subgrupoId",
              COALESCE(NULLIF(TRIM(g.grupo), ''), NULLIF(TRIM(p."nomeGrupo"), '')) AS "grupoNome",
              NULLIF(TRIM(s.subgrupo), '') AS "subgrupoNome",
              NULLIF(UPPER(TRIM(p.marca)), '') AS marca,
              COALESCE(p."vendaUn", 0)::float8 AS preco,
              e.total::int AS estoque
         FROM wincred_produtos p
         JOIN (
           SELECT codigo, SUM(GREATEST(COALESCE(estoque, 0), 0)) AS total
             FROM wincred_estoque
            GROUP BY codigo
           HAVING SUM(GREATEST(COALESCE(estoque, 0), 0)) > 0
         ) e ON e.codigo = p.codigo
         LEFT JOIN wincred_grupos g ON g.codigo = p.grupo
         LEFT JOIN wincred_subgrupos s ON s.codigo = p.subgrupo`,
    );
    const linhas: LinhaIndexada[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const l: LinhaDoCatalogo = {
        codigo: String(r.codigo),
        ref: r.ref ?? null,
        descricao: r.descricao ?? null,
        descricaoPdv: r.descricaoPdv ?? null,
        grupo: r.grupo ?? null,
        grupoId: numeroOuNull(r.grupoId),
        subgrupoId: numeroOuNull(r.subgrupoId),
        grupoNome: r.grupoNome ?? null,
        subgrupoNome: r.subgrupoNome ?? null,
        marca: r.marca ?? null,
        preco: Number(r.preco) || 0,
        estoque: Number(r.estoque) || 0,
      };
      linhas.push({ l, t: textoDaLinha(l), chave: chaveDaFamilia(l.ref, l.codigo) });
      if (i % 2000 === 1999) await folga();
    }
    this.baseCatalogo = { at: Date.now(), linhas };
    this.logger.log(`[campanha] catálogo com estoque indexado: ${linhas.length} código(s) em ${Date.now() - t0}ms`);
    return linhas;
  }


  /**
   * A campanha que a tela está olhando — a gravada com o RASCUNHO por cima — e
   * tudo que prévia e busca precisam: régua, exceções e catálogo com estoque.
   *
   * `ativa: true` de propósito: a tela mostra o que ENTRARIA — com a campanha
   * desligada a régua responderia "ninguém", e a matriz não teria como conferir
   * os termos antes de ligar.
   */
  private async contexto(rascunho?: Partial<ConfigCampanha> | null) {
    const gravada = (await this.promoConfig.getConfig()).campanha;
    const config = normalizarConfig({ ...gravada, ...(rascunho || {}), ativa: true });
    const chaveCampanha = chaveDaCampanha(config.nome);
    const excecoes = await this.excecoesDe(chaveCampanha);
    const excecaoPorChave = new Map(excecoes.map((e) => [e.chave, e]));
    const linhas = await this.catalogoComEstoque();
    const basicos = config.excluirBasico ? await this.basicos() : null;
    const regra = criarRegra(config, excecoes, this.estruturaDasLinhas(linhas, config), basicos);
    return { config, chaveCampanha, excecoes, excecaoPorChave, linhas, regra };
  }

  /** A decisão de cada linha do catálogo — a busca troca filtro sem decidir tudo de novo. */
  private async decisoesDe(regra: RegraCampanha, linhas: LinhaIndexada[]): Promise<DecisaoCampanha[]> {
    const chave = `${regra.assinatura}|${this.baseCatalogo?.at ?? 0}|${linhas.length}`;
    if (this.memoDecisoes?.chave === chave) return this.memoDecisoes.decisoes;
    const decisoes: DecisaoCampanha[] = new Array(linhas.length);
    for (let i = 0; i < linhas.length; i++) {
      decisoes[i] = regra.decidir(linhas[i].l, linhas[i].t);
      if (i % 4000 === 3999) await folga();
    }
    this.memoDecisoes = { chave, decisoes };
    return decisoes;
  }

  /**
   * O QUE ENTRA — com a campanha gravada ou com um RASCUNHO (termos que a
   * matriz está digitando e ainda não salvou). O rascunho não grava nada: é o
   * "veja antes de ligar" que faz termo largo demais aparecer antes de virar
   * desconto no caixa.
   */
  async preview(rascunho?: Partial<ConfigCampanha> | null): Promise<PreviewCampanha> {
    const { config, chaveCampanha, excecoes, excecaoPorChave, linhas, regra } = await this.contexto(rascunho);

    // 1ª passada: a decisão de cada linha. Uma família vai pra lista se alguma
    // linha dela entrou ou se ela tem exceção.
    const decisoes = await this.decisoesDe(regra, linhas);
    const relevantes = new Set<string>();
    for (const d of decisoes) if (d.entra || d.excecao) relevantes.add(d.chave);

    // 2ª passada: soma as linhas das famílias da lista em DOIS montes — as que
    // entram e todas. A tela mostra o monte que entra (descrição, preço, peças):
    // na família de REF reciclada (bolero + calça sob o mesmo número) quem tem
    // desconto é o bolero, e é ele que a linha da tela tem que descrever.
    type Monte = { descricoes: Map<string, number>; grupo: string | null; precoMin: number; precoMax: number; estoque: number };
    type Acc = {
      chave: string; refs: Set<string>; todas: Monte; dentro: Monte;
      precoPromoMin: number; codigos: number; naCampanha: number; termos: Set<string>; origens: Set<string>;
    };
    const monte = (): Monte => ({ descricoes: new Map(), grupo: null, precoMin: Infinity, precoMax: 0, estoque: 0 });
    const somar = (m: Monte, l: LinhaDoCatalogo) => {
      const desc = String(l.descricao || l.descricaoPdv || '').trim();
      if (desc) m.descricoes.set(desc, (m.descricoes.get(desc) || 0) + l.estoque);
      if (m.grupo == null) m.grupo = l.grupoNome ?? l.grupo ?? null;
      m.estoque += l.estoque;
      if (l.preco > 0) {
        m.precoMin = Math.min(m.precoMin, l.preco);
        m.precoMax = Math.max(m.precoMax, l.preco);
      }
    };
    const familias = new Map<string, Acc>();
    for (let i = 0; i < linhas.length; i++) {
      const { l, chave } = linhas[i];
      if (!relevantes.has(chave)) continue;
      const d = decisoes[i];
      let acc = familias.get(chave);
      if (!acc) {
        acc = {
          chave, refs: new Set(), todas: monte(), dentro: monte(),
          precoPromoMin: Infinity, codigos: 0, naCampanha: 0, termos: new Set(), origens: new Set(),
        };
        familias.set(chave, acc);
      }
      if (l.ref) acc.refs.add(l.ref);
      acc.codigos++;
      somar(acc.todas, l);
      if (d.entra) {
        acc.naCampanha++;
        somar(acc.dentro, l);
        if (d.termo) {
          acc.termos.add(d.termo);
          acc.origens.add(d.termo);
        }
        if (d.estrutura) acc.origens.add(d.estrutura);
        if (l.preco > 0) acc.precoPromoMin = Math.min(acc.precoPromoMin, precoComDesconto(l.preco, config.pct));
      }
    }

    const lista: FamiliaNaCampanha[] = [];
    for (const acc of familias.values()) {
      const exc = excecaoPorChave.get(acc.chave) ?? null;
      const situacao: FamiliaNaCampanha['situacao'] = exc
        ? exc.decisao === 'fora' ? 'tirada' : 'incluida'
        : acc.naCampanha < acc.codigos ? 'parcial' : 'entra';
      // Família com linha dentro mostra o monte que entra; a tirada (ninguém
      // dentro) mostra a família toda. A descrição com mais peça na arara é a
      // que a loja reconhece.
      const m = acc.naCampanha ? acc.dentro : acc.todas;
      const descricao =
        [...m.descricoes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || exc?.descricao || '';
      lista.push({
        chave: acc.chave,
        refs: [...acc.refs].sort(),
        descricao,
        grupo: m.grupo,
        precoMin: Number.isFinite(m.precoMin) ? m.precoMin : 0,
        precoMax: m.precoMax,
        precoPromoMin: Number.isFinite(acc.precoPromoMin) ? acc.precoPromoMin : 0,
        estoque: m.estoque,
        estoqueFamilia: acc.todas.estoque,
        codigos: acc.codigos,
        codigosNaCampanha: acc.naCampanha,
        termos: [...acc.termos],
        origens: [...acc.origens],
        situacao,
        excecao: exc,
      });
    }
    lista.sort((a, b) => b.estoque - a.estoque || a.chave.localeCompare(b.chave));

    const dentro = lista.filter((f) => f.situacao !== 'tirada');
    const sugestoes = await this.sugestoes(config, linhas, relevantes);

    return {
      campanha: config,
      chaveCampanha,
      totais: {
        familias: dentro.length,
        estoque: dentro.reduce((s, f) => s + f.estoque, 0),
        tiradas: lista.filter((f) => f.situacao === 'tirada').length,
        incluidas: lista.filter((f) => f.situacao === 'incluida').length,
        parciais: lista.filter((f) => f.situacao === 'parcial').length,
      },
      familias: lista,
      sugestoes,
      excecoes,
      calculadoEm: new Date().toISOString(),
    };
  }

  /**
   * BUSCAR PRODUTOS — o catálogo com estoque inteiro, DENTRO e FORA da
   * campanha, com os filtros que existem de verdade no cadastro (busca, grupo,
   * subgrupo, marca). É daqui que a matriz escolhe várias peças e inclui ou
   * tira de uma vez.
   *
   * A linha da tela é a FAMÍLIA (a exceção vale pra peça em todas as cores): a
   * família aparece se QUALQUER linha dela passa no filtro, e o resumo conta a
   * família inteira — senão "PRETO" na busca mostraria meia peça e o clique
   * tiraria a peça inteira sem a matriz ver.
   */
  async produtos(
    filtro: FiltroProdutosCampanha = {},
    rascunho?: Partial<ConfigCampanha> | null,
  ): Promise<BuscaProdutosCampanha> {
    const { config, chaveCampanha, excecaoPorChave, linhas, regra } = await this.contexto(rascunho);
    const decisoes = await this.decisoesDe(regra, linhas);

    const palavras = textoNormalizado(filtro.busca).split(' ').filter(Boolean);
    const grupo = numeroOuNull(filtro.grupo);
    const subgrupo = numeroOuNull(filtro.subgrupo);
    const marca = textoNormalizado(filtro.marca);
    const participacao = filtro.participacao === 'dentro' || filtro.participacao === 'fora' ? filtro.participacao : 'todos';

    const passa = (l: LinhaDoCatalogo) => {
      if (grupo != null && l.grupoId !== grupo) return false;
      if (subgrupo != null && l.subgrupoId !== subgrupo) return false;
      if (marca && textoNormalizado(l.marca) !== marca) return false;
      if (palavras.length) {
        const texto = textoNormalizado(
          [l.codigo, l.ref, l.descricao, l.descricaoPdv, l.marca, l.grupoNome, l.subgrupoNome].filter(Boolean).join(' '),
        );
        if (!palavras.every((p) => texto.includes(p))) return false;
      }
      return true;
    };

    const escolhidas = new Set<string>();
    for (let i = 0; i < linhas.length; i++) {
      if (passa(linhas[i].l)) escolhidas.add(linhas[i].chave);
      if (i % 8000 === 7999) await folga();
    }

    type Acc = {
      chave: string; refs: Set<string>; descricoes: Map<string, number>; grupos: Map<string, number>;
      subgrupos: Map<string, number>; marcas: Map<string, number>; tipos: Map<string, number>;
      precoMin: number; precoMax: number; precoPromoMin: number; estoque: number; codigos: number;
      naCampanha: number; origens: Set<string>; exclusoes: Set<string>; basicas: number;
    };
    const somarMapa = (m: Map<string, number>, k: string | null | undefined, n: number) => {
      const chave = String(k ?? '').trim();
      if (chave) m.set(chave, (m.get(chave) || 0) + n);
    };
    const maior = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const familias = new Map<string, Acc>();
    for (let i = 0; i < linhas.length; i++) {
      const { l, chave } = linhas[i];
      if (!escolhidas.has(chave)) continue;
      const d = decisoes[i];
      let acc = familias.get(chave);
      if (!acc) {
        acc = {
          chave, refs: new Set(), descricoes: new Map(), grupos: new Map(), subgrupos: new Map(), marcas: new Map(),
          tipos: new Map(), precoMin: Infinity, precoMax: 0, precoPromoMin: Infinity, estoque: 0, codigos: 0,
          naCampanha: 0, origens: new Set(), exclusoes: new Set(), basicas: 0,
        };
        familias.set(chave, acc);
      }
      if (l.ref) acc.refs.add(l.ref);
      acc.codigos++;
      acc.estoque += l.estoque;
      somarMapa(acc.descricoes, l.descricao || l.descricaoPdv, l.estoque);
      somarMapa(acc.tipos, familiaDaDescricao(l.descricao || l.descricaoPdv).toUpperCase(), Math.max(1, l.estoque));
      somarMapa(acc.grupos, l.grupoNome, l.estoque);
      somarMapa(acc.subgrupos, l.subgrupoNome, l.estoque);
      somarMapa(acc.marcas, l.marca, l.estoque);
      if (l.preco > 0) {
        acc.precoMin = Math.min(acc.precoMin, l.preco);
        acc.precoMax = Math.max(acc.precoMax, l.preco);
      }
      if (d.entra) {
        acc.naCampanha++;
        if (d.termo) acc.origens.add(d.termo);
        if (d.estrutura) acc.origens.add(d.estrutura);
        if (l.preco > 0) acc.precoPromoMin = Math.min(acc.precoPromoMin, precoComDesconto(l.preco, config.pct));
      } else if (d.exclusao) {
        acc.exclusoes.add(d.exclusao);
      } else if (d.criterio === 'basico') {
        acc.basicas++;
      }
    }

    const todos: ProdutoNaBusca[] = [];
    let dentro = 0;
    for (const acc of familias.values()) {
      const exc = excecaoPorChave.get(acc.chave) ?? null;
      const situacao: ProdutoNaBusca['situacao'] = exc
        ? exc.decisao === 'fora' ? 'tirada' : 'incluida'
        : acc.naCampanha === 0
          ? acc.exclusoes.size ? 'excluida' : acc.basicas ? 'basico' : 'fora'
          : acc.naCampanha < acc.codigos ? 'parcial' : 'entra';
      if (acc.naCampanha > 0) dentro++;
      if (participacao === 'dentro' && acc.naCampanha === 0) continue;
      if (participacao === 'fora' && acc.naCampanha > 0) continue;
      todos.push({
        chave: acc.chave,
        refs: [...acc.refs].sort(),
        descricao: maior(acc.descricoes) || exc?.descricao || '',
        grupo: maior(acc.grupos),
        subgrupo: maior(acc.subgrupos),
        marca: maior(acc.marcas),
        precoMin: Number.isFinite(acc.precoMin) ? acc.precoMin : 0,
        precoMax: acc.precoMax,
        precoPromoMin: Number.isFinite(acc.precoPromoMin) ? acc.precoPromoMin : 0,
        estoque: acc.estoque,
        codigos: acc.codigos,
        codigosNaCampanha: acc.naCampanha,
        situacao,
        origens: [...acc.origens],
        exclusoes: [...acc.exclusoes],
        tipos: [...acc.tipos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t),
        excecao: exc,
      });
    }
    todos.sort((a, b) => b.estoque - a.estoque || a.chave.localeCompare(b.chave));

    const porPagina = Math.min(200, Math.max(1, Math.floor(Number(filtro.porPagina) || 50)));
    const pagina = Math.max(1, Math.floor(Number(filtro.pagina) || 1));
    return {
      campanha: config,
      chaveCampanha,
      total: todos.length,
      totais: { dentro, fora: familias.size - dentro },
      pagina,
      porPagina,
      produtos: todos.slice((pagina - 1) * porPagina, pagina * porPagina),
    };
  }

  /**
   * Grupos, subgrupos e marcas QUE TÊM PEÇA NA REDE — as opções dos filtros e da
   * escolha de grupo/subgrupo da campanha. Nome de grupo sem estoque não
   * aparece: escolher o que não vende só confunde a conta da prévia.
   */
  async estrutura(): Promise<EstruturaDoCatalogo> {
    const linhas = await this.catalogoComEstoque();
    const grupos = new Map<number, { codigo: number; nome: string; codigos: number; pecas: number }>();
    const subgrupos = new Map<number, EstruturaDoCatalogo['subgrupos'][number]>();
    const marcas = new Map<string, number>();
    let pecasTotal = 0;
    let pecasSemGrupo = 0;
    for (const { l } of linhas) {
      pecasTotal += l.estoque;
      if (l.marca) marcas.set(l.marca, (marcas.get(l.marca) || 0) + l.estoque);
      if (l.grupoId == null && l.subgrupoId == null) {
        pecasSemGrupo += l.estoque;
        continue;
      }
      if (l.grupoId != null) {
        const g = grupos.get(l.grupoId) ?? { codigo: l.grupoId, nome: l.grupoNome || `Grupo ${l.grupoId}`, codigos: 0, pecas: 0 };
        g.codigos++;
        g.pecas += l.estoque;
        grupos.set(l.grupoId, g);
      }
      if (l.subgrupoId != null) {
        const s = subgrupos.get(l.subgrupoId) ?? {
          codigo: l.subgrupoId, nome: l.subgrupoNome || `Subgrupo ${l.subgrupoId}`,
          grupo: l.grupoId, grupoNome: l.grupoNome, codigos: 0, pecas: 0,
        };
        s.codigos++;
        s.pecas += l.estoque;
        subgrupos.set(l.subgrupoId, s);
      }
    }
    const porNome = (a: { nome: string }, b: { nome: string }) => a.nome.localeCompare(b.nome, 'pt-BR');
    return {
      grupos: [...grupos.values()].sort(porNome),
      subgrupos: [...subgrupos.values()].sort(
        (a, b) => String(a.grupoNome || '').localeCompare(String(b.grupoNome || ''), 'pt-BR') || porNome(a, b),
      ),
      marcas: [...marcas.entries()].map(([nome, pecas]) => ({ nome, pecas })).sort((a, b) => b.pecas - a.pecas),
      pecasTotal,
      pecasSemGrupo,
    };
  }

  /**
   * INCLUIR / TIRAR / DEVOLVER VÁRIAS FAMÍLIAS DE UMA VEZ (a seleção da busca).
   *
   * Grava a MESMA exceção por família que o "tirar" de uma peça grava — nada de
   * lista paralela: a régua, o site e o caixa leem a mesma tabela. Família que
   * não está no catálogo com estoque é IGNORADA (e volta na resposta): exceção
   * sem peça por trás é fantasma que ninguém consegue conferir.
   */
  async excecoesEmLote(input: {
    chaves: string[];
    decisao: DecisaoExcecao | 'remover';
    motivo?: string | null;
    usuario?: string | null;
    storeCode?: string | null;
  }): Promise<{ ok: true; campanha: string; alteradas: number; ignoradas: string[] }> {
    const decisao = input.decisao;
    if (decisao !== 'fora' && decisao !== 'dentro' && decisao !== 'remover') {
      throw new BadRequestException('decisao tem que ser "fora", "dentro" ou "remover"');
    }
    const chaves = Array.from(
      new Set((Array.isArray(input.chaves) ? input.chaves : []).map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean)),
    );
    if (!chaves.length) throw new BadRequestException('Selecione pelo menos uma peça.');
    if (chaves.length > 500) throw new BadRequestException('No máximo 500 peças por vez.');

    const { campanha: cfg } = await this.promoConfig.getConfig();
    const campanha = chaveDaCampanha(cfg.nome);
    const motivo = String(input.motivo ?? '').trim().slice(0, 300) || null;
    const usuario = input.usuario ? String(input.usuario).slice(0, 120) : null;
    const storeCode = input.storeCode ? String(input.storeCode).slice(0, 10) : null;

    let alteradas = 0;
    let ignoradas: string[] = [];
    if (decisao === 'remover') {
      const r = await (this.prisma as any).promoCampanhaExcecao.deleteMany({
        where: { campanha, chave: { in: chaves } },
      });
      alteradas = Number(r?.count) || 0;
    } else {
      // A descrição e uma REF de exemplo vêm do catálogo — a lista da tela
      // explica a linha mesmo depois que o cadastro mudar.
      const linhas = await this.catalogoComEstoque();
      const amostra = new Map<string, { ref: string | null; descricao: string | null; estoque: number }>();
      const pedidas = new Set(chaves);
      for (const { l, chave } of linhas) {
        if (!pedidas.has(chave)) continue;
        const atual = amostra.get(chave);
        if (!atual || l.estoque > atual.estoque) {
          amostra.set(chave, { ref: l.ref || `#${l.codigo}`, descricao: l.descricao || l.descricaoPdv || null, estoque: l.estoque });
        }
      }
      ignoradas = chaves.filter((c) => !amostra.has(c));
      const validas = chaves.filter((c) => amostra.has(c));
      if (validas.length) {
        await (this.prisma as any).$transaction(
          validas.map((chave) => {
            const a = amostra.get(chave)!;
            const dados = {
              decisao,
              motivo,
              origem: 'retaguarda',
              storeCode,
              usuario,
              refExemplo: a.ref ? a.ref.slice(0, 40) : null,
              descricao: a.descricao ? String(a.descricao).trim().slice(0, 120) : null,
            };
            return (this.prisma as any).promoCampanhaExcecao.upsert({
              where: { campanha_chave: { campanha, chave } },
              create: { campanha, chave, ...dados },
              update: dados,
            });
          }),
        );
      }
      alteradas = validas.length;
    }

    this.invalidar();
    await this.registrar('promo-campanha.excecao-lote', {
      campanha, decisao, alteradas, ignoradas: ignoradas.slice(0, 50),
      chaves: chaves.slice(0, 200), motivo, usuario, storeCode, origem: 'retaguarda',
    });
    this.logger.log(
      `[campanha] lote "${decisao}" em ${alteradas} família(s) da campanha "${cfg.nome}" · por ${usuario || '?'}` +
        (ignoradas.length ? ` · ${ignoradas.length} ignorada(s) sem estoque` : ''),
    );
    return { ok: true, campanha, alteradas, ignoradas };
  }

  /**
   * Palavra do dicionário que existe no catálogo e traria modelo NOVO pra
   * campanha. Nunca entra sozinha: termo é dinheiro — a tela só mostra "se
   * incluir TRICÔ, entram mais 58 modelos (412 peças)".
   *
   * `jaNaLista` = famílias que já entram OU que têm exceção — a tirada na mão
   * não volta por sugestão. A peça que uma palavra de exclusão tira também não
   * conta: ela não entraria nem com o termo novo.
   */
  private async sugestoes(config: ConfigCampanha, linhas: LinhaIndexada[], jaNaLista: Set<string>) {
    const atuais = new Set(config.termos.map(formaDoTermo));
    const exclusoes = config.termosExclusao
      .map((t) => compilarTermo(t))
      .filter((t): t is NonNullable<ReturnType<typeof compilarTermo>> => !!t);
    const out: PreviewCampanha['sugestoes'] = [];
    for (const sug of sugestoesPara(config.nome)) {
      const comp = compilarTermo(sug);
      if (!comp || atuais.has(formaDoTermo(sug))) continue;
      const novas = new Map<string, number>();
      const exemplos: string[] = [];
      for (const { l, t, chave } of linhas) {
        if (jaNaLista.has(chave) || !termoCasa(comp, t)) continue;
        if (exclusoes.some((e) => termoCasa(e, t))) continue;
        if (!novas.has(chave) && exemplos.length < 3) {
          exemplos.push(String(l.descricao || l.descricaoPdv || chave).trim());
        }
        novas.set(chave, (novas.get(chave) || 0) + l.estoque);
      }
      if (novas.size) {
        out.push({
          termo: sug,
          familias: novas.size,
          estoque: [...novas.values()].reduce((s, n) => s + n, 0),
          exemplos,
        });
      }
      await folga();
    }
    return out.sort((a, b) => b.estoque - a.estoque).slice(0, 30);
  }
}
