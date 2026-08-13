import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ProductPhotosService } from './product-photos.service';
import { WpDbService } from '../wp-db/wp-db.service';
import { CorIaService } from './cor-ia.service';
import { refBaseOf } from '../common/ref-base';

/**
 * IMPORTAR AS FOTOS DO SITE ANTIGO — WooCommerce → R2, por REF e COR.
 *
 * O acervo já existe: no WooCommerce cada COR é um produto separado, todos com
 * o MESMO SKU (a REF). O sync de conteúdo tratava isso como "REF duplicada" e
 * descartava — o que se perdia ali era justamente a foto de cada cor.
 *
 * COMO CASA A COR: o WC não tem campo de cor confiável, mas o NOME do produto
 * carrega ("... REF CHIC GOIABA"). E nós já sabemos, pelo ERP, quais cores
 * aquela REF tem de verdade. Então o casamento é contra essa lista fechada, com
 * o nome MAIS LONGO ganhando: senão "ROSA QUEIMADO" seria casado como "ROSA" e
 * duas cores diferentes receberiam a mesma foto.
 *
 * O que NÃO casar é reportado, nunca chutado. Foto errada na cor é troca
 * garantida — e a cliente perde a confiança na peça inteira, não só na cor.
 *
 * Idempotente: cor que já tem foto é pulada, então dá pra rodar quantas vezes
 * quiser sem duplicar acervo nem gastar upload à toa.
 */

export interface ResultadoRef {
  ref: string;
  coresComFoto: string[];
  coresSemFoto: string[];
  jaTinham: string[];
  produtosWcSemCor: string[];
  /** Quantos produtos o site antigo devolveu pra esta REF. Zero = o acervo
   *  la nao tem a peca; nao adianta procurar casamento de cor. */
  produtosEncontrados: number;
  fotos: number;
  /** Frase pronta explicando por que não veio nada. Só quando não veio. */
  motivo?: string;
}

@Injectable()
export class WcFotosImportService {
  private readonly logger = new Logger(WcFotosImportService.name);
  private static readonly MAX_POR_COR = 6;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly fotos: ProductPhotosService,
    private readonly wp: WpDbService,
    private readonly corIa: CorIaService,
  ) {}

  private get baseUrl() {
    return `${(this.config.get<string>('WC_URL') ?? '').replace(/\/$/, '')}/wp-json/wc/v3`;
  }

  private get auth() {
    return {
      username: this.config.get<string>('WC_CONSUMER_KEY') ?? '',
      password: this.config.get<string>('WC_CONSUMER_SECRET') ?? '',
    };
  }

  private semAcento(v: string) {
    return String(v || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase();
  }

  /**
   * Cores que a FAMÍLIA tem no catálogo — a lista fechada do casamento.
   *
   * Varre a família inteira, não a REF exata. "VMS-223 MA" sozinha tem UMA cor
   * (marinho) e a importação achava só a foto dela; a família "VMS-223" tem
   * blush + marinho + marrom + preto, que é o produto de verdade.
   *
   * O `LIKE base%` é peneira grossa de propósito (traz "VMS-2231" também) — o
   * filtro fino é o `refBaseOf` no JS, que é a MESMA regra do resto do sistema.
   * Repetir a regra em SQL seria a segunda cópia dela.
   */
  private async coresDaRef(ref: string): Promise<string[]> {
    const base = refBaseOf(ref);
    const linhas = await this.prisma.$queryRawUnsafe<Array<{ ref: string; cor: string }>>(
      `SELECT DISTINCT UPPER(TRIM(ref)) AS ref, NULLIF(TRIM(cor), '') AS cor
         FROM wincred_produtos
        WHERE (UPPER(TRIM(ref)) = $1 OR UPPER(TRIM(ref)) LIKE $1 || '%')
          AND cor IS NOT NULL AND TRIM(cor) <> ''`,
      base,
    );
    const cores = linhas
      .filter((l) => refBaseOf(l.ref) === base)
      .map((l) => String(l.cor || '').toUpperCase())
      .filter(Boolean);
    return Array.from(new Set(cores));
  }

  /**
   * MARCA da família — a outra metade da chave da ficha (REF-BASE + MARCA).
   *
   * Procura na família, não na REF exata: existe família cujo cadastro base
   * NÃO existe (só "VLM-222P" e "VLM-222M", nunca um "VLM-222" pelado). Com
   * igualdade exata a marca vinha vazia, a função saía calada e a peça ficava
   * com foto e bolinha cinza — sem erro nenhum no log pra explicar.
   *
   * ⚠️ PRECISA SER DETERMINÍSTICA (06/08). REF é reciclada entre fornecedores
   * ([[giga-ref-reciclada]]), então a mesma família pode ter DUAS marcas. Aqui
   * escolhia-se `[0]` de um `SELECT DISTINCT` sem `ORDER BY` — ou seja, o
   * Postgres devolvia a ordem que quisesse.
   *
   * O estrago: quem GRAVA a bolinha usa esta função, e quem LÊ (o catálogo,
   * em `escolherFicha`) escolhe a marca por outro caminho, também sem ordem.
   * Os dois sorteavam separado. Quando davam marcas diferentes, a bolinha era
   * pintada numa ficha que o site nunca abre — e a varredura automática, que
   * não olha marca, dava a peça como PINTADA e parava de tentar. Resultado
   * exato do relato: "a varredura roda, o log diz que pintou, e a bolinha não
   * aparece".
   *
   * Regra: vale a marca com MAIS cadastros na família; empate, a menor em
   * ordem alfabética. Qualquer regra serve desde que os dois lados usem a
   * mesma — o que não pode é sortear.
   */
  async marcaDaFamilia(ref: string): Promise<string | null> {
    const base = refBaseOf(ref);
    const linhas = await this.prisma.$queryRawUnsafe<Array<{ ref: string; marca: string; qtd: number }>>(
      `SELECT UPPER(TRIM(ref)) AS ref, UPPER(TRIM(marca)) AS marca, COUNT(*)::int AS qtd
         FROM wincred_produtos
        WHERE (UPPER(TRIM(ref)) = $1 OR UPPER(TRIM(ref)) LIKE $1 || '%')
          AND marca IS NOT NULL AND TRIM(marca) <> ''
        GROUP BY 1, 2
        ORDER BY qtd DESC, marca ASC
        LIMIT 50`,
      base,
    );

    const porMarca = new Map<string, number>();
    for (const l of linhas) {
      if (refBaseOf(l.ref) !== base) continue;
      porMarca.set(l.marca, (porMarca.get(l.marca) || 0) + Number(l.qtd || 0));
    }
    if (!porMarca.size) return null;

    const vencedora = Array.from(porMarca.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0][0];

    if (porMarca.size > 1) {
      this.logger.warn(
        `[wc-fotos] REF ${base} tem ${porMarca.size} marcas (${Array.from(porMarca.keys()).join(', ')}) — ` +
          `ficha vai pra "${vencedora}". Vale conferir o cadastro: REF reciclada entre fornecedores.`,
      );
    }
    return vencedora;
  }

  /**
   * TODAS as REFs que o site antigo tem — a fila do "importar tudo" INVERTIDA.
   *
   * Pedido do dono (06/08): a fila varria as ~21 mil REFs do catálogo
   * perguntando ao WordPress uma a uma, e 90%+ voltava "site antigo não tem
   * esta peça" — o acervo de lá não chega a 10% do catálogo. Aqui é o
   * contrário: UMA query lista os produtos do WordPress e a REF sai de cada
   * um (SKU "VLM-222 MARROM" → primeira palavra; nome "… Ref VOGUE …" quando
   * o SKU está vazio).
   *
   * Lança erro com o MySQL do WP fora: fila vazia por indisponibilidade
   * PARECERIA "site antigo sem nada" — melhor parar com mensagem clara.
   */
  /**
   * As REFs que estão NO AR no site antigo (`post_status = 'publish'`).
   *
   * Critério do dono (07/08) pra decidir o que entra na vitrine nova:
   * "publica todos que estão ativos no site WooCommerce". Rascunho e privado
   * ficam de fora — são peças que ELE escolheu não mostrar, e a escolha
   * atravessa a migração.
   */
  async refsAtivasNoSiteAntigo(): Promise<string[]> {
    return this.refsDoSiteAntigo(true);
  }

  async refsDoSiteAntigo(somenteAtivas = false): Promise<string[]> {
    const produtos = await this.produtosDoSiteAntigo(somenteAtivas);
    if (!produtos.length) {
      throw new BadRequestException(
        'Não consegui listar o site antigo (MySQL e REST do WordPress sem resposta) — tente de novo mais tarde.',
      );
    }
    const refs = new Set<string>();
    for (const p of produtos) {
      const sku = this.semAcento(p.sku).trim();
      const doSku = sku.split(/\s+/)[0] || '';
      if (doSku) {
        refs.add(doSku);
        continue;
      }
      // Sem SKU: a REF mora no nome ("Blusa … Ref Vogue Preto LENE").
      const m = this.semAcento(p.nome).match(/\bREF\.?\s+([A-Z0-9][A-Z0-9./-]*)/);
      if (m?.[1]) refs.add(m[1]);
    }
    return Array.from(refs);
  }

  /**
   * SKU+nome de todos os produtos do site antigo — MySQL primeiro, REST atrás.
   *
   * A mesma lição do `acharNoWc`: o MySQL do WordPress mora atrás de firewall
   * por IP e o IP do Railway muda — quando cai, o erro cru virava 500 na cara
   * do dono (aconteceu no primeiro clique do "importar tudo" invertido,
   * 06/08). A REST é mais lenta (paginada), mas roda UMA vez por lote.
   */
  private async produtosDoSiteAntigo(
    somenteAtivas = false,
  ): Promise<Array<{ sku: string; nome: string }>> {
    try {
      const doMysql = somenteAtivas
        ? await this.wp.listarSkusPublicados()
        : await this.wp.listarTodosSkus();
      if (doMysql.length) return doMysql;
      this.logger.warn('[wc-fotos] MySQL do WP vazio ou inativo — listando pela REST');
    } catch (e: any) {
      this.logger.warn(`[wc-fotos] MySQL do WP falhou (${e?.message || e}) — listando pela REST`);
    }

    const todos: Array<{ sku: string; nome: string }> = [];
    try {
      // Teto de 100 páginas (10 mil produtos) — o acervo real é bem menor;
      // é só pra um loop nunca ficar preso numa API que pagina errado.
      for (let page = 1; page <= 100; page++) {
        const res = await firstValueFrom(
          this.http.get(`${this.baseUrl}/products`, {
            auth: this.auth,
            params: {
              per_page: 100, page,
              status: somenteAtivas ? 'publish' : 'any',
              _fields: 'id,name,sku,status',
            },
            timeout: 30000,
          }),
        );
        const lote = Array.isArray(res.data) ? res.data : [];
        for (const p of lote) {
          todos.push({ sku: String((p as any)?.sku || ''), nome: String((p as any)?.name || '') });
        }
        if (lote.length < 100) break;
      }
    } catch (e: any) {
      // Página que falhou no meio: segue com o que já veio — melhor fila
      // parcial que 500. Vazio total vira o BadRequest de quem chama.
      this.logger.warn(`[wc-fotos] REST parou na listagem (${e?.message || e}) — ${todos.length} produto(s) até aqui`);
    }
    return todos;
  }

  /**
   * O ERP ABREVIA, O SITE ANTIGO ESCREVE POR EXTENSO (13/08/2026).
   *
   * A cor do ERP tinha de aparecer LETRA POR LETRA no título do WooCommerce.
   * Só que quem cadastra no ERP tem campo curto e abrevia: "EST MOSTARDA" no
   * ERP é "Estampa Mostarda" no site; "OFF WHITE" é "Off-White". A cor existia
   * dos dois lados, com foto lá, e o importador dizia "cor não casou" — e o
   * dono rodava a importação de novo, várias vezes, sem nada mudar.
   *
   * Medido em 13/08 nas 322 cores sem foto do catálogo: **102 têm nome
   * composto ou abreviado** (OFF WHITE 11×, EST VERDE, EST BEGE, EST LARANJA,
   * ESTAMPA PRETO, PRETO DOURADO…). Essas falhavam por construção.
   *
   * Aqui as duas pontas passam pela MESMA normalização antes de comparar:
   * abreviação vira palavra inteira e hífen vira espaço. "EST MOSTARDA" e
   * "Estampa Mostarda" viram a mesma coisa; "OFF WHITE" e "Off-White" também.
   */
  private static readonly ABREVIACOES: Array<[RegExp, string]> = [
    [/\bEST\b/g, 'ESTAMPA'],
    [/\bESTAMP\b/g, 'ESTAMPA'],
    [/\bESTP\b/g, 'ESTAMPA'],
    [/\bMESC\b/g, 'MESCLA'],
    [/\bVD\b/g, 'VERDE'],
    [/\bVERM\b/g, 'VERMELHO'],
    [/\bAM\b/g, 'AMARELO'],
    [/\bMAR\b/g, 'MARINHO'],
    [/\bCLA?\b/g, 'CLARO'],
    [/\bESC\b/g, 'ESCURO'],
    [/\bDOUR\b/g, 'DOURADO'],
  ];

  /** Mesma régua pros dois lados — comparar cru foi o que criou o problema. */
  private normalizarCor(v: string): string {
    let s = this.semAcento(v)
      // Hífen/barra/ponto viram espaço: "Off-White" = "OFF WHITE".
      .replace(/[-_/.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    for (const [de, para] of WcFotosImportService.ABREVIACOES) s = s.replace(de, para);
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * Qual cor da lista aparece no nome do produto do WC. Mais longa primeiro —
   * "ROSA QUEIMADO" tem que ganhar de "ROSA".
   */
  private casarCor(nomeWc: string, cores: string[]): string | null {
    const nome = this.normalizarCor(nomeWc);
    // Ordena pela cor JÁ NORMALIZADA: "EST BEGE" (8) vira "ESTAMPA BEGE" (12)
    // e só assim ganha de "BEGE" — ordenar pelo nome cru deixava a cor curta
    // casar primeiro e roubar a foto da estampa.
    const candidatas = [...cores]
      .map((cor) => ({ cor, alvo: this.normalizarCor(cor) }))
      .filter((c) => c.alvo)
      .sort((a, b) => b.alvo.length - a.alvo.length);
    for (const { cor, alvo } of candidatas) {
      // Fronteira de palavra pra "UVA" não casar dentro de "LUVA".
      if (new RegExp(`(^|[^A-Z0-9])${alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`).test(nome)) {
        return cor;
      }
    }
    return null;
  }

  /**
   * Acha no WooCommerce os produtos daquela REF.
   *
   * MEDIDO EM PRODUÇÃO (03/08): buscar por `sku=REF` devolve ZERO. O SKU do
   * site antigo não é a REF — quem carrega a REF é o NOME ("… Ref VLM-222
   * Marrom"), que é como o próprio site busca. Por isso a ordem:
   *
   *   1. sku exato      — respeita o cadastro quando ele está certo;
   *   2. busca textual  — o caso real;
   *   3. busca pela BASE da REF ("VLM-222EST" → "VLM-222") — as estampas
   *      viraram REF própria no ERP, mas no site continuam com o nome da REF
   *      original.
   *
   * O filtro por nome/SKU depois é o que impede a busca textual de trazer
   * peça de outra REF: sem ele, "222" casaria com meio catálogo.
   */
  private async acharNoWc(ref: string): Promise<any[]> {
    /**
     * FONTE PRINCIPAL: o MySQL do WordPress, o MESMO caminho que o PDV usa
     * pra mostrar foto há meses.
     *
     * Pergunta do dono que resolveu o impasse: "no PDV a foto aparece, qual a
     * dificuldade?". Nenhuma — eu é que tinha escolhido a fonte errada. Lá o
     * casamento é `SKU LIKE 'REF%'`, e o SKU do WordPress é "VLM-222 MARROM";
     * a REST do WooCommerce exige SKU exato e por isso devolvia UM produto.
     */
    const base = ref.replace(/[A-Z]+$/i, '').replace(/[-_\s]+$/, '');

    /**
     * O FILTRO VALE PROS DOIS CAMINHOS (corrigido 06/08).
     *
     * `combina` era aplicado só no caminho REST. O MySQL casa por
     * `SKU LIKE 'REF%'`, que é peneira grossa de propósito — pedindo "VMS-223"
     * ele traz "VMS-2231" junto. Sem o filtro, as fotos de OUTRA peça entravam
     * como se fossem desta, e o casamento de cor depois ainda encontrava um
     * nome de cor válido: foto errada, na cor certa, sem erro nenhum.
     */
    const combina = (p: any) => {
      const sku = String(p?.sku || '').trim().toUpperCase().replace(/\s+/g, '');
      if (sku === ref) return true;
      const nome = this.semAcento(String(p?.name || ''));
      const alvo = this.semAcento(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const alvoBase = this.semAcento(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // O SKU do WordPress é "REF COR" — casa pelo começo, com fronteira.
      const skuCasa = new RegExp(`^${alvo}([^A-Z0-9]|$)`).test(this.semAcento(String(p?.sku || '')));
      return (
        skuCasa ||
        new RegExp(`(^|[^A-Z0-9])${alvo}([^A-Z0-9]|$)`).test(nome) ||
        (!!alvoBase && new RegExp(`(^|[^A-Z0-9])${alvoBase}([^A-Z0-9]|$)`).test(nome))
      );
    };

    try {
      const doWp = await this.wp.getProdutosPorRef(ref);
      if (doWp.length) {
        // Formato do WooCommerce REST pro resto do fluxo não mudar.
        const convertidos = doWp.map((p) => ({
          id: p.id,
          name: p.nome,
          sku: p.sku,
          status: p.status,
          images: p.imagens.map((src) => ({ src })),
        }));
        const daRef = convertidos.filter(combina);
        if (daRef.length) {
          this.logger.log(
            `[wc-fotos] ${ref}: ${daRef.length} produto(s) pelo MySQL do WordPress` +
              (daRef.length < convertidos.length
                ? ` (${convertidos.length - daRef.length} de outra REF, descartado[s])`
                : ''),
          );
          const semFoto = daRef.filter((p) => !p.images.length).length;
          if (semFoto === daRef.length) {
            // Todos vieram sem imagem: quase sempre é a URL do site vazia no
            // WordPress (o `siteUrl` prefixa toda foto). Sem este aviso, a tela
            // só diz "nenhuma cor com foto".
            this.logger.warn(
              `[wc-fotos] ${ref}: os ${daRef.length} produto(s) do WordPress vieram SEM imagem — ` +
                `confira a opção "siteurl" no WordPress e as linhas _wp_attached_file`,
            );
          }
          return daRef;
        }
        this.logger.warn(
          `[wc-fotos] ${ref}: MySQL trouxe ${convertidos.length} produto(s), nenhum desta REF — ` +
            `tentando a REST`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[wc-fotos] MySQL do WordPress indisponível: ${e?.message || e}`);
    }

    const tentativas: Array<Record<string, unknown>> = [
      { sku: ref },
      { search: ref },
      ...(base && base !== ref ? [{ search: base }] : []),
    ];

    /**
     * ⚠️ RODA AS TRÊS E SOMA — não para na primeira que responde.
     *
     * Medido no raio-X (03/08): `sku=VLM-222` devolve UM produto (o Laranja,
     * em rascunho). O SKU exato existe, mas só numa peça da família; as outras
     * nove têm SKU vazio ou diferente e só aparecem na busca por texto. Parar
     * na primeira tentativa importava 1 cor e dava a família inteira como
     * "sem foto no site antigo".
     */
    const porId = new Map<number, any>();
    for (const params of tentativas) {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products`, {
          auth: this.auth,
          // `any` inclui RASCUNHO: muita peça boa ficou como draft no site
          // antigo, e a foto dela é tão útil quanto a das publicadas.
          params: { ...params, per_page: 100, status: 'any' },
          timeout: 30000,
        }),
      ).catch((e) => {
        this.logger.warn(`[wc-fotos] ${ref} ${JSON.stringify(params)}: ${e?.message}`);
        return null;
      });

      for (const p of (res?.data ?? []).filter(combina)) {
        if (!porId.has(p.id)) porId.set(p.id, p);
      }
    }

    this.logger.log(`[wc-fotos] ${ref}: ${porId.size} produto(s) no site antigo`);
    return Array.from(porId.values());
  }

  /**
   * RAIO-X do casamento — por que uma REF trouxe (ou não trouxe) foto.
   *
   * Existe porque diagnosticar isso pelo resultado final é adivinhação: "não
   * achou" pode ser busca vazia, filtro de nome, cor que não bate ou foto que
   * não baixou, e cada palpite custa um deploy. Aqui a resposta vem em dez
   * segundos, com o que o site antigo REALMENTE devolveu.
   */
  async diagnosticar(refBruta: string) {
    const ref = refBaseOf(refBruta);
    const cores = await this.coresDaRef(ref);
    const base = ref.replace(/[A-Z]+$/i, '').replace(/[-_\s]+$/, '');
    const tentativas: Array<Record<string, unknown>> = [
      { sku: ref },
      { search: ref },
      ...(base && base !== ref ? [{ search: base }] : []),
    ];

    const rodadas: any[] = [];

    // Primeiro a fonte que o PDV usa — se ela responde, o resto e irrelevante.
    try {
      const doWp = await this.wp.getProdutosPorRef(ref);
      rodadas.push({
        params: { fonte: 'mysql-wordpress (LIKE REF%)' },
        erro: null,
        devolvidos: doWp.length,
        produtos: doWp.slice(0, 30).map((p) => ({
          id: p.id, nome: p.nome, sku: p.sku, status: p.status,
          imagens: p.imagens.length,
          corCasada: this.casarCor(p.nome, cores),
        })),
      });
    } catch (e) {
      rodadas.push({ params: { fonte: 'mysql-wordpress' }, erro: String(e).slice(0, 120), devolvidos: 0, produtos: [] });
    }
    for (const params of tentativas) {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products`, {
          auth: this.auth,
          params: { ...params, per_page: 100, status: 'any' },
          timeout: 30000,
        }),
      ).catch((e) => ({ data: [], erro: e?.response?.status || e?.message } as any));

      const brutos: any[] = (res as any)?.data ?? [];
      rodadas.push({
        params,
        erro: (res as any)?.erro ?? null,
        devolvidos: brutos.length,
        produtos: brutos.slice(0, 20).map((p: any) => ({
          id: p.id,
          nome: p.name,
          sku: p.sku,
          status: p.status,
          imagens: (p.images ?? []).length,
          corCasada: this.casarCor(String(p.name || ''), cores),
        })),
      });
      // Sem `break`: o diagnóstico tem que mostrar TODAS as tentativas, senão
      // esconde exatamente o defeito que ele acabou de revelar (parar cedo).
    }

    return { ref, base, coresNoErp: cores, rodadas };
  }

  private async baixar(url: string): Promise<{ buffer: Buffer; mime: string } | null> {
    try {
      const res = await firstValueFrom(
        this.http.get(url, { responseType: 'arraybuffer', timeout: 30000 }),
      );
      const mime = String(res.headers?.['content-type'] || 'image/jpeg');
      if (!mime.startsWith('image/')) return null;
      return { buffer: Buffer.from(res.data), mime };
    } catch (e: any) {
      this.logger.warn(`[wc-fotos] não baixei ${url}: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Manda a IA ler a cor da peça na foto recém-importada e grava a bolinha.
   *
   * A leitura por IA já existia, mas só disparava no upload feito PELA TELA —
   * a importação roda no servidor e não passava por ali, então a peça chegava
   * com foto e bolinha cinza. Em lote isso seria milhares de bolinhas pra
   * pintar na mão.
   *
   * Best-effort: falha aqui não derruba a importação (a foto, que é o caro,
   * já está salva) e o conta-gotas manual continua disponível.
   */
  async pintarBolinha(ref: string, cor: string): Promise<void> {
    try {
      const [capa] = await this.fotos.listPhotos(ref, cor);
      if (!capa?.url) {
        // Saía calado — e "não pintou" sem log é indistinguível de "não rodou".
        this.logger.warn(`[wc-fotos] bolinha ${ref}/${cor}: sem foto no acervo, nada pra ler`);
        return;
      }

      /**
       * FAMÍLIA SEM MARCA GANHA FICHA MESMO ASSIM (12/08/2026).
       *
       * A chave da ficha é REF+MARCA e 44% do catálogo está com marca vazia
       * ([[marca-vazia-funde-produtos]]). Aqui isso virava um `return` calado:
       * 69 cores com foto boa ficavam sem bolinha PRA SEMPRE, tentando de novo
       * a cada 90 segundos, porque nada nesse caminho ia mudar sozinho.
       *
       * Marca vazia é um valor legítimo pro par único — e a leitura do site já
       * sabe lidar (`escolherFicha` cai na ficha mais preenchida quando a marca
       * não casa). Bolinha pintada numa ficha sem marca é melhor que cor cinza
       * esperando um cadastro que ninguém vai preencher hoje.
       */
      const marca = (await this.marcaDaFamilia(ref)) ?? '';
      if (!marca) {
        this.logger.warn(
          `[wc-fotos] bolinha ${ref}/${cor}: família sem MARCA no catálogo — ` +
            `gravando a ficha com marca vazia. Vale preencher a marca no cadastro.`,
        );
      }

      // Bolinha já definida (pela IA antes ou pelo conta-gotas) → nem chama a
      // IA. Cada leitura custa, e em lote isso vira dinheiro de verdade.
      const jaTemBolinha = await (this.prisma as any).produtoFichaCor.findFirst({
        where: { cor, ficha: { ref, marca }, corHex: { not: null } },
        select: { id: true },
      });
      if (jaTemBolinha) return;

      const lida = await this.corIa.detectar(capa.url);

      const ficha = await (this.prisma as any).produtoFicha.upsert({
        where: { ref_marca: { ref, marca } },
        create: { ref, marca },
        update: {},
      });
      /**
       * ⚠️ `update: {}` NÃO PREENCHIA A COR QUE ESTAVA VAZIA (achado 12/08/2026).
       *
       * O upsert daqui só gravava o hex no CREATE. Quando a linha de
       * `produto_ficha_cor` já existia com `cor_hex NULL` — o caso mais comum,
       * porque a cor ganha linha ao receber título, status de publicação ou
       * foto — ele caía no `update: {}` e não fazia NADA. E ainda logava
       * "bolinha #XXXXXX" logo abaixo, então o log dizia sucesso enquanto o
       * banco continuava vazio.
       *
       * Foi isso que segurou 128 cores: elas TÊM linha, com hex nulo, e a
       * varredura as reencontrava a cada ciclo, relia a foto (chamada paga!) e
       * jogava o resultado fora. O `pendentes()` estava certo o tempo todo — o
       * comentário dele até avisa que olha `cor_hex`, não a existência da
       * linha; quem não cumpria o combinado era a escrita.
       *
       * A regra "escolha humana ganha da IA" continua valendo, e agora é
       * explícita: só grava quando `corHex` está vazio. Conta-gotas ajustado
       * não é tocado.
       */
      const jaExiste = await (this.prisma as any).produtoFichaCor.findUnique({
        where: { fichaId_cor: { fichaId: ficha.id, cor } },
        select: { id: true, corHex: true },
      });

      const swatch = {
        corHex: lida.hex,
        swatchTipo: lida.estampada ? 'foto' : 'cor',
        swatchFocoX: lida.estampada ? 0.5 : null,
        swatchFocoY: lida.estampada ? 0.5 : null,
      };

      if (!jaExiste) {
        await (this.prisma as any).produtoFichaCor.create({
          data: { fichaId: ficha.id, cor, ...swatch },
        });
      } else if (!jaExiste.corHex) {
        await (this.prisma as any).produtoFichaCor.update({
          where: { id: jaExiste.id },
          data: swatch,
        });
      } else {
        // Alguém já escolheu a cor no conta-gotas: não se toca.
        this.logger.log(`[wc-fotos] ${ref}/${cor}: já tinha bolinha humana, mantida`);
        return;
      }

      this.logger.log(`[wc-fotos] ${ref}/${cor}: bolinha ${lida.hex} (${lida.nome})`);
    } catch (e: any) {
      this.logger.warn(`[wc-fotos] bolinha ${ref}/${cor}: ${e?.message || e}`);
    }
  }

  /** Importa as fotos de UMA REF. */
  async importarRef(refBruta: string, usuario?: string): Promise<ResultadoRef> {
    /**
     * REF-BASE, e o espaço NÃO é lixo.
     *
     * O código anterior fazia `.replace(/\s+/g, '')` pra "limpar" a REF, e com
     * isso "VMS-223 MA" virava "VMS-223MA" — que não existe em catálogo
     * nenhum. Era esse o erro na tela: "REF VMS-223MA não tem cores no
     * catálogo". O espaço fazia parte da REF; quem sobrava era o sufixo.
     */
    const ref = refBaseOf(refBruta);
    if (!ref) throw new BadRequestException('REF obrigatória');

    /**
     * ⚠️ `WC_URL` NÃO PODE SER PRÉ-REQUISITO (corrigido 06/08).
     *
     * São DUAS fontes: o MySQL do WordPress (a que funciona, e a que o PDV usa
     * há meses) e a REST do WooCommerce. Só a REST precisa de `WC_URL` — o
     * MySQL usa a conexão própria e tira o prefixo das fotos da opção
     * `siteurl` do próprio WordPress.
     *
     * Barrar tudo aqui fazia o importador recusar a REF inteira com "WC_URL
     * não configurada" mesmo com a fonte boa disponível — o botão da tela
     * simplesmente não funcionava, e a mensagem apontava pra lugar errado.
     */
    const temWc = !!this.config.get<string>('WC_URL');

    const cores = await this.coresDaRef(ref);
    if (!cores.length) throw new BadRequestException(`REF ${ref} não tem cores no catálogo.`);

    const produtos = await this.acharNoWc(ref);
    const resultado: ResultadoRef = {
      ref, coresComFoto: [], coresSemFoto: [], jaTinham: [], produtosWcSemCor: [],
      produtosEncontrados: produtos.length, fotos: 0,
    };

    // A tela precisa saber POR QUE não veio nada. "0 fotos" sem motivo mandava
    // o dono adivinhar entre: peça não existe no site antigo, site fora do ar,
    // ou nenhuma fonte configurada.
    if (!produtos.length) {
      resultado.motivo = temWc
        ? `Nenhum produto desta REF no site antigo (procurei no MySQL do WordPress e na REST do WooCommerce).`
        : `Nenhum produto desta REF no MySQL do WordPress — e a REST não pôde ser tentada porque WC_URL não está configurada.`;
      resultado.coresSemFoto = cores;
      this.logger.warn(`[wc-fotos] ${ref}: ${resultado.motivo}`);
      return resultado;
    }

    for (const p of produtos) {
      const cor = this.casarCor(String(p.name || ''), cores);
      if (!cor) {
        resultado.produtosWcSemCor.push(`#${p.id} ${String(p.name || '').slice(0, 60)}`);
        continue;
      }

      const jaTem = await this.fotos.listPhotos(ref, cor);
      if (jaTem.length) {
        if (!resultado.jaTinham.includes(cor)) resultado.jaTinham.push(cor);
        // Foto antiga com bolinha cinza também é caso pra IA: não custa nada
        // (a função sai na hora se a bolinha já estiver definida) e evita que
        // a peça fique pela metade só porque a foto chegou noutra rodada.
        await this.pintarBolinha(ref, cor);
        continue;
      }

      const imagens: any[] = (p.images ?? []).slice(0, WcFotosImportService.MAX_POR_COR);
      let subidas = 0;
      for (const img of imagens) {
        const arquivo = await this.baixar(String(img?.src || ''));
        if (!arquivo) continue;
        try {
          await this.fotos.upload({
            ref,
            cor,
            userId: usuario ?? undefined,
            file: {
              buffer: arquivo.buffer,
              mimetype: arquivo.mime,
              // Nome pelo que a peça É, não pelo id do site velho: o arquivo
              // no bucket já nasce identificável (VLM-222-MARINHO-1.jpg).
              originalname: `${ref}-${cor.replace(/[^A-Za-z0-9]+/g, '-')}-${subidas + 1}.jpg`,
            },
          });
          subidas++;
        } catch (e: any) {
          this.logger.warn(`[wc-fotos] ${ref}/${cor}: ${e?.message || e}`);
        }
      }
      if (subidas > 0) {
        resultado.coresComFoto.push(cor);
        resultado.fotos += subidas;
        await this.pintarBolinha(ref, cor);
      }
    }

    resultado.coresSemFoto = cores.filter(
      (c) => !resultado.coresComFoto.includes(c) && !resultado.jaTinham.includes(c),
    );

    this.logger.log(
      `[wc-fotos] ${ref}: ${resultado.fotos} foto(s) em ${resultado.coresComFoto.length} cor(es); ` +
        `${resultado.coresSemFoto.length} cor(es) sem foto no site antigo`,
    );
    return resultado;
  }

  /**
   * Lote — para quando o dono quiser puxar o acervo inteiro.
   *
   * Em SÉRIE e com teto: o WordPress mora no mesmo servidor do ERP antigo
   * ([[giga-wp-server-firewall]]), e paralelizar download de imagem lá é a
   * receita pra derrubar o site que ainda está vendendo.
   */
  async importarLote(refs: string[], usuario?: string) {
    const lista = Array.from(new Set((refs || []).map((r) => String(r).trim().toUpperCase()))).slice(0, 50);
    const relatorio: ResultadoRef[] = [];
    for (const ref of lista) {
      try {
        relatorio.push(await this.importarRef(ref, usuario));
      } catch (e: any) {
        relatorio.push({
          ref, coresComFoto: [], coresSemFoto: [], jaTinham: [],
          produtosWcSemCor: [`erro: ${e?.message || e}`], produtosEncontrados: 0, fotos: 0,
        });
      }
    }
    return {
      refs: relatorio.length,
      fotos: relatorio.reduce((s, r) => s + r.fotos, 0),
      detalhe: relatorio,
    };
  }
}
