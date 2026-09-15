import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromoConfigService } from './promo-config.service';
import {
  ConfigCampanha,
  DecisaoCampanha,
  DecisaoExcecao,
  ExcecaoCampanha,
  LinhaCampanha,
  RegraCampanha,
  TextoIndexado,
  chaveDaCampanha,
  chaveDaFamilia,
  compilarTermo,
  criarRegra,
  normalizarConfig,
  precoComDesconto,
  sugestoesPara,
  termoCasa,
  textoDaLinha,
} from '../common/promo-por-termo';

/** Linha do catálogo com o que a campanha lê e o que a tela mostra. */
export interface LinhaCatalogoCampanha extends LinhaCampanha {
  codigo: string;
  ref: string | null;
  preco: number;
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

type LinhaIndexada = { l: LinhaCatalogoCampanha & { estoque: number }; t: TextoIndexado; chave: string };

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
   * Catálogo COM ESTOQUE NA REDE, indexado uma vez e guardado 2 min: a matriz
   * digita um termo e confere o efeito na hora, várias vezes seguidas — sem
   * este cache seria uma varredura do espelho inteiro por tecla.
   */
  private baseCatalogo: { at: number; linhas: LinhaIndexada[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly promoConfig: PromoConfigService,
  ) {}

  /** Derruba a régua em memória — toda gravação chama. */
  invalidar() {
    this.cache = null;
    this.promoConfig.clearCache();
  }

  async regra(): Promise<RegraCampanha> {
    if (this.cache && Date.now() - this.cache.at < PromoCampanhaService.TTL) return this.cache.regra;
    if (this.emVoo) return this.emVoo;
    this.emVoo = (async () => {
      try {
        this.promoConfig.clearCache();
        const { campanha } = await this.promoConfig.getConfig();
        const excecoes = await this.excecoesDe(chaveDaCampanha(campanha.nome));
        const regra = criarRegra(campanha, excecoes);
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
      const linha = (await this.linhasPorCodigo([codigo])).get(codigo);
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
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT p.codigo,
              NULLIF(UPPER(TRIM(p.ref)), '') AS ref,
              p."descricaoCompleta" AS descricao,
              p."descricaoPdv"      AS "descricaoPdv",
              p."nomeGrupo"         AS grupo,
              COALESCE(p."vendaUn", 0)::float8 AS preco,
              e.total::int AS estoque
         FROM wincred_produtos p
         JOIN (
           SELECT codigo, SUM(GREATEST(COALESCE(estoque, 0), 0)) AS total
             FROM wincred_estoque
            GROUP BY codigo
           HAVING SUM(GREATEST(COALESCE(estoque, 0), 0)) > 0
         ) e ON e.codigo = p.codigo`,
    );
    const linhas: LinhaIndexada[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const l = {
        codigo: String(r.codigo),
        ref: r.ref ?? null,
        descricao: r.descricao ?? null,
        descricaoPdv: r.descricaoPdv ?? null,
        grupo: r.grupo ?? null,
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
   * O QUE ENTRA — com a campanha gravada ou com um RASCUNHO (termos que a
   * matriz está digitando e ainda não salvou). O rascunho não grava nada: é o
   * "veja antes de ligar" que faz termo largo demais aparecer antes de virar
   * desconto no caixa.
   */
  async preview(rascunho?: Partial<ConfigCampanha> | null): Promise<PreviewCampanha> {
    const gravada = (await this.promoConfig.getConfig()).campanha;
    // `ativa: true` de propósito: a tela mostra o que ENTRARIA — com a campanha
    // desligada a régua responderia "ninguém", e a matriz não teria como
    // conferir os termos antes de ligar.
    const config = normalizarConfig({ ...gravada, ...(rascunho || {}), ativa: true });
    const chaveCampanha = chaveDaCampanha(config.nome);
    const excecoes = await this.excecoesDe(chaveCampanha);
    const excecaoPorChave = new Map(excecoes.map((e) => [e.chave, e]));
    const regra = criarRegra(config, excecoes);
    const linhas = await this.catalogoComEstoque();

    // 1ª passada: a decisão de cada linha. Uma família vai pra lista se alguma
    // linha dela entrou ou se ela tem exceção.
    const decisoes: DecisaoCampanha[] = new Array(linhas.length);
    const relevantes = new Set<string>();
    for (let i = 0; i < linhas.length; i++) {
      const d = regra.decidir(linhas[i].l, linhas[i].t);
      decisoes[i] = d;
      if (d.entra || d.excecao) relevantes.add(d.chave);
      if (i % 4000 === 3999) await folga();
    }

    // 2ª passada: soma as linhas das famílias da lista em DOIS montes — as que
    // entram e todas. A tela mostra o monte que entra (descrição, preço, peças):
    // na família de REF reciclada (bolero + calça sob o mesmo número) quem tem
    // desconto é o bolero, e é ele que a linha da tela tem que descrever.
    type Monte = { descricoes: Map<string, number>; grupo: string | null; precoMin: number; precoMax: number; estoque: number };
    type Acc = {
      chave: string; refs: Set<string>; todas: Monte; dentro: Monte;
      precoPromoMin: number; codigos: number; naCampanha: number; termos: Set<string>;
    };
    const monte = (): Monte => ({ descricoes: new Map(), grupo: null, precoMin: Infinity, precoMax: 0, estoque: 0 });
    const somar = (m: Monte, l: LinhaIndexada['l']) => {
      const desc = String(l.descricao || l.descricaoPdv || '').trim();
      if (desc) m.descricoes.set(desc, (m.descricoes.get(desc) || 0) + l.estoque);
      if (m.grupo == null) m.grupo = l.grupo ?? null;
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
          precoPromoMin: Infinity, codigos: 0, naCampanha: 0, termos: new Set(),
        };
        familias.set(chave, acc);
      }
      if (l.ref) acc.refs.add(l.ref);
      acc.codigos++;
      somar(acc.todas, l);
      if (d.entra) {
        acc.naCampanha++;
        somar(acc.dentro, l);
        if (d.termo) acc.termos.add(d.termo);
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
   * Palavra do dicionário que existe no catálogo e traria modelo NOVO pra
   * campanha. Nunca entra sozinha: termo é dinheiro — a tela só mostra "se
   * incluir TRICÔ, entram mais 58 modelos (412 peças)".
   *
   * `jaNaLista` = famílias que já entram OU que têm exceção — a tirada na mão
   * não volta por sugestão.
   */
  private async sugestoes(config: ConfigCampanha, linhas: LinhaIndexada[], jaNaLista: Set<string>) {
    const formaDoTermo = (t: string) =>
      compilarTermo(t)?.palavras.map((p) => `${p.raiz}${p.prefixo ? '*' : ''}`).join(' ') ?? '';
    const atuais = new Set(config.termos.map(formaDoTermo));
    const out: PreviewCampanha['sugestoes'] = [];
    for (const sug of sugestoesPara(config.nome)) {
      const comp = compilarTermo(sug);
      if (!comp || atuais.has(formaDoTermo(sug))) continue;
      const novas = new Map<string, number>();
      const exemplos: string[] = [];
      for (const { l, t, chave } of linhas) {
        if (jaNaLista.has(chave) || !termoCasa(comp, t)) continue;
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
