import { NextResponse } from 'next/server';
import { normalize } from '@/lib/utils';

/**
 * MÉTRICAS DE BUSCA — POST acumula, GET agrega pro painel /debug/search.
 *
 * ⚠️ MESMO LIMITE DECLARADO do log de tracking (ver lib/tracking/server/
 * log-store.ts): armazenamento em MEMÓRIA por instância serverless — bom o
 * bastante pra depurar e pro painel mostrar a atividade recente, e NÃO é a
 * série histórica definitiva. A trilha durável é o `console.log` estruturado
 * em produção (stdout da Vercel é capturado e pesquisável). Quando o volume
 * justificar: tabela `search_metrics` com (term, day) como chave.
 *
 * POST é público de propósito — sendBeacon não carrega header de auth.
 * O corpo é validado e truncado; o pior abuso possível enche um Map de 2.000
 * entradas em memória volátil. GET/DELETE são protegidos pelo MESMO esquema
 * do /api/events/logs (TRACKING_DEBUG_TOKEN): termos digitados são
 * comportamento de visitante real — abertos, seriam vazamento.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TermStats {
  /** Termo normalizado (minúsculo, sem acento) — a chave de agregação. */
  term: string;
  searches: number;
  /** Quantas buscas desse termo voltaram com zero produtos. */
  zeroResults: number;
  clicks: number;
  /** Contagem da resposta mais recente (pra ver recuperação de catálogo). */
  lastResults: number;
  lastAt: string;
}

const MAX_TERMS = 2_000;

class SearchMetricsStore {
  private terms = new Map<string, TermStats>();

  registrar(term: string, results: number | undefined, clicked: boolean): void {
    const stats = this.terms.get(term) ?? {
      term,
      searches: 0,
      zeroResults: 0,
      clicks: 0,
      lastResults: 0,
      lastAt: '',
    };

    if (clicked) {
      stats.clicks += 1;
    } else {
      stats.searches += 1;
      stats.lastResults = results ?? 0;
      if ((results ?? 0) === 0) stats.zeroResults += 1;
    }
    stats.lastAt = new Date().toISOString();

    // Map preserva ordem de inserção: deletar+setar move o termo pro fim,
    // então o primeiro da iteração é sempre o mais frio — eviction barata.
    this.terms.delete(term);
    this.terms.set(term, stats);
    if (this.terms.size > MAX_TERMS) {
      const frio = this.terms.keys().next().value;
      if (frio !== undefined) this.terms.delete(frio);
    }
  }

  listar(): TermStats[] {
    return [...this.terms.values()];
  }

  limpar(): void {
    this.terms.clear();
  }
}

// Sobrevive ao hot-reload em dev — mesmo padrão do log-store do tracking.
const globalRef = globalThis as unknown as { __lurdsSearchMetrics?: SearchMetricsStore };
const store: SearchMetricsStore = globalRef.__lurdsSearchMetrics ?? new SearchMetricsStore();
globalRef.__lurdsSearchMetrics = store;

/* ---------------------------------------------------------------- ESCRITA */

export async function POST(req: Request) {
  let body: { term?: unknown; results?: unknown; clicked?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'corpo inválido' }, { status: 400 });
  }

  const bruto = typeof body.term === 'string' ? body.term.trim() : '';
  if (bruto.length < 2) {
    return NextResponse.json({ error: 'termo inválido' }, { status: 400 });
  }
  // Normaliza e trunca: "Vestido Festa" e "vestido festa" são o MESMO termo,
  // e ninguém digita 120 caracteres de busca de boa fé.
  const term = normalize(bruto).replace(/\s+/g, ' ').slice(0, 120);
  const clicked = body.clicked === true;
  const results =
    typeof body.results === 'number' && Number.isFinite(body.results)
      ? Math.max(0, Math.floor(body.results))
      : undefined;

  store.registrar(term, results, clicked);

  // Trilha durável (stdout da Vercel). Só o agregável — termo já é anônimo,
  // mas nunca logar mais que o necessário.
  if (process.env.NODE_ENV === 'production') {
    console.log(
      JSON.stringify({
        tag: 'search_metric',
        term,
        results: clicked ? undefined : (results ?? 0),
        clicked: clicked || undefined,
        at: new Date().toISOString(),
      }),
    );
  }

  return NextResponse.json({ ok: true });
}

/* ---------------------------------------------------------------- LEITURA */

/** Mesmo esquema do /api/events/logs: token via header ou query; sem env
 *  configurada, a rota "não existe" em produção (404) e fica aberta em dev. */
function autorizado(req: Request): boolean {
  const esperado = process.env.TRACKING_DEBUG_TOKEN;
  if (!esperado) return process.env.NODE_ENV !== 'production';

  const header = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const query = new URL(req.url).searchParams.get('token');
  return header === esperado || query === esperado;
}

export async function GET(req: Request) {
  if (!autorizado(req)) {
    return NextResponse.json({ error: 'não encontrado' }, { status: 404 });
  }

  const termos = store.listar();
  const comCtr = termos.map((t) => ({
    ...t,
    ctr: t.searches > 0 ? Math.round((t.clicks / t.searches) * 100) / 100 : 0,
  }));

  const pesquisas = termos.reduce((s, t) => s + t.searches, 0);
  const cliques = termos.reduce((s, t) => s + t.clicks, 0);
  const zeroTotal = termos.reduce((s, t) => s + t.zeroResults, 0);

  return NextResponse.json(
    {
      volume: {
        pesquisas,
        cliques,
        zeroResults: zeroTotal,
        termos: termos.length,
        ctrGlobal: pesquisas > 0 ? Math.round((cliques / pesquisas) * 100) / 100 : 0,
      },
      // Top termos por volume — o retrato do que a cliente quer.
      topTermos: [...comCtr].sort((a, b) => b.searches - a.searches).slice(0, 20),
      // A lista de OURO do merchandising: o que procuram e NÃO existe.
      zeroResults: [...comCtr]
        .filter((t) => t.zeroResults > 0)
        .sort((a, b) => b.zeroResults - a.zeroResults)
        .slice(0, 50),
      // Buscou, viu resultado e não clicou em nada — resultado ruim ou preço.
      semClique: [...comCtr]
        .filter((t) => t.searches >= 2 && t.clicks === 0 && t.lastResults > 0)
        .sort((a, b) => b.searches - a.searches)
        .slice(0, 20),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function DELETE(req: Request) {
  if (!autorizado(req)) {
    return NextResponse.json({ error: 'não encontrado' }, { status: 404 });
  }
  store.limpar();
  return NextResponse.json({ ok: true });
}
