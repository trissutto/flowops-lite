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

const CAMPOS_DIAGNOSTICOS: Record<string, readonly string[]> = {
  color_switch: ['color'],
  size_switch: ['size'],
  add_to_cart_blocked: ['reason'],
  add_shipping_info: ['shipping_tier'],
  add_payment_info: ['payment_type'],
  checkout_submission: ['method'],
  checkout_error: ['method', 'reason'],
  checkout_validation_error: ['section', 'field'],
  pix_created: ['method'],
  payment_method_selected: ['method'],
  pix_copied: ['method', 'order_id'],
  pix_expired: ['method', 'order_id'],
  card_declined: ['method', 'attempt'],
  payment_retry: ['method', 'attempt'],
  checkout_recovered: ['method', 'order_id'],
};

/** Defesa final contra PII: só persiste chaves fechadas e valores curtos. */
export function sanitizarDadosEvento(evento: string, dados: unknown): Record<string, string> | undefined {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return undefined;
  const permitidos = CAMPOS_DIAGNOSTICOS[evento] ?? [];
  const origem = dados as Record<string, unknown>;
  const limpo: Record<string, string> = {};
  for (const campo of permitidos) {
    const valor = origem[campo];
    if (typeof valor !== 'string' && typeof valor !== 'number' && typeof valor !== 'boolean') continue;
    const texto = String(valor).trim().slice(0, 80);
    if (texto) limpo[campo] = texto;
  }
  return Object.keys(limpo).length ? limpo : undefined;
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
        dados: sanitizarDadosEvento(String(e.evento), e.dados),
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
   * O LEAD DO WHATSAPP — quem clicou E mandou a mensagem carimbada.
   *
   * Quem chama é o n8n (Evolution → webhook → cá), não o site. Dedup de
   * rajada: a MESMA pessoa mandando de novo em menos de 1h não vira lead
   * novo — o WhatsApp reenvia webhook com facilidade e cada toque duplicado
   * inflaria a tela. Depois de 1h conta de novo de propósito: voltou outro
   * dia, é interesse novo.
   */
  async registrarLeadWhatsapp(entrada: {
    telefone?: string; nome?: string | null; loja?: string | null;
    mensagem?: string | null; instancia?: string | null;
  }): Promise<{ ok: boolean; duplicado?: boolean }> {
    const telefone = String(entrada?.telefone || '').replace(/\D/g, '').slice(0, 20);
    if (telefone.length < 10) return { ok: false };

    try {
      const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000);
      const recente = await (this.prisma as any).whatsappLead.findFirst({
        where: { telefone, criadoEm: { gte: umaHoraAtras } },
        select: { id: true },
      });
      if (recente) return { ok: true, duplicado: true };

      await (this.prisma as any).whatsappLead.create({
        data: {
          telefone,
          nome: this.corta(entrada.nome, 120),
          loja: this.corta(entrada.loja, 80),
          mensagem: this.corta(entrada.mensagem, 2000),
          instancia: this.corta(entrada.instancia, 60),
        },
      });
      return { ok: true };
    } catch (err) {
      this.logger.error(`falha ao gravar lead do whatsapp: ${String(err)}`);
      return { ok: false };
    }
  }

  /** A tela de leads: lista do período + contagem por loja. */
  async leadsWhatsapp(de: Date, ate: Date): Promise<{
    total: number;
    porLoja: Array<{ loja: string; leads: number }>;
    linhas: Array<{
      id: string; telefone: string; nome: string | null; loja: string | null;
      mensagem: string | null; instancia: string | null; criadoEm: Date;
    }>;
  }> {
    const janela = { gte: de, lte: ate };
    const linhas = await (this.prisma as any).whatsappLead.findMany({
      where: { criadoEm: janela },
      orderBy: { criadoEm: 'desc' },
      take: 500,
    });

    const porLojaMapa = new Map<string, number>();
    for (const l of linhas as Array<{ loja: string | null }>) {
      const chave = l.loja || 'Atendimento do site';
      porLojaMapa.set(chave, (porLojaMapa.get(chave) || 0) + 1);
    }

    return {
      total: linhas.length,
      porLoja: Array.from(porLojaMapa.entries())
        .map(([loja, leads]) => ({ loja, leads }))
        .sort((a, b) => b.leads - a.leads),
      linhas,
    };
  }

  /**
   * O FUNIL DE VENDA DO SITE (dono, 13/08: "preciso destes dados na tela de
   * cliques — add cart, initiate checkout, etc"). Do `site_eventos` — a cópia
   * de primeira parte, que conta todo mundo (com e sem aceite do banner).
   *
   * EVENTOS (toques) e PESSOAS (sessões distintas) por etapa. A coleta nasceu
   * em 13/08/2026 à tarde: período anterior vem zerado, e a tela avisa em vez
   * de deixar parecer que o site não vendia. `::int` nos COUNTs: BigInt na
   * resposta é 500 mudo de serialização.
   */
  /**
   * SESSÕES QUE ENTRARAM PELA PÁGINA DAS LOJAS — ficam FORA do funil.
   *
   * Decisão do dono (16/08): o anúncio que cai na `/lojas` vende visita à loja
   * física, não compra no site. Essa gente navega, às vezes olha peça, e sai
   * sem comprar; contá-la no denominador afunda a conversão do site com um
   * público que nunca teve intenção de comprar online. O que ELAS convertem é
   * contato com a loja, e isso tem quadro próprio (`trafegoDeLojas`).
   *
   * O corte é pela PÁGINA DE ENTRADA, não pelo UTM, de propósito: a atribuição
   * sobrevive 30 dias no navegador, então quem veio pelo anúncio hoje continua
   * carimbado se voltar semana que vem — e uma compra orgânica dela sumiria da
   * conta. Entrar pela `/lojas` é o que define a intenção DAQUELA visita; o UTM
   * (gravado desde 16/08) responde de qual anúncio ela veio.
   *
   * Ressalva conhecida: sessão iniciada ANTES da janela tem como "entrada" o
   * primeiro evento dentro dela. O erro é pequeno e sempre a favor de contar no
   * funil — nunca de esconder venda.
   */
  private static readonly SESSOES_DE_LOJA = `
    SELECT session_id FROM (
      SELECT DISTINCT ON (session_id) session_id, path
        FROM site_eventos
       WHERE criado_em >= $1 AND criado_em <= $2
         AND session_id IS NOT NULL AND path IS NOT NULL
       ORDER BY session_id, criado_em
    ) entrada
     WHERE path ILIKE '/lojas%' OR path ILIKE '/nossaslojas%'`;

  async funil(
    de: Date,
    ate: Date,
  ): Promise<Array<{ evento: string; eventos: number; pessoas: number; valor: number }>> {
    const linhas = await this.prisma.$queryRawUnsafe<
      Array<{ evento: string; eventos: number; pessoas: number; valor: number }>
    >(
      `WITH lojas AS (${SiteMetricsService.SESSOES_DE_LOJA})
       SELECT evento,
              COUNT(*)::int                   AS eventos,
              COUNT(DISTINCT session_id)::int AS pessoas,
              COALESCE(SUM(valor), 0)::float  AS valor
         FROM site_eventos e
        WHERE criado_em >= $1 AND criado_em <= $2
          AND evento IN ('page_view','view_item','add_to_cart','begin_checkout','add_payment_info','purchase')
          -- Sessão sem id não dá pra classificar: fica no funil. Perder dado é
          -- pior que carregar um punhado de anônimos no denominador.
          AND (e.session_id IS NULL OR e.session_id NOT IN (SELECT session_id FROM lojas))
        GROUP BY evento`,
      de,
      ate,
    );
    return linhas.map((l) => ({
      evento: l.evento,
      eventos: Number(l.eventos),
      pessoas: Number(l.pessoas),
      // VALOR DE CONVERSÃO (dono, 15/08). Só interessa em `purchase` — é o R$
      // somado das compras do período (`valor` do evento = total do pedido). As
      // outras etapas somam o preço da peça vista/na sacola e a tela ignora.
      valor: Number(l.valor) || 0,
    }));
  }

  /**
   * O MAPA DO TRÁFEGO DE LOJAS (dono, 16/08: "crie um mapa disso mostrando que
   * tipo de conversão este tráfego nos trás").
   *
   * Estas pessoas saíram do funil de e-commerce — mas sair do funil não é
   * sumir. A conversão delas é OUTRA: falar com a loja. Aqui a conta é
   * "chegaram × contataram", com a unidade que recebeu o contato, a campanha
   * que trouxe e o que elas fizeram no site apesar de tudo (parte compra, e
   * isso precisa aparecer em algum lugar).
   */
  async trafegoDeLojas(de: Date, ate: Date): Promise<{
    pessoas: number;
    contataram: number;
    contatos: { whatsapp: number; comoChegar: number; telefone: number; instagram: number };
    navegaram: { viramPeca: number; sacola: number; checkout: number; compraram: number };
    valorComprado: number;
    porUnidade: Array<{ loja: string; contatos: number }>;
    porCampanha: Array<{ campanha: string; canal: string | null; pessoas: number }>;
  }> {
    const CONTATO = `('whatsapp_click','store_locator','phone_click','instagram_click')`;

    const [tot] = await this.prisma.$queryRawUnsafe<Array<Record<string, any>>>(
      `WITH lojas AS (${SiteMetricsService.SESSOES_DE_LOJA})
       SELECT COUNT(DISTINCT l.session_id)::int AS pessoas,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento IN ${CONTATO})::int AS contataram,
              COUNT(*) FILTER (WHERE e.evento='whatsapp_click')::int  AS whatsapp,
              COUNT(*) FILTER (WHERE e.evento='store_locator')::int   AS como_chegar,
              COUNT(*) FILTER (WHERE e.evento='phone_click')::int     AS telefone,
              COUNT(*) FILTER (WHERE e.evento='instagram_click')::int AS instagram,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='view_item')::int      AS viram_peca,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='add_to_cart')::int    AS sacola,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='begin_checkout')::int AS checkout,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='purchase')::int       AS compraram,
              COALESCE(SUM(e.valor) FILTER (WHERE e.evento='purchase'), 0)::float        AS valor
         FROM lojas l
         LEFT JOIN site_eventos e
                ON e.session_id = l.session_id AND e.criado_em >= $1 AND e.criado_em <= $2`,
      de,
      ate,
    );

    const porUnidade = await this.prisma.$queryRawUnsafe<Array<{ loja: string; contatos: number }>>(
      `WITH lojas AS (${SiteMetricsService.SESSOES_DE_LOJA})
       SELECT COALESCE(e.loja, 'sem unidade') AS loja, COUNT(*)::int AS contatos
         FROM site_eventos e JOIN lojas l ON l.session_id = e.session_id
        WHERE e.criado_em >= $1 AND e.criado_em <= $2 AND e.evento IN ${CONTATO}
        GROUP BY 1 ORDER BY contatos DESC LIMIT 20`,
      de,
      ate,
    );

    // A campanha vem do UTM gravado desde 16/08 (`dados->>'campanha'`). Sessão
    // anterior a isso — ou visita orgânica — cai em "sem campanha", e isso é
    // informação: mostra quanto do tráfego da /lojas não é do anúncio.
    const porCampanha = await this.prisma.$queryRawUnsafe<
      Array<{ campanha: string; canal: string | null; pessoas: number }>
    >(
      `WITH lojas AS (${SiteMetricsService.SESSOES_DE_LOJA}),
            marca AS (
              SELECT DISTINCT ON (e.session_id) e.session_id,
                     COALESCE(e.dados->>'campanha', 'sem campanha') AS campanha,
                     e.dados->>'canal' AS canal
                FROM site_eventos e JOIN lojas l ON l.session_id = e.session_id
               WHERE e.criado_em >= $1 AND e.criado_em <= $2
               ORDER BY e.session_id, (e.dados->>'campanha') IS NULL, e.criado_em
            )
       SELECT campanha, canal, COUNT(*)::int AS pessoas
         FROM marca GROUP BY 1, 2 ORDER BY pessoas DESC LIMIT 12`,
      de,
      ate,
    );

    return {
      pessoas: Number(tot?.pessoas ?? 0),
      contataram: Number(tot?.contataram ?? 0),
      contatos: {
        whatsapp: Number(tot?.whatsapp ?? 0),
        comoChegar: Number(tot?.como_chegar ?? 0),
        telefone: Number(tot?.telefone ?? 0),
        instagram: Number(tot?.instagram ?? 0),
      },
      navegaram: {
        viramPeca: Number(tot?.viram_peca ?? 0),
        sacola: Number(tot?.sacola ?? 0),
        checkout: Number(tot?.checkout ?? 0),
        compraram: Number(tot?.compraram ?? 0),
      },
      valorComprado: Number(tot?.valor ?? 0),
      porUnidade: porUnidade.map((u) => ({ loja: u.loja, contatos: Number(u.contatos) })),
      porCampanha: porCampanha.map((c) => ({
        campanha: c.campanha,
        canal: c.canal,
        pessoas: Number(c.pessoas),
      })),
    };
  }

  /**
   * FATURAMENTO REAL DO SITE no período (dono, 15/08) — a Fonte B, ao lado do
   * valor de conversão do funil (Fonte A). O funil soma o EVENTO `purchase`
   * (sessionizado, com/sem cookie) e casa com a coluna Compras; isto soma o
   * DINHEIRO: pedidos `source='ecommerce'` já pagos. As duas divergem quando um
   * PIX é pago noutro dia ou o evento do navegador não dispara — por isso ficam
   * em linhas separadas, cada uma com seu significado. Janela por `created_at`,
   * a mesma do funil (um PIX pago depois conta retroativo no dia do pedido).
   */
  async faturamentoSite(de: Date, ate: Date): Promise<{ pedidos: number; valor: number }> {
    const r = await this.prisma.$queryRawUnsafe<Array<{ pedidos: number; valor: number }>>(
      `SELECT COUNT(*)::int AS pedidos, COALESCE(SUM(total_amount), 0)::float AS valor
         FROM orders
        WHERE source = 'ecommerce'
          AND status IN ('paid','separating','shipped','delivered','completed')
          AND created_at >= $1 AND created_at <= $2`,
      de,
      ate,
    );
    return { pedidos: Number(r[0]?.pedidos ?? 0), valor: Number(r[0]?.valor ?? 0) };
  }

  async diagnosticosFunil(de: Date, ate: Date): Promise<Array<{
    evento: string; codigo: string; campo: string | null; pessoas: number; eventos: number;
  }>> {
    const linhas = await this.prisma.$queryRawUnsafe<Array<{
      evento: string; codigo: string; campo: string | null; pessoas: number; eventos: number;
    }>>(
      `SELECT evento,
              COALESCE(dados->>'reason', dados->>'method', dados->>'payment_type', dados->>'section',
                       dados->>'shipping_tier', dados->>'color', dados->>'size', 'sem_codigo') AS codigo,
              CASE WHEN dados ? 'field' THEN dados->>'field' ELSE NULL END AS campo,
              COUNT(DISTINCT session_id)::int AS pessoas,
              COUNT(*)::int AS eventos
         FROM site_eventos
        WHERE criado_em >= $1 AND criado_em <= $2
          AND evento IN ('color_switch','size_switch','add_to_cart_blocked',
                         'add_shipping_info','add_payment_info','checkout_submission',
                         'checkout_error','checkout_validation_error','pix_created',
                         'payment_method_selected','pix_copied','pix_expired',
                         'card_declined','payment_retry','checkout_recovered')
        GROUP BY evento, codigo, campo
        ORDER BY eventos DESC, evento, codigo
        LIMIT 100`,
      de,
      ate,
    );
    return linhas.map((l) => ({
      evento: l.evento,
      codigo: l.codigo,
      campo: l.campo,
      pessoas: Number(l.pessoas),
      eventos: Number(l.eventos),
    }));
  }

  /** Sessões que tiveram pelo menos duas falhas num intervalo móvel de 10 min. */
  async alertasCheckout(de: Date, ate: Date): Promise<Array<{
    sessionId: string; etapa: string; pagamento: string; codigo: string;
    pedido: string | null; tentativas: number; primeiraFalha: Date; ultimaFalha: Date;
  }>> {
    const linhas = await this.prisma.$queryRawUnsafe<Array<{
      session_id: string; etapa: string; pagamento: string; codigo: string;
      pedido: string | null; tentativas: number; primeira_falha: Date; ultima_falha: Date;
    }>>(
      `WITH erros AS (
         SELECT session_id, criado_em, dados
           FROM site_eventos
          WHERE criado_em >= $1 AND criado_em <= $2
            AND evento = 'checkout_error' AND session_id IS NOT NULL
       ), sessoes_alerta AS (
         SELECT DISTINCT a.session_id
           FROM erros a
           JOIN erros b ON b.session_id = a.session_id
                        AND b.criado_em > a.criado_em
                        AND b.criado_em <= a.criado_em + INTERVAL '10 minutes'
       )
       SELECT e.session_id,
              COALESCE((ARRAY_AGG(e.dados->>'stage' ORDER BY e.criado_em DESC))[1], 'submission') AS etapa,
              COALESCE((ARRAY_AGG(e.dados->>'method' ORDER BY e.criado_em DESC))[1], 'desconhecido') AS pagamento,
              COALESCE((ARRAY_AGG(e.dados->>'reason' ORDER BY e.criado_em DESC))[1], 'sem_codigo') AS codigo,
              (ARRAY_AGG(e.dados->>'order_id' ORDER BY e.criado_em DESC))[1] AS pedido,
              COUNT(*)::int AS tentativas,
              MIN(e.criado_em) AS primeira_falha,
              MAX(e.criado_em) AS ultima_falha
         FROM erros e
         JOIN sessoes_alerta s ON s.session_id = e.session_id
        GROUP BY e.session_id
        ORDER BY ultima_falha DESC
        LIMIT 100`,
      de,
      ate,
    );
    return linhas.map((l) => ({
      sessionId: l.session_id,
      etapa: l.etapa,
      pagamento: l.pagamento,
      codigo: l.codigo,
      pedido: l.pedido,
      tentativas: Number(l.tentativas),
      primeiraFalha: l.primeira_falha,
      ultimaFalha: l.ultima_falha,
    }));
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
