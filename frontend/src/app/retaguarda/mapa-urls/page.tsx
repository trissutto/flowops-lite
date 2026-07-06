'use client';

/**
 * /retaguarda/mapa-urls — mapa de TODAS as telas do sistema.
 *
 * Lista toda rota (page.tsx) do app com uma flag "tem atalho" = existe algum
 * botão/link/menu apontando pra ela. Rota sem atalho = só se chega por URL
 * digitada (candidata a virar botão ou a ser removida se for legado).
 *
 * OS DADOS SÃO GERADOS: rode `node scripts/gen-routes-map.mjs` (em frontend/)
 * sempre que criar/remover telas ou atalhos. Isso reescreve routes.generated.json.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search, ExternalLink, Link2, Link2Off, RefreshCcw } from 'lucide-react';
import data from './routes.generated.json';

type Row = { route: string; section: string; dynamic: boolean; hasShortcut: boolean; file: string };
type Filter = 'todas' | 'atalho' | 'sematalho' | 'dinamicas';

const ROWS = (data.rows as Row[]) || [];

export default function MapaUrlsPage() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('todas');

  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return ROWS.filter((r) => {
      if (filter === 'atalho' && !r.hasShortcut) return false;
      if (filter === 'sematalho' && r.hasShortcut) return false;
      if (filter === 'dinamicas' && !r.dynamic) return false;
      if (words.length) {
        const hay = `${r.route} ${r.file}`.toLowerCase();
        for (const w of words) if (!hay.includes(w)) return false;
      }
      return true;
    });
  }, [q, filter]);

  // Agrupa por seção (1º segmento da URL)
  const grouped = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of filtered) {
      const g = m.get(r.section) || [];
      g.push(r);
      m.set(r.section, g);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const genAt = (data as any).generatedAt ? new Date((data as any).generatedAt) : null;

  const FilterBtn = ({ id, label, count }: { id: Filter; label: string; count: number }) => (
    <button
      onClick={() => setFilter(id)}
      className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
        filter === id
          ? 'bg-slate-800 text-white border-slate-800'
          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
      }`}
    >
      {label} <span className="opacity-70">({count})</span>
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-xl">🗺️</div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Mapa de URLs</h1>
            <p className="text-xs text-slate-500">
              Todas as telas do sistema · flag = tem botão de atalho apontando pra ela
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">
        {/* Resumo */}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Telas" value={data.total} tone="slate" />
          <Stat label="Com atalho" value={(data as any).comAtalho} tone="emerald" />
          <Stat label="Sem atalho" value={(data as any).semAtalho} tone="rose" />
        </div>

        {/* Busca + filtros */}
        <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar URL ou arquivo… (ex.: crediario, pdv, config)"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <FilterBtn id="todas" label="Todas" count={ROWS.length} />
            <FilterBtn id="atalho" label="Com atalho" count={ROWS.filter((r) => r.hasShortcut).length} />
            <FilterBtn id="sematalho" label="Sem atalho" count={ROWS.filter((r) => !r.hasShortcut).length} />
            <FilterBtn id="dinamicas" label="Dinâmicas [id]" count={ROWS.filter((r) => r.dynamic).length} />
          </div>
        </div>

        {/* Tabela agrupada */}
        <div className="space-y-4">
          {grouped.map(([section, rows]) => (
            <div key={section} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  /{section === '(home)' ? '' : section}
                </span>
                <span className="text-[11px] text-slate-400">{rows.length} tela{rows.length > 1 ? 's' : ''}</span>
              </div>
              <div className="divide-y divide-slate-50">
                {rows.map((r) => (
                  <div key={r.route} className="px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50">
                    {/* flag atalho */}
                    {r.hasShortcut ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 shrink-0" title="Tem botão/atalho apontando">
                        <Link2 className="w-3 h-3" /> atalho
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5 shrink-0" title="Só acessível por URL digitada">
                        <Link2Off className="w-3 h-3" /> sem atalho
                      </span>
                    )}
                    {/* rota */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="text-sm text-slate-800 font-mono truncate">{r.route}</code>
                        {r.dynamic && (
                          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">dinâmica</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono truncate">{r.file}</div>
                    </div>
                    {/* abrir (só rotas estáticas) */}
                    {!r.dynamic ? (
                      <Link
                        href={r.route}
                        target="_blank"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
                        title="Abrir em nova aba"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Link>
                    ) : (
                      <span className="w-7 shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {grouped.length === 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400">
              Nenhuma URL pra esse filtro.
            </div>
          )}
        </div>

        {/* Rodapé: como atualizar */}
        <div className="text-[11px] text-slate-400 flex items-start gap-1.5 px-1">
          <RefreshCcw className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Dados gerados{genAt ? ` em ${genAt.toLocaleString('pt-BR')}` : ''}. Pra atualizar depois de criar/remover
            telas ou atalhos, rode <code className="bg-slate-100 px-1 rounded">node scripts/gen-routes-map.mjs</code> em <code className="bg-slate-100 px-1 rounded">frontend/</code> e faça deploy.
          </span>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'slate' | 'emerald' | 'rose' }) {
  const tones = {
    slate: 'text-slate-800',
    emerald: 'text-emerald-700',
    rose: 'text-rose-600',
  };
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
      <div className={`text-2xl font-black ${tones[tone]}`}>{value}</div>
      <div className="text-[11px] text-slate-500 uppercase tracking-wider">{label}</div>
    </div>
  );
}
