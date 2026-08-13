import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Só estes entram. Evento fora da lista é descartado em silêncio — a rota é
 *  pública (token compartilhado) e não vira depósito de qualquer coisa. */
const EVENTOS_ACEITOS = new Set([
  'whatsapp_click',
  'instagram_click',
  'store_locator',
  'phone_click',
]);

export interface CliqueEntrada {
  evento?: string;
  loja?: string | null;
  cidade?: string | null;
  origem?: string | null;
  path?: string | null;
  sessionId?: string | null;
}

/** Um evento genérico do site — a cópia de primeira parte do funil inteiro. */
export interface EventoEntrada {
  evento?: string;
  path?: string | null;
  loja?: string | null;
  sessionId?: string | null;
  valor?: number | null;
  dados?: unknown;
  semAceite?: boolean;
}

/** Uma linha do relatório: a loja e o que fizeram nela. */
export interface LinhaLoja {
  loja: string;
  comoChegar: number;
  whatsapp: number;
  instagram: number;
  telefone: number;
  total: number;
  /** Sessões distintas — quantas PESSOAS, não quantos cliques. */
  pessoas: number;
}

@Injectable()
export class SiteMetricsService {
  private readonly logger = new Logger(SiteMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Corta no tamanho da coluna. Texto maior que o VarChar derruba o INSERT
   *  inteiro no Postgres, e derrubar um lote de cliques por causa de um path
   *  comprido seria perder dado bom por causa de dado feio. */
  private corta(valor: unknown, max: number): string | null {
    if (valor === null || valor === undefined) return null;
    const texto = String(valor).trim();
    return texto ? texto.slice(0, max) : null;
  }

  /**
   * Grava o lote vindo do site. NUNCA lança: se a gravação falhar, o site não
   * pode quebrar por causa de métrica. Devolve quantos entraram.
   */
  async registrar(entradas: CliqueEntrada[]): Promise<number> {
    const linhas = entradas
      .filter((e) => e?.evento && EVENTOS_ACEITOS.has(e.evento))
      .map((e) => ({
        evento: this.corta(e.evento, 40) as string,
        loja: this.corta(e.loja, 80),
        cidade: this.corta(e.cidade, 80),
        origem: this.corta(e.origem, 40),
        path: this.corta(e.path, 160),
        sessionId: this.corta(e.sessionId, 64),
      }));

    if (!linhas.length) return 0;

    try {
      const r = await this.prisma.siteStoreClick.createMany({ data: linhas });
      return r.count;
    } catch (err) {
      this.logger.error(`falha ao gravar cliques de loja: ${String(err)}`);
      return 0;
    }
  }

  /**
   * TODO EVENTO DO SITE, sem lista fechada (dono, 13/08: "para todo o site").
   * Aqui aceita qualquer nome de evento — quem valida forma e teto é o BFF do
   * e-commerce, e a rota continua atrás do token compartilhado. `semAceite`
   * marca a linha anônima de quem não aceitou o banner.
   */
  async registrarEventos(entradas: EventoEntrada[]): Promise<number> {
    const linhas = entradas
      .filter((e) => e?.evento && String(e.evento).trim())
      .map((e) => ({
        evento: this.corta(e.evento, 40) as string,
        path: this.corta(e.path, 200),
        loja: this.corta(e.loja, 80),
        sessionId: this.corta(e.sessionId, 64),
        valor: typeof e.valor === 'number' && Number.isFinite(e.valor) ? e.valor : null,
        dados: e.dados && typeof e.dados === 'object' ? (e.dados as object) : undefined,
        semAceite: e.semAceite === true,
      }));

    if (!linhas.length) return 0;

    try {
      const r = await (this.prisma as any).siteEvento.createMany({ data: linhas });
      return r.count;
    } catch (err) {
      this.logger.error(`falha ao gravar eventos do site: ${String(err)}`);
      return 0;
    }
  }

  /**
   * QUANTAS PESSOAS ESTÃO NO SITE AGORA — do nosso dado, não do GA4.
   *
   * Pergunta do dono (13/08): "quantas pessoas estão no site neste momento?
   * como vejo pelo sistema nosso?". A resposta vem de `site_eventos`: o site
   * manda page_view/scroll/time_on_page de TODO mundo (com ou sem aceite do
   * banner, linha anonimizada), então sessão com evento recente = pessoa
   * navegando. Não é batida de presença: quem está parado numa página só
   * aparece enquanto os eventos de tempo/rolagem pingam — por isso o card
   * mostra a janela ("últimos 5 min") em vez de fingir precisão.
   *
   * GA4 não serve pra isso hoje: o site novo dispara no MESMO stream do
   * WordPress ([[ga4-site-novo-stream-trocado]]), então o "tempo real" de lá
   * soma os dois sites.
   *
   * Tudo em UMA query com subselects — a tela recarrega a cada 20s e não vale
   * quatro idas ao banco. `::int` em todo COUNT: BigInt na resposta é 500 mudo
   * de serialização.
   */
  async agora(): Promise<{
    ativos5min: number;
    ativos30min: number;
    sessoesHoje: number;
    pageViewsHoje: number;
    paginasQuentes: Array<{ path: string; pessoas: number }>;
  }> {
    // "Hoje" no fuso da loja (São Paulo), não em UTC — meia-noite UTC é 21h
    // daqui e comeria as três primeiras horas do dia (mesmo cuidado do
    // relatório de cliques).
    const [linha] = await this.prisma.$queryRawUnsafe<Array<{
      ativos5: number; ativos30: number; sessoes_hoje: number; pv_hoje: number;
    }>>(
      `SELECT
         (SELECT COUNT(DISTINCT session_id)::int FROM site_eventos
           WHERE criado_em > NOW() - INTERVAL '5 minutes' AND session_id IS NOT NULL)  AS ativos5,
         (SELECT COUNT(DISTINCT session_id)::int FROM site_eventos
           WHERE criado_em > NOW() - INTERVAL '30 minutes' AND session_id IS NOT NULL) AS ativos30,
         (SELECT COUNT(DISTINCT session_id)::int FROM site_eventos
           WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
                             AT TIME ZONE 'America/Sao_Paulo'
             AND session_id IS NOT NULL)                                               AS sessoes_hoje,
         (SELECT COUNT(*)::int FROM site_eventos
           WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
                             AT TIME ZONE 'America/Sao_Paulo'
             AND evento = 'page_view')                                                 AS pv_hoje`,
    );

    const paginas = await this.prisma.$queryRawUnsafe<Array<{ path: string; pessoas: number }>>(
      `SELECT path, COUNT(DISTINCT session_id)::int AS pessoas
         FROM site_eventos
        WHERE criado_em > NOW() - INTERVAL '5 minutes'
          AND session_id IS NOT NULL AND path IS NOT NULL
        GROUP BY path
        ORDER BY pessoas DESC, path
        LIMIT 8`,
    );

    return {
      ativos5min: Number(linha?.ativos5 ?? 0),
      ativos30min: Number(linha?.ativos30 ?? 0),
      sessoesHoje: Number(linha?.sessoes_hoje ?? 0),
      pageViewsHoje: Number(linha?.pv_hoje ?? 0),
      paginasQuentes: paginas.map((p) => ({ path: p.path, pessoas: Number(p.pessoas) })),
    };
  }

  /**
   * Relatório por loja no período.
   *
   * Duas queries de propósito: `groupBy` conta CLIQUES (soma tudo), e a segunda
   * conta SESSÕES distintas. Não dá pra tirar as duas de um groupBy só — o
   * Prisma não faz `count(distinct)` dentro de agregação — e a diferença entre
   * elas é justamente o que separa "23 cliques" de "23 pessoas".
   */
  async porLoja(de: Date, ate: Date): Promise<{ linhas: LinhaLoja[]; totalCliques: number }> {
    const janela = { gte: de, lte: ate };

    const grupos = await this.prisma.siteStoreClick.groupBy({
      by: ['loja', 'evento'],
      where: { createdAt: janela },
      _count: { _all: true },
    });

    const sessoes = await this.prisma.siteStoreClick.findMany({
      where: { createdAt: janela, sessionId: { not: null } },
      select: { loja: true, sessionId: true },
      distinct: ['loja', 'sessionId'],
    });

    const pessoasPorLoja = new Map<string, number>();
    for (const s of sessoes) {
      const chave = s.loja ?? '—';
      pessoasPorLoja.set(chave, (pessoasPorLoja.get(chave) ?? 0) + 1);
    }

    const porLoja = new Map<string, LinhaLoja>();
    let totalCliques = 0;

    for (const g of grupos) {
      // Loja nula é clique que não nasceu de uma unidade (WhatsApp geral).
      // Vira uma linha própria em vez de sumir — senão o total da tela não
      // bate com o total do período e ninguém entende por quê.
      const chave = g.loja ?? '—';
      const n = g._count._all;
      totalCliques += n;

      const linha =
        porLoja.get(chave) ??
        { loja: chave, comoChegar: 0, whatsapp: 0, instagram: 0, telefone: 0, total: 0, pessoas: 0 };

      if (g.evento === 'store_locator') linha.comoChegar += n;
      else if (g.evento === 'whatsapp_click') linha.whatsapp += n;
      else if (g.evento === 'instagram_click') linha.instagram += n;
      else if (g.evento === 'phone_click') linha.telefone += n;

      linha.total += n;
      porLoja.set(chave, linha);
    }

    for (const [chave, linha] of porLoja) {
      linha.pessoas = pessoasPorLoja.get(chave) ?? 0;
    }

    const linhas = [...porLoja.values()].sort((a, b) => b.total - a.total);
    return { linhas, totalCliques };
  }
}
