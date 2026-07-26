'use client';

/**
 * /retaguarda/dre — Resultado (DRE) por loja.
 *
 * Traduz a "PLANILHA IDEAL" (modelo SEBRAE/SP) pro Flow, com o que os
 * sistemas de varejo sérios fazem e a planilha não faz:
 *   - resultado 4-WALL (só o que a loja controla) separado do rateio da rede;
 *   - toda linha abre em DRILL-DOWN (venda a venda, conta a conta);
 *   - ponto de equilíbrio como DIA DO MÊS ("virou o mês no dia 22"), não só R$;
 *   - aviso explícito quando o número é ESTIMADO (CMV sem custo carimbado,
 *     CNPJ sem alíquota, loja sem despesa lançada).
 *
 * Admin/master apenas. Competência: despesa entra pelo VENCIMENTO.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, BarChart3, Loader2, RefreshCw, Settings, AlertTriangle,
  ChevronRight, Plus, Trash2, X, Percent, Target,
} from 'lucide-react';
import { api } from '@/lib/api';

// ── formatação ──────────────────────────────────────────────────────────────
const brl = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCurto = (n: number | null | undefined) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1_000_000) return `${v < 0 ? '-' : ''}R$ ${(Math.abs(v) / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${v < 0 ? '-' : ''}R$ ${(Math.abs(v) / 1_000).toFixed(1)}k`;
  return brl(v);
};
const pct = (n: number | null | undefined, casas = 1) =>
  n == null ? '—' : `${(Number(n) * 100).toFixed(casas)}%`;
const fmtDia = (iso?: string | null) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : null);
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Coluna = {
  key: string; label: string; grupo: 'LOJA' | 'CANAL'; cnpj: string | null;
  faturamentoBruto: number; devolucoes: number; receitaLiquida: number;
  cmv: number; margemBruta: number; margemBrutaPct: number;
  impostos: number; aliquotaPct: number | null; despesasVariaveis: number;
  margemContribuicao: number; margemContribuicaoPct: number;
  despesasFixas: number; resultado4Wall: number; resultado4WallPct: number;
  rateioRede: number; despesasFinanceiras: number; resultadoLiquido: number;
  lucratividade: number;
  pontoEquilibrio: number | null; pontoEquilibrioDia: string | null; faltaPraEquilibrio: number | null;
  cupons: number; pecas: number; ticketMedio: number;
  avisos: string[]; cmvEstimadoPct: number;
};

type Resultado = {
  de: string; ate: string; mesRef: string;
  total: Coluna; colunas: Coluna[];
  rede: { despesaTotal: number; lojas: string[]; criterioRateio: string };
  config: {
    markupFallback: number;
    lojasSemGrupo: string[];
    especiesSemGrupo: number;
    contasSemEspecie: { valor: number; lojas: string[] };
  };
  fonte: string;
};

/** Linhas da DRE, na ordem da planilha. `drill` = linha que abre detalhe. */
const LINHAS: Array<{
  campo: keyof Coluna; label: string; tipo: 'receita' | 'deducao' | 'subtotal' | 'resultado';
  pctCampo?: keyof Coluna; drill?: string; nota?: string;
}> = [
  { campo: 'faturamentoBruto', label: '( + ) Faturamento bruto', tipo: 'receita', drill: 'FATURAMENTO' },
  { campo: 'devolucoes', label: '( - ) Devoluções', tipo: 'deducao' },
  { campo: 'receitaLiquida', label: '( = ) Receita líquida', tipo: 'subtotal' },
  { campo: 'cmv', label: '( - ) CMV (custo das peças vendidas)', tipo: 'deducao' },
  { campo: 'margemBruta', label: '( = ) Margem bruta', tipo: 'subtotal', pctCampo: 'margemBrutaPct' },
  { campo: 'impostos', label: '( - ) Impostos', tipo: 'deducao', nota: 'Alíquota efetiva por CNPJ' },
  { campo: 'despesasVariaveis', label: '( - ) Despesas variáveis', tipo: 'deducao', drill: 'VARIAVEL' },
  { campo: 'margemContribuicao', label: '( = ) Margem de contribuição', tipo: 'subtotal', pctCampo: 'margemContribuicaoPct' },
  { campo: 'despesasFixas', label: '( - ) Despesas fixas da loja', tipo: 'deducao', drill: 'FIXA' },
  { campo: 'resultado4Wall', label: '( = ) RESULTADO 4-WALL', tipo: 'resultado', pctCampo: 'resultado4WallPct', nota: 'Só o que a loja controla' },
  { campo: 'rateioRede', label: '( - ) Rateio da rede', tipo: 'deducao', nota: 'Matriz, rateada por faturamento' },
  { campo: 'despesasFinanceiras', label: '( - ) Despesas financeiras', tipo: 'deducao', drill: 'FINANCEIRA' },
  { campo: 'resultadoLiquido', label: '( = ) LUCRO LÍQUIDO', tipo: 'resultado', pctCampo: 'lucratividade' },
];

export default function DrePage() {
  const [aba, setAba] = useState<'dre' | 'config'>('dre');
  const [toast, setToast] = useState<{ tipo: 'ok' | 'erro'; msg: string } | null>(null);
  const avisar = (tipo: 'ok' | 'erro', msg: string) => {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 4000);
  };

  return (
    <div className="min-h-screen bg-[#FAFAF7] text-slate-800">
      <header className="bg-white border-b border-[#E7E2D8] sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 hover:bg-[#FBF6E6] rounded-lg"><ArrowLeft className="w-5 h-5" /></Link>
          <BarChart3 className="w-6 h-6 text-[#B8912B]" />
          <div className="flex-1">
            <h1 className="text-lg font-extrabold">Resultado (DRE)</h1>
            <p className="text-xs text-slate-500">Por loja · competência (despesa pelo vencimento)</p>
          </div>
        </div>
        <div className="max-w-[1600px] mx-auto px-4 pb-2 flex gap-2">
          {([['dre', 'DRE', BarChart3], ['config', 'Configuração', Settings]] as any[]).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setAba(k)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 border ${
                aba === k ? 'bg-[#B8912B] border-[#B8912B] text-white' : 'bg-white border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6]'
              }`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 py-5">
        {aba === 'dre' ? <AbaDre avisar={avisar} /> : <AbaConfig avisar={avisar} />}
      </main>

      {toast && (
        <div className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-bold text-white ${toast.tipo === 'ok' ? 'bg-[#2E7D46]' : 'bg-rose-600'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ABA DRE
// ════════════════════════════════════════════════════════════════════════════

function AbaDre({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const hoje = new Date();
  const [de, setDe] = useState(iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)));
  const [ate, setAte] = useState(iso(hoje));
  const [data, setData] = useState<Resultado | null>(null);
  const [loading, setLoading] = useState(false);
  const [verPct, setVerPct] = useState(false);
  const [drill, setDrill] = useState<{ coluna: Coluna; linha: string; label: string } | null>(null);

  const carregar = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return;
    setLoading(true);
    try {
      setData(await api<Resultado>(`/dre/resultado?de=${de}&ate=${ate}`));
    } catch (e: any) {
      avisar('erro', e?.message || 'Falha ao carregar a DRE');
    } finally {
      setLoading(false);
    }
  }, [de, ate, avisar]);
  useEffect(() => { carregar(); }, [carregar]);

  const atalho = (qual: 'hoje' | 'ontem' | '7' | 'mes' | 'mesPassado') => {
    const h = new Date();
    if (qual === 'hoje') { setDe(iso(h)); setAte(iso(h)); }
    else if (qual === 'ontem') { const o = new Date(h.getTime() - 86400000); setDe(iso(o)); setAte(iso(o)); }
    else if (qual === '7') { setDe(iso(new Date(h.getTime() - 6 * 86400000))); setAte(iso(h)); }
    else if (qual === 'mes') { setDe(iso(new Date(h.getFullYear(), h.getMonth(), 1))); setAte(iso(h)); }
    else {
      setDe(iso(new Date(h.getFullYear(), h.getMonth() - 1, 1)));
      setAte(iso(new Date(h.getFullYear(), h.getMonth(), 0)));
    }
  };

  const colunas = data?.colunas || [];
  const total = data?.total;

  return (
    <div className="space-y-4">
      {/* Filtro */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-slate-500">De</span>
        <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
          className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] bg-white" />
        <span className="font-semibold text-slate-500">Até</span>
        <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
          className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] bg-white" />
        <div className="flex gap-1.5 ml-1">
          {([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7', '7 dias'], ['mes', 'Mês'], ['mesPassado', 'Mês passado']] as const).map(([k, l]) => (
            <button key={k} onClick={() => atalho(k)}
              className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600 text-xs">
              {l}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button onClick={() => setVerPct((v) => !v)}
          className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 ${
            verPct ? 'bg-[#B8912B] border-[#B8912B] text-white' : 'bg-white border-[#E7E2D8] text-slate-600 hover:bg-[#FBF6E6]'
          }`}>
          <Percent className="w-3.5 h-3.5" /> % da receita
        </button>
        <button onClick={carregar} disabled={loading}
          className="px-3 py-1.5 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-xs font-semibold flex items-center gap-1.5">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Atualizar
        </button>
      </div>

      {loading && !data && (
        <div className="py-20 text-center text-slate-400"><Loader2 className="w-8 h-8 animate-spin mx-auto" /></div>
      )}

      {data && total && (
        <>
          {/* KPIs do consolidado */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi titulo="Receita líquida" valor={brl(total.receitaLiquida)} sub={`${total.cupons} cupons · ${total.pecas} peças`} />
            <Kpi titulo="Margem de contribuição" valor={pct(total.margemContribuicaoPct)} sub={brl(total.margemContribuicao)} />
            <Kpi titulo="Resultado 4-wall" valor={brl(total.resultado4Wall)} sub={pct(total.resultado4WallPct)}
              tom={total.resultado4Wall >= 0 ? 'verde' : 'vermelho'} />
            <Kpi titulo="Lucro líquido" valor={brl(total.resultadoLiquido)} sub={`Lucratividade ${pct(total.lucratividade)}`}
              tom={total.resultadoLiquido >= 0 ? 'verde' : 'vermelho'} />
            <Kpi
              titulo="Ponto de equilíbrio"
              valor={total.pontoEquilibrio ? brl(total.pontoEquilibrio) : '—'}
              sub={
                total.pontoEquilibrio == null ? 'sem despesa fixa lançada'
                  : total.faltaPraEquilibrio ? `faltam ${brl(total.faltaPraEquilibrio)}`
                  : 'atingido no período'
              }
              tom={total.pontoEquilibrio && !total.faltaPraEquilibrio ? 'verde' : 'neutro'}
            />
          </div>

          <Waterfall total={total} />

          {/* Tabela DRE */}
          <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#FBF6E6] border-b border-[#E7E2D8]">
                    <th className="text-left px-3 py-2.5 font-extrabold text-slate-700 sticky left-0 bg-[#FBF6E6] min-w-[280px]">
                      Demonstrativo de Resultados
                    </th>
                    <th className="text-right px-3 py-2.5 font-extrabold text-slate-700 min-w-[120px] border-l border-[#E7E2D8]">
                      TOTAL REDE
                    </th>
                    {colunas.map((c) => (
                      <th key={c.key} className="text-right px-3 py-2.5 font-bold text-slate-600 min-w-[120px]">
                        <div className="flex items-center justify-end gap-1">
                          {c.avisos.length > 0 && (
                            <span title={c.avisos.join('\n')}>
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                            </span>
                          )}
                          {c.label}
                        </div>
                        <div className="text-[10px] font-semibold text-slate-400">
                          {c.grupo === 'CANAL' ? 'canal digital' : 'loja'}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {LINHAS.map((l) => (
                    <tr key={String(l.campo)} className={
                      l.tipo === 'resultado' ? 'bg-[#F4F8F5] border-y border-[#E7E2D8] font-extrabold'
                        : l.tipo === 'subtotal' ? 'bg-slate-50 font-bold border-y border-[#F0EDE6]'
                        : 'hover:bg-[#FBF6E6]/40 border-b border-[#F5F2EB]'
                    }>
                      <td className="px-3 py-2 sticky left-0 bg-inherit">
                        <span>{l.label}</span>
                        {l.nota && <span className="ml-2 text-[10px] font-normal text-slate-400">{l.nota}</span>}
                      </td>
                      <td className="text-right px-3 py-2 border-l border-[#E7E2D8] tabular-nums">
                        <Celula coluna={total} linha={l} verPct={verPct} />
                      </td>
                      {colunas.map((c) => (
                        <td key={c.key} className="text-right px-3 py-2 tabular-nums">
                          {l.drill ? (
                            <button
                              onClick={() => setDrill({ coluna: c, linha: l.drill!, label: l.label })}
                              className="hover:underline decoration-dotted underline-offset-2"
                              title="Ver detalhe"
                            >
                              <Celula coluna={c} linha={l} verPct={verPct} />
                            </button>
                          ) : (
                            <Celula coluna={c} linha={l} verPct={verPct} />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}

                  {/* Indicadores */}
                  <tr className="bg-[#FBF6E6]/60 border-t-2 border-[#E7E2D8]">
                    <td className="px-3 py-2 sticky left-0 bg-[#FBF6E6] font-extrabold text-slate-700">
                      <span className="flex items-center gap-1.5"><Target className="w-4 h-4 text-[#B8912B]" /> Indicadores</span>
                    </td>
                    <td className="border-l border-[#E7E2D8]" />
                    <td colSpan={colunas.length} />
                  </tr>
                  <LinhaIndicador label="Ponto de equilíbrio (R$)" total={total} colunas={colunas}
                    valor={(c) => (c.pontoEquilibrio ? brl(c.pontoEquilibrio) : '—')} />
                  <LinhaIndicador label="Virou o mês no dia" total={total} colunas={colunas}
                    valor={(c) => fmtDia(c.pontoEquilibrioDia) || (c.faltaPraEquilibrio ? `faltam ${brlCurto(c.faltaPraEquilibrio)}` : '—')} />
                  <LinhaIndicador label="Ticket médio" total={total} colunas={colunas}
                    valor={(c) => brl(c.ticketMedio)} />
                  <LinhaIndicador label="Peças vendidas" total={total} colunas={colunas}
                    valor={(c) => String(c.pecas || 0)} />
                  <LinhaIndicador label="Alíquota de imposto" total={total} colunas={colunas}
                    valor={(c) => (c.aliquotaPct == null ? 'não cadastrada' : `${Number(c.aliquotaPct).toFixed(2)}%`)} />
                </tbody>
              </table>
            </div>
          </div>

          <Qualidade data={data} />
        </>
      )}

      {drill && <DrillModal de={de} ate={ate} alvo={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

function Celula({ coluna, linha, verPct }: { coluna: Coluna; linha: typeof LINHAS[number]; verPct: boolean }) {
  const v = Number(coluna[linha.campo] || 0);
  if (verPct) {
    const base = coluna.receitaLiquida || 0;
    if (!base) return <span className="text-slate-300">—</span>;
    const p = linha.pctCampo ? Number(coluna[linha.pctCampo] || 0) : v / base;
    return <span className={p < 0 ? 'text-rose-600' : ''}>{pct(p)}</span>;
  }
  if (!v) return <span className="text-slate-300">—</span>;
  const negativo = linha.tipo === 'deducao';
  return (
    <span className={v < 0 ? 'text-rose-600' : linha.tipo === 'resultado' ? 'text-[#2E7D46]' : ''}>
      {negativo ? `(${brl(v)})` : brl(v)}
    </span>
  );
}

function LinhaIndicador({
  label, total, colunas, valor,
}: { label: string; total: Coluna; colunas: Coluna[]; valor: (c: Coluna) => string }) {
  return (
    <tr className="border-b border-[#F5F2EB] text-xs">
      <td className="px-3 py-1.5 sticky left-0 bg-white text-slate-500 font-semibold">{label}</td>
      <td className="text-right px-3 py-1.5 border-l border-[#E7E2D8] font-bold tabular-nums">{valor(total)}</td>
      {colunas.map((c) => (
        <td key={c.key} className="text-right px-3 py-1.5 tabular-nums text-slate-600">{valor(c)}</td>
      ))}
    </tr>
  );
}

function Kpi({ titulo, valor, sub, tom = 'neutro' }: {
  titulo: string; valor: string; sub?: string; tom?: 'neutro' | 'verde' | 'vermelho';
}) {
  const cor = tom === 'verde' ? 'text-[#2E7D46]' : tom === 'vermelho' ? 'text-rose-600' : 'text-slate-800';
  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl px-4 py-3">
      <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{titulo}</div>
      <div className={`text-xl font-extrabold mt-0.5 ${cor}`}>{valor}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * Cascata (waterfall) do consolidado — mostra ONDE o dinheiro sai, do
 * faturamento até o lucro. É a leitura que a tabela sozinha não dá.
 */
function Waterfall({ total }: { total: Coluna }) {
  const base = total.faturamentoBruto || 1;
  const etapas = [
    { label: 'Faturamento', valor: total.faturamentoBruto, tipo: 'base' as const },
    { label: 'Devoluções', valor: -total.devolucoes, tipo: 'saida' as const },
    { label: 'CMV', valor: -total.cmv, tipo: 'saida' as const },
    { label: 'Impostos', valor: -total.impostos, tipo: 'saida' as const },
    { label: 'Var.', valor: -total.despesasVariaveis, tipo: 'saida' as const },
    { label: 'Fixas', valor: -total.despesasFixas, tipo: 'saida' as const },
    { label: 'Rede', valor: -total.rateioRede, tipo: 'saida' as const },
    { label: 'Financ.', valor: -total.despesasFinanceiras, tipo: 'saida' as const },
    { label: 'Lucro', valor: total.resultadoLiquido, tipo: 'final' as const },
  ].filter((e) => e.tipo !== 'saida' || Math.abs(e.valor) > 0.005);

  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
      <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-3">
        Do faturamento ao lucro · rede consolidada
      </div>
      <div className="flex items-end gap-2 h-40">
        {etapas.map((e) => {
          const h = Math.min(100, (Math.abs(e.valor) / base) * 100);
          const cor = e.tipo === 'base' ? 'bg-slate-300'
            : e.tipo === 'final' ? (e.valor >= 0 ? 'bg-[#2E7D46]' : 'bg-rose-500')
            : 'bg-[#D4AF37]';
          return (
            <div key={e.label} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
              <div className="text-[10px] font-bold text-slate-600 mb-1 whitespace-nowrap">{brlCurto(Math.abs(e.valor))}</div>
              <div className={`${cor} w-full rounded-t`} style={{ height: `${Math.max(2, h)}%` }} />
              <div className="text-[10px] font-semibold text-slate-500 mt-1 truncate w-full text-center">{e.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Avisos de qualidade do dado — o painel diz onde ele está chutando. */
function Qualidade({ data }: { data: Resultado }) {
  const itens: string[] = [];
  if (data.config.lojasSemGrupo.length) {
    itens.push(
      `${data.config.lojasSemGrupo.length} loja(s) sem papel definido na DRE (${data.config.lojasSemGrupo.join(', ')}) — ` +
      'estão entrando pela heurística de nome. Defina em Configuração.',
    );
  }
  if (data.config.especiesSemGrupo) {
    itens.push(
      `${data.config.especiesSemGrupo} espécie(s) de conta sem classificação — entraram como despesa FIXA por padrão.`,
    );
  }
  if (data.config.contasSemEspecie.valor > 0) {
    itens.push(
      `${brl(data.config.contasSemEspecie.valor)} em contas SEM espécie caíram em despesa fixa ` +
      `(lojas: ${data.config.contasSemEspecie.lojas.join(', ') || '—'}).`,
    );
  }
  if (!data.rede.lojas.length) {
    itens.push(
      'Nenhuma loja marcada como REDE — o rateio da matriz está zerado e o lucro líquido ' +
      'é igual ao 4-wall. Marque a matriz em Configuração.',
    );
  }
  const colunasComAviso = data.colunas.filter((c) => c.avisos.length);

  if (!itens.length && !colunasComAviso.length) return null;

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm">
      <div className="font-extrabold text-amber-800 flex items-center gap-1.5 mb-2">
        <AlertTriangle className="w-4 h-4" /> O que ainda está estimado
      </div>
      <ul className="space-y-1 text-amber-900 text-xs">
        {itens.map((t) => <li key={t}>• {t}</li>)}
        {colunasComAviso.map((c) => (
          <li key={c.key}>• <b>{c.label}</b>: {c.avisos.join(' · ')}</li>
        ))}
      </ul>
      <div className="text-[11px] text-amber-700 mt-2">
        Fonte: {data.fonte}. Venda lançada só no GIGA (WhatsApp antigo) não entra nesta DRE.
      </div>
    </div>
  );
}

// ── drill-down ──────────────────────────────────────────────────────────────

function DrillModal({
  de, ate, alvo, onClose,
}: { de: string; ate: string; alvo: { coluna: Coluna; linha: string; label: string }; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<any>(`/dre/drill?de=${de}&ate=${ate}&coluna=${encodeURIComponent(alvo.coluna.key)}&linha=${alvo.linha}`)
      .then(setData)
      .catch((e) => setErro(e?.message || 'Falha ao abrir o detalhe'));
  }, [de, ate, alvo]);

  const totalLinhas = useMemo(() => {
    if (!data?.linhas) return 0;
    return data.linhas.reduce((s: number, l: any) => s + Number(l.total ?? l.valor ?? 0), 0);
  }, [data]);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E7E2D8] flex items-center gap-3">
          <div className="flex-1">
            <h2 className="font-extrabold">{alvo.coluna.label}</h2>
            <p className="text-xs text-slate-500">{alvo.label} · {de} a {ate}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-[#FBF6E6] rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-auto p-4 text-sm">
          {erro && <div className="text-rose-600">{erro}</div>}
          {!data && !erro && <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-300" /></div>}

          {data?.tipo === 'faturamento' && (
            <table className="w-full">
              <thead><tr className="text-xs text-slate-500 border-b border-[#E7E2D8]">
                <th className="text-left py-1.5">Dia</th><th className="text-right">Cupons</th><th className="text-right">Faturamento</th>
              </tr></thead>
              <tbody>
                {data.linhas.map((l: any) => (
                  <tr key={l.dia} className="border-b border-[#F5F2EB]">
                    <td className="py-1.5">{fmtDia(l.dia)}</td>
                    <td className="text-right tabular-nums">{l.cupons}</td>
                    <td className="text-right tabular-nums font-semibold">{brl(l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data?.tipo === 'despesas' && (
            <>
              <table className="w-full">
                <thead><tr className="text-xs text-slate-500 border-b border-[#E7E2D8]">
                  <th className="text-left py-1.5">Vencimento</th><th className="text-left">Beneficiário</th>
                  <th className="text-left">Espécie</th><th className="text-right">Valor</th><th className="text-left pl-3">Status</th>
                </tr></thead>
                <tbody>
                  {data.linhas.map((l: any) => (
                    <tr key={l.id} className="border-b border-[#F5F2EB]">
                      <td className="py-1.5">{fmtDia(String(l.vencimento).slice(0, 10))}</td>
                      <td className="truncate max-w-[220px]">{l.beneficiario}</td>
                      <td className="text-slate-500">{l.especie}</td>
                      <td className="text-right tabular-nums font-semibold">{brl(l.valor)}</td>
                      <td className="pl-3 text-xs text-slate-500">{l.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.truncado && (
                <p className="text-xs text-amber-700 mt-2">
                  Mostrando as 500 primeiras contas do período — o total da DRE considera todas.
                </p>
              )}
            </>
          )}

          {data?.linhas?.length === 0 && <p className="text-slate-400 py-6 text-center">Nada no período.</p>}
        </div>
        {data?.linhas?.length > 0 && (
          <div className="px-5 py-2.5 border-t border-[#E7E2D8] text-sm font-extrabold flex justify-between">
            <span>Total listado</span><span className="tabular-nums">{brl(totalLinhas)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ABA CONFIGURAÇÃO
// ════════════════════════════════════════════════════════════════════════════

const AJUDA_LOJA: Record<string, string> = {
  LOJA: 'Loja física — vira coluna e é avaliada pelo resultado 4-wall',
  CANAL: 'LIVE/SITE — coluna própria; a peça sai da loja a preço de custo',
  REDE: 'Matriz — não é coluna; o que for lançado aqui é rateado por faturamento',
  FORA: 'Ignorada na DRE (CD, loja fechada, cadastro de teste)',
};
const AJUDA_ESPECIE: Record<string, string> = {
  VARIAVEL: 'Varia com a venda (comissão, taxa de cartão, frete)',
  FIXA: 'Fixa da loja (aluguel, folha, luz, contador)',
  FINANCEIRA: 'Juros, multa, IOF, encargo de empréstimo',
  CMV: 'Compra de mercadoria — NÃO entra (o CMV vem das peças vendidas)',
  IMPOSTO: 'DAS/Simples — NÃO entra (o imposto vem da alíquota por CNPJ)',
  IGNORAR: 'Transferência, adiantamento, aporte',
};

function AbaConfig({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const [cfg, setCfg] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [novaAliq, setNovaAliq] = useState({ cnpj: '', mes: new Date().toISOString().slice(0, 7), aliquotaPct: '', observacao: '' });

  const carregar = useCallback(async () => {
    setLoading(true);
    try { setCfg(await api<any>('/dre/config')); }
    catch (e: any) { avisar('erro', e?.message || 'Falha ao carregar'); }
    finally { setLoading(false); }
  }, [avisar]);
  useEffect(() => { carregar(); }, [carregar]);

  const salvarLoja = async (code: string, grupo: string) => {
    try { await api(`/dre/config/loja/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ grupo }) }); avisar('ok', `${code} → ${grupo}`); carregar(); }
    catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };
  const salvarEspecie = async (id: string, grupo: string) => {
    try { await api(`/dre/config/especie/${id}`, { method: 'PATCH', body: JSON.stringify({ grupo }) }); avisar('ok', 'Espécie classificada'); carregar(); }
    catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };
  const addAliquota = async () => {
    try {
      await api('/dre/config/aliquota', {
        method: 'POST',
        body: JSON.stringify({ ...novaAliq, aliquotaPct: Number(String(novaAliq.aliquotaPct).replace(',', '.')) }),
      });
      avisar('ok', 'Alíquota salva');
      setNovaAliq({ ...novaAliq, aliquotaPct: '', observacao: '' });
      carregar();
    } catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };
  const delAliquota = async (id: string) => {
    try { await api(`/dre/config/aliquota/${id}`, { method: 'DELETE' }); carregar(); }
    catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };

  if (loading && !cfg) return <div className="py-20 text-center"><Loader2 className="w-8 h-8 animate-spin mx-auto text-slate-300" /></div>;
  if (!cfg) return null;

  return (
    <div className="space-y-4">
      {/* Lojas */}
      <Bloco titulo="Papel de cada loja na DRE" subtitulo="Define quem é coluna, quem é canal digital e quem é despesa da rede a ratear">
        <div className="grid md:grid-cols-2 gap-2">
          {cfg.lojas.map((l: any) => (
            <div key={l.code} className="flex items-center gap-2 border border-[#E7E2D8] rounded-lg px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm truncate">{l.name} <span className="text-slate-400 font-normal">({l.code})</span></div>
                <div className="text-[11px] text-slate-400">
                  {l.cnpj ? `CNPJ ${l.cnpj}` : 'sem CNPJ cadastrado'}
                  {!l.configurado && ' · usando heurística'}
                </div>
              </div>
              <select
                value={l.dreGrupo || l.dreGrupoEfetivo}
                onChange={(e) => salvarLoja(l.code, e.target.value)}
                title={AJUDA_LOJA[l.dreGrupo || l.dreGrupoEfetivo]}
                className={`text-xs font-bold px-2 py-1.5 rounded-lg border ${
                  l.configurado ? 'border-[#E7E2D8] bg-white' : 'border-amber-300 bg-amber-50'
                }`}
              >
                {cfg.grupos.loja.map((g: string) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          ))}
        </div>
      </Bloco>

      {/* Alíquotas */}
      <Bloco titulo="Alíquota efetiva por CNPJ × mês" subtitulo="A faixa do Simples muda com o RBT12 — por isso não existe percentual único da rede">
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <Campo label="CNPJ">
            <input value={novaAliq.cnpj} onChange={(e) => setNovaAliq({ ...novaAliq, cnpj: e.target.value })}
              placeholder="00.000.000/0000-00" className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-52" />
          </Campo>
          <Campo label="Mês">
            <input type="month" value={novaAliq.mes} onChange={(e) => setNovaAliq({ ...novaAliq, mes: e.target.value })}
              className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm" />
          </Campo>
          <Campo label="Alíquota %">
            <input value={novaAliq.aliquotaPct} onChange={(e) => setNovaAliq({ ...novaAliq, aliquotaPct: e.target.value })}
              placeholder="7,30" className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-24" />
          </Campo>
          <Campo label="Observação">
            <input value={novaAliq.observacao} onChange={(e) => setNovaAliq({ ...novaAliq, observacao: e.target.value })}
              placeholder="ex: 3ª faixa" className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-48" />
          </Campo>
          <button onClick={addAliquota}
            className="bg-[#B8912B] hover:bg-[#8C7325] text-white font-bold px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Salvar
          </button>
        </div>
        {cfg.aliquotas.length === 0 ? (
          <p className="text-xs text-slate-400">Nenhuma alíquota cadastrada — o imposto está entrando como zero em todas as colunas.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-slate-500 border-b border-[#E7E2D8]">
              <th className="text-left py-1.5">CNPJ</th><th className="text-left">Mês</th>
              <th className="text-right">Alíquota</th><th className="text-left pl-3">Obs.</th><th />
            </tr></thead>
            <tbody>
              {cfg.aliquotas.map((a: any) => (
                <tr key={a.id} className="border-b border-[#F5F2EB]">
                  <td className="py-1.5 tabular-nums">{a.cnpj}</td>
                  <td>{a.mes}</td>
                  <td className="text-right tabular-nums font-semibold">{a.aliquotaPct.toFixed(2)}%</td>
                  <td className="pl-3 text-slate-500 text-xs">{a.observacao || '—'}</td>
                  <td className="text-right">
                    <button onClick={() => delAliquota(a.id)} className="p-1 hover:bg-rose-50 rounded text-rose-500">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[11px] text-slate-400 mt-2">
          Mês sem linha própria herda a alíquota mais recente anterior do mesmo CNPJ.
        </p>
      </Bloco>

      {/* Espécies */}
      <Bloco
        titulo="Classificação das espécies de conta"
        subtitulo="Onde cada tipo de despesa entra na DRE. Compra de mercadoria e DAS ficam FORA — entrariam duas vezes"
      >
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
          {cfg.especies.map((e: any) => (
            <div key={e.id} className="flex items-center gap-2 border border-[#E7E2D8] rounded-lg px-3 py-1.5">
              <div className="flex-1 min-w-0 text-sm font-semibold truncate">{e.nome}</div>
              <select
                value={e.dreGrupo || e.dreGrupoEfetivo}
                onChange={(ev) => salvarEspecie(e.id, ev.target.value)}
                title={AJUDA_ESPECIE[e.dreGrupo || e.dreGrupoEfetivo]}
                className={`text-[11px] font-bold px-2 py-1 rounded-lg border ${
                  e.configurado ? 'border-[#E7E2D8] bg-white' : 'border-amber-300 bg-amber-50'
                }`}
              >
                {cfg.grupos.especie.map((g: string) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          Fundo amarelo = ainda não confirmada por você (está valendo a classificação automática pelo nome).
        </p>
      </Bloco>
    </div>
  );
}

function Bloco({ titulo, subtitulo, children }: { titulo: string; subtitulo?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
      <div className="mb-3">
        <h2 className="font-extrabold text-slate-800 flex items-center gap-1.5">
          <ChevronRight className="w-4 h-4 text-[#B8912B]" /> {titulo}
        </h2>
        {subtitulo && <p className="text-xs text-slate-500 ml-5">{subtitulo}</p>}
      </div>
      {children}
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-bold text-slate-500 uppercase">{label}</span>
      {children}
    </label>
  );
}
