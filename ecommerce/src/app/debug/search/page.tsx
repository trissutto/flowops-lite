'use client';

/**
 * PAINEL DE BUSCA — o que a cliente procura, em números.
 *
 * Quatro leituras, da mais estratégica pra mais operacional:
 *   VOLUME      — quanto a busca é usada (e o CTR global: resultado bom?);
 *   TOP TERMOS  — o retrato da demanda real, com CTR por termo;
 *   ZERO RESULTS — a lista de OURO do merchandising: procuraram e NÃO tinha.
 *                  Cada linha aqui é compra que escapou ou sinônimo faltando;
 *   SEM CLIQUE  — teve resultado e ninguém clicou: ranking ruim ou preço.
 *
 * Mesma estética e mecânica do /debug/tracking (token compartilhado via
 * sessionStorage, polling, 404 sem TRACKING_DEBUG_TOKEN em produção).
 */

import { useCallback, useEffect, useState } from 'react';

const TOKEN_KEY = 'lurds_debug_token';
const POLL_MS = 5_000;

interface TermRow {
  term: string;
  searches: number;
  zeroResults: number;
  clicks: number;
  lastResults: number;
  lastAt: string;
  ctr: number;
}

interface MetricsPayload {
  volume: { pesquisas: number; cliques: number; zeroResults: number; termos: number; ctrGlobal: number };
  topTermos: TermRow[];
  zeroResults: TermRow[];
  semClique: TermRow[];
}

export default function SearchDebugPage() {
  const [token, setToken] = useState('');
  const [dados, setDados] = useState<MetricsPayload | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aoVivo, setAoVivo] = useState(true);

  useEffect(() => {
    setToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
  }, []);

  const buscar = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (token) qs.set('token', token);
      const res = await fetch(`/api/search-metrics?${qs}`, { cache: 'no-store' });
      if (res.status === 404) {
        setErro('Token inválido ou rota desabilitada. Configure TRACKING_DEBUG_TOKEN.');
        return;
      }
      if (!res.ok) {
        setErro(`Falha ao ler métricas (HTTP ${res.status})`);
        return;
      }
      setDados((await res.json()) as MetricsPayload);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha de rede');
    }
  }, [token]);

  useEffect(() => {
    void buscar();
    if (!aoVivo) return;
    const id = setInterval(() => void buscar(), POLL_MS);
    return () => clearInterval(id);
  }, [buscar, aoVivo]);

  const volume = dados?.volume;
  const pctCtr = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 font-mono text-[13px]">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight text-white">Busca · Debug</h1>
        <span
          className={`rounded px-2 py-0.5 text-[11px] ${aoVivo ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-white/50'}`}
        >
          {aoVivo ? '● ao vivo' : '‖ pausado'}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              sessionStorage.setItem(TOKEN_KEY, e.target.value);
            }}
            placeholder="TRACKING_DEBUG_TOKEN"
            className="w-52 rounded border border-white/15 bg-white/5 px-2.5 py-1.5 text-white placeholder:text-white/30"
          />
          <Botao onClick={() => setAoVivo((v) => !v)}>{aoVivo ? 'Pausar' : 'Retomar'}</Botao>
          <Botao
            onClick={async () => {
              await fetch(`/api/search-metrics?token=${token}`, { method: 'DELETE' });
              void buscar();
            }}
          >
            Limpar
          </Botao>
        </div>
      </header>

      {erro && (
        <p className="mb-5 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">{erro}</p>
      )}

      {/* Volume */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Metrica rotulo="Pesquisas" valor={volume?.pesquisas ?? 0} />
        <Metrica rotulo="Cliques" valor={volume?.cliques ?? 0} tom="ok" />
        <Metrica rotulo="CTR global" valor={pctCtr(volume?.ctrGlobal ?? 0)} tom={(volume?.ctrGlobal ?? 0) < 0.2 && (volume?.pesquisas ?? 0) > 20 ? 'alerta' : undefined} />
        <Metrica rotulo="Zero results" valor={volume?.zeroResults ?? 0} tom={volume?.zeroResults ? 'ruim' : undefined} />
        <Metrica rotulo="Termos únicos" valor={volume?.termos ?? 0} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top termos */}
        <section>
          <h2 className="mb-2 text-white/80">Top 20 termos ({dados?.topTermos.length ?? 0})</h2>
          <TabelaTermos linhas={dados?.topTermos ?? []} vazio="Nenhuma pesquisa registrada — busque na loja pra gerar dados." />
        </section>

        {/* Zero results — a lista de ouro */}
        <section>
          <h2 className="mb-2 text-amber-300">
            Zero results ({dados?.zeroResults.length ?? 0}) — a lista de ouro do merchandising
          </h2>
          <div className="max-h-[32rem] overflow-auto rounded border border-amber-500/25 bg-black/30">
            {(dados?.zeroResults ?? []).map((linha) => (
              <div key={linha.term} className="flex items-center gap-3 border-b border-white/5 px-3 py-1.5">
                <span className="text-amber-200">{linha.term}</span>
                <span className="ml-auto shrink-0 text-white/40">
                  {linha.zeroResults}× sem resultado · {linha.searches} buscas
                </span>
              </div>
            ))}
            {(dados?.zeroResults ?? []).length === 0 && (
              <p className="px-3 py-4 text-white/40">Nenhum termo sem resultado. Ótimo sinal.</p>
            )}
          </div>
          <p className="mt-2 text-[11px] text-white/40">
            Cada linha é demanda sem oferta: peça que falta no catálogo ou sinônimo que falta no dicionário
            (src/lib/search/synonyms.ts).
          </p>
        </section>
      </div>

      {/* Sem clique */}
      <section className="mt-8">
        <h2 className="mb-2 text-white/80">Buscas com resultado e sem clique ({dados?.semClique.length ?? 0})</h2>
        <TabelaTermos
          linhas={dados?.semClique ?? []}
          vazio="Nenhum termo com resultado ignorado."
        />
        <p className="mt-2 text-[11px] text-white/40">
          Teve resultado e ninguém clicou: ranking mostrando a peça errada, foto fraca ou preço fora — investigar
          termo a termo antes de mexer nos boosts.
        </p>
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function Botao({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-white/15 px-3 py-1.5 text-white/80 hover:bg-white/10"
    >
      {children}
    </button>
  );
}

function Metrica({ rotulo, valor, tom }: { rotulo: string; valor: number | string; tom?: 'ok' | 'ruim' | 'alerta' }) {
  const cor =
    tom === 'ok' ? 'text-emerald-300' : tom === 'ruim' ? 'text-red-300' : tom === 'alerta' ? 'text-amber-300' : 'text-white';
  return (
    <div className="rounded border border-white/10 bg-white/5 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{rotulo}</div>
      <div className={`mt-0.5 text-lg font-semibold ${cor}`}>{valor}</div>
    </div>
  );
}

function TabelaTermos({ linhas, vazio }: { linhas: TermRow[]; vazio: string }) {
  return (
    <div className="max-h-[32rem] overflow-auto rounded border border-white/10 bg-black/30">
      <table className="w-full text-left">
        <thead className="sticky top-0 bg-[#0f0f12] text-[11px] uppercase tracking-wider text-white/40">
          <tr>
            <th className="px-3 py-2 font-normal">termo</th>
            <th className="px-3 py-2 text-right font-normal">buscas</th>
            <th className="px-3 py-2 text-right font-normal">cliques</th>
            <th className="px-3 py-2 text-right font-normal">CTR</th>
            <th className="px-3 py-2 text-right font-normal">últ. result.</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.term} className="border-t border-white/5">
              <td className="px-3 py-1.5 text-white">{linha.term}</td>
              <td className="px-3 py-1.5 text-right text-white/70">{linha.searches}</td>
              <td className="px-3 py-1.5 text-right text-white/70">{linha.clicks}</td>
              <td
                className={`px-3 py-1.5 text-right ${linha.ctr >= 0.3 ? 'text-emerald-300' : linha.ctr > 0 ? 'text-white/70' : 'text-white/35'}`}
              >
                {Math.round(linha.ctr * 100)}%
              </td>
              <td className={`px-3 py-1.5 text-right ${linha.lastResults === 0 ? 'text-amber-300' : 'text-white/50'}`}>
                {linha.lastResults}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {linhas.length === 0 && <p className="px-3 py-4 text-white/40">{vazio}</p>}
    </div>
  );
}
