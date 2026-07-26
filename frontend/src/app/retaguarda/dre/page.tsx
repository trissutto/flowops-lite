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

import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, BarChart3, Loader2, RefreshCw, Settings, AlertTriangle,
  ChevronRight, Plus, Trash2, X, Percent, Target, ListTree, ClipboardList, Minimize2,
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
  devolucoesDinheiro: number; devolucoesTroca: number; ajustesNaVenda: number;
  cmv: number; margemBruta: number; margemBrutaPct: number;
  impostos: number; aliquotaPct: number | null; despesasVariaveis: number;
  margemContribuicao: number; margemContribuicaoPct: number;
  despesasFixas: number; resultado4Wall: number; resultado4WallPct: number;
  rateioRede: number; despesasFinanceiras: number; resultadoLiquido: number;
  lucratividade: number;
  pontoEquilibrio: number | null; pontoEquilibrioDia: string | null; faltaPraEquilibrio: number | null;
  cupons: number; pecas: number; ticketMedio: number;
  avisos: string[];
  despesasDetalhe: Array<{ especie: string; grupo: string; valor: number }>;
};

type Franquia = {
  code: string; name: string; faturamentoBruto: number;
  cupons: number; pecas: number; royalties: number; marketing: number;
};

type Resultado = {
  de: string; ate: string; mesRef: string;
  total: Coluna; colunas: Coluna[];
  franquias: {
    lojas: Franquia[]; faturamentoBruto: number; royalties: number; marketing: number;
    royaltiesPct: number; marketingPct: number; despesaLancada: number;
  };
  consolidadoDono: { resultadoRede: number; royaltiesFranquia: number; total: number };
  conciliacao: {
    faturamentoRede: number; faturamentoFranquias: number;
    faturamentoForaDaDre: number; lojasForaDaDre: string[]; totalGrupo: number;
  };
  rede: { despesaTotal: number; lojas: string[]; criterioRateio: string };
  despesaDescartada: {
    porEspecie: Array<{ especie: string; grupo: string; valor: number }>;
    semColuna: number; emFranquia: number; total: number;
    porAjuste: Array<{ descricao: string; valor: number }>;
  };
  planilha: {
    itens: Array<{ rubrica: string; grupo: string; valor: number; especies: string[]; presente: boolean }>;
    faltando: string[];
    foraDaPlanilha: Array<{ especie: string; valor: number }>;
  };
  ajustes: Array<{
    id: string; tipo: string; descricao: string; fornecedorMatch: string | null;
    valorMensal: number | null; percentual: number | null; grupo: string | null; lojasExcluidas: string | null;
  }>;
  config: {
    markup: number;
    aliquotaPadrao: number;
    lojasSemGrupo: string[];
    especiesSemGrupo: number;
    contasSemEspecie: { valor: number; lojas: string[] };
  };
  fonte: string;
};

/** Linhas da DRE, na ordem da planilha. `drill` = linha que abre detalhe. */
const LINHAS: Array<{
  campo: keyof Coluna; label: string; tipo: 'receita' | 'deducao' | 'subtotal' | 'resultado' | 'info';
  pctCampo?: keyof Coluna; drill?: string; nota?: string;
  /** Linha de despesa: abre detalhe por espécie deste grupo quando ligado. */
  grupoDespesa?: 'FIXA' | 'VARIAVEL' | 'FINANCEIRA';
}> = [
  { campo: 'faturamentoBruto', label: '( + ) Faturamento bruto', tipo: 'receita', drill: 'FATURAMENTO' },
  { campo: 'ajustesNaVenda', label: '( i ) Ajuste negativo dentro da venda', tipo: 'info', nota: 'JÁ abatido no faturamento acima — não subtrai de novo' },
  { campo: 'devolucoesDinheiro', label: '( - ) Devolução em dinheiro/pix', tipo: 'deducao', nota: 'Único que abate — a cliente levou o dinheiro' },
  { campo: 'devolucoesTroca', label: '( i ) Troca / vale gerado', tipo: 'info', nota: 'NÃO abate do faturamento (decisão do dono) — a peça nova entra cheia depois' },
  { campo: 'receitaLiquida', label: '( = ) Receita líquida', tipo: 'subtotal' },
  { campo: 'cmv', label: '( - ) CMV (custo das peças vendidas)', tipo: 'deducao', nota: 'Venda ÷ 2,65 (markup)' },
  { campo: 'margemBruta', label: '( = ) Margem bruta', tipo: 'subtotal', pctCampo: 'margemBrutaPct' },
  { campo: 'impostos', label: '( - ) Impostos', tipo: 'deducao', nota: '10% da receita líquida' },
  { campo: 'despesasVariaveis', label: '( - ) Despesas variáveis', tipo: 'deducao', drill: 'VARIAVEL', grupoDespesa: 'VARIAVEL' },
  { campo: 'margemContribuicao', label: '( = ) Margem de contribuição', tipo: 'subtotal', pctCampo: 'margemContribuicaoPct' },
  { campo: 'despesasFixas', label: '( - ) Despesas fixas da loja', tipo: 'deducao', drill: 'FIXA', grupoDespesa: 'FIXA' },
  { campo: 'resultado4Wall', label: '( = ) RESULTADO 4-WALL', tipo: 'resultado', pctCampo: 'resultado4WallPct', nota: 'Só o que a loja controla' },
  { campo: 'rateioRede', label: '( - ) Rateio da rede', tipo: 'deducao', nota: 'Matriz, rateada por faturamento' },
  { campo: 'despesasFinanceiras', label: '( - ) Despesas financeiras', tipo: 'deducao', drill: 'FINANCEIRA', grupoDespesa: 'FINANCEIRA' },
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

      {/* Sem max-w: a DRE tem uma coluna POR LOJA (~12) e travar em 1600px
          escondia metade da rede atrás do scroll. Painel de dado usa a tela toda. */}
      <main className="w-full px-4 py-5">
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
  const [verDetalhe, setVerDetalhe] = useState(false);
  // Compacto: sem "R$" e sem centavos, coluna de 84px. Liga SOZINHO quando a
  // rede não cabe na tela — a DRE tem uma coluna por loja e o dono precisa
  // ver TODAS de uma vez, não metade atrás do scroll.
  const [compactoManual, setCompactoManual] = useState<boolean | null>(null);
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
  // 8+ colunas já estouram um monitor de 1920 no formato cheio.
  const compacto = compactoManual ?? colunas.length > 7;

  // Espécies presentes em cada grupo de despesa (união de todas as colunas),
  // ordenadas pelo peso na rede — é o "de onde saiu o dinheiro".
  const especiesPorGrupo = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!total) return out;
    for (const d of total.despesasDetalhe || []) {
      (out[d.grupo] ||= []).push(d.especie);
    }
    return out;
  }, [total]);

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
        <button onClick={() => setCompactoManual(!compacto)}
          className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 ${
            compacto ? 'bg-[#B8912B] border-[#B8912B] text-white' : 'bg-white border-[#E7E2D8] text-slate-600 hover:bg-[#FBF6E6]'
          }`}
          title="Tira R$ e centavos pra caber a rede inteira na tela">
          <Minimize2 className="w-3.5 h-3.5" /> Compacto
        </button>
        <button onClick={() => setVerDetalhe((v) => !v)}
          className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 ${
            verDetalhe ? 'bg-[#B8912B] border-[#B8912B] text-white' : 'bg-white border-[#E7E2D8] text-slate-600 hover:bg-[#FBF6E6]'
          }`}
          title="Abre cada linha de despesa nas espécies que a compõem (aluguel, folha, energia…)">
          <ListTree className="w-3.5 h-3.5" /> Detalhar despesas
        </button>
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
          <Conciliacao data={data} />

          {/* KPIs — REDE (lojas próprias). Franquia tem bloco próprio. */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <Kpi titulo="Receita líquida" valor={brl(total.receitaLiquida)} sub={`${total.cupons} cupons · ${total.pecas} peças`} />
            <Kpi titulo="Margem de contribuição" valor={pct(total.margemContribuicaoPct)} sub={brl(total.margemContribuicao)} />
            <Kpi titulo="Resultado 4-wall" valor={brl(total.resultado4Wall)} sub={pct(total.resultado4WallPct)}
              tom={total.resultado4Wall >= 0 ? 'verde' : 'vermelho'} />
            <Kpi titulo="Lucro da rede" valor={brl(total.resultadoLiquido)} sub={`Lucratividade ${pct(total.lucratividade)}`}
              tom={total.resultadoLiquido >= 0 ? 'verde' : 'vermelho'} />
            <Kpi titulo={`Royalties franquia (${data.franquias.royaltiesPct}%)`}
              valor={brl(data.consolidadoDono.royaltiesFranquia)}
              sub={`sobre ${brlCurto(data.franquias.faturamentoBruto)} faturados`}
              tom={data.consolidadoDono.royaltiesFranquia > 0 ? 'verde' : 'neutro'} />
            <Kpi titulo="TOTAL DO DONO" valor={brl(data.consolidadoDono.total)}
              sub="lucro da rede + royalties"
              tom={data.consolidadoDono.total >= 0 ? 'verde' : 'vermelho'} />
          </div>

          <Waterfall total={total} />

          {/* Tabela DRE */}
          <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className={`w-full ${compacto ? 'text-xs' : 'text-sm'}`}>
                <thead>
                  <tr className="bg-[#FBF6E6] border-b border-[#E7E2D8]">
                    <th className={`text-left px-3 py-2.5 font-extrabold text-slate-700 sticky left-0 bg-[#FBF6E6] ${compacto ? 'min-w-[230px]' : 'min-w-[280px]'}`}>
                      Demonstrativo de Resultados
                      {compacto && <span className="block text-[10px] font-normal text-slate-400">valores em R$, sem centavos</span>}
                    </th>
                    <th className={`text-right ${compacto ? 'px-1.5' : 'px-3'} py-2.5 font-extrabold text-slate-700 ${compacto ? 'min-w-[84px]' : 'min-w-[120px]'} border-l border-[#E7E2D8]`}>
                      TOTAL REDE
                    </th>
                    {colunas.map((c) => (
                      <th key={c.key} className={`text-right ${compacto ? 'px-1.5' : 'px-3'} py-2.5 font-bold text-slate-600 ${compacto ? 'min-w-[84px]' : 'min-w-[120px]'}`}>
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
                    <React.Fragment key={String(l.campo)}>
                    <tr className={
                      l.tipo === 'resultado' ? 'bg-[#F4F8F5] border-y border-[#E7E2D8] font-extrabold'
                        : l.tipo === 'subtotal' ? 'bg-slate-50 font-bold border-y border-[#F0EDE6]'
                        : l.tipo === 'info' ? 'text-slate-400 italic border-b border-[#F5F2EB]'
                        : 'hover:bg-[#FBF6E6]/40 border-b border-[#F5F2EB]'
                    }>
                      <td className="px-3 py-2 sticky left-0 bg-inherit">
                        <span>{l.label}</span>
                        {l.nota && <span className="ml-2 text-[10px] font-normal text-slate-400">{l.nota}</span>}
                      </td>
                      <td className="text-right px-3 py-2 border-l border-[#E7E2D8] tabular-nums">
                        <Celula coluna={total} linha={l} verPct={verPct} compacto={compacto} />
                      </td>
                      {colunas.map((c) => (
                        <td key={c.key} className="text-right px-3 py-2 tabular-nums">
                          {l.drill ? (
                            <button
                              onClick={() => setDrill({ coluna: c, linha: l.drill!, label: l.label })}
                              className="hover:underline decoration-dotted underline-offset-2"
                              title="Ver detalhe"
                            >
                              <Celula coluna={c} linha={l} verPct={verPct} compacto={compacto} />
                            </button>
                          ) : (
                            <Celula coluna={c} linha={l} verPct={verPct} compacto={compacto} />
                          )}
                        </td>
                      ))}
                    </tr>
                    {/* Detalhe por espécie — responde "o que entrou como despesa" */}
                    {verDetalhe && l.grupoDespesa && (especiesPorGrupo[l.grupoDespesa] || []).map((esp) => (
                      <tr key={`${String(l.campo)}-${esp}`} className="text-xs bg-white/60">
                        <td className="pl-9 pr-3 py-1 sticky left-0 bg-white text-slate-500">↳ {esp}</td>
                        <td className="text-right px-3 py-1 border-l border-[#E7E2D8] tabular-nums text-slate-600">
                          {valorEspecie(total, l.grupoDespesa!, esp)}
                        </td>
                        {colunas.map((c) => (
                          <td key={c.key} className="text-right px-3 py-1 tabular-nums text-slate-500">
                            {valorEspecie(c, l.grupoDespesa!, esp)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    </React.Fragment>
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

          <BlocoFranquias data={data} />
          <CoberturaPlanilha data={data} />
          <Qualidade data={data} />
        </>
      )}

      {drill && <DrillModal de={de} ate={ate} alvo={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

/** Valor de UMA espécie dentro de uma coluna (linha de detalhe da despesa). */
function valorEspecie(coluna: Coluna, grupo: string, especie: string) {
  const hit = (coluna.despesasDetalhe || []).find((d) => d.grupo === grupo && d.especie === especie);
  if (!hit || !hit.valor) return <span className="text-slate-300">—</span>;
  return <>{brl(hit.valor)}</>;
}

/** No modo compacto some o "R$" e os centavos — é o que faz a rede caber. */
const valorTabela = (v: number, compacto: boolean) =>
  compacto ? Math.round(v).toLocaleString('pt-BR') : brl(v);

function Celula({ coluna, linha, verPct, compacto = false }: {
  coluna: Coluna; linha: typeof LINHAS[number]; verPct: boolean; compacto?: boolean;
}) {
  const v = Number(coluna[linha.campo] || 0);
  if (verPct) {
    const base = coluna.receitaLiquida || 0;
    if (!base) return <span className="text-slate-300">—</span>;
    const p = linha.pctCampo ? Number(coluna[linha.pctCampo] || 0) : v / base;
    return <span className={p < 0 ? 'text-rose-600' : ''}>{pct(p)}</span>;
  }
  if (!v) return <span className="text-slate-300">—</span>;
  // Linha informativa não leva parênteses: ela NÃO está sendo subtraída aqui.
  if (linha.tipo === 'info') return <span className="text-slate-400">{valorTabela(v, compacto)}</span>;
  const negativo = linha.tipo === 'deducao';
  return (
    <span className={v < 0 ? 'text-rose-600' : linha.tipo === 'resultado' ? 'text-[#2E7D46]' : ''}>
      {negativo ? `(${valorTabela(v, compacto)})` : valorTabela(v, compacto)}
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

/**
 * Fecha a conta contra a tela "Faturamento por Loja". As duas telas leem a
 * MESMA fonte (caixa do Giga); a DRE só mostra as lojas próprias, então o
 * total dela é menor de propósito. Esta faixa mostra a soma completa pra
 * ninguém precisar desconfiar de qual número está certo.
 */
function Conciliacao({ data }: { data: Resultado }) {
  const c = data.conciliacao;
  const temFranquia = c.faturamentoFranquias > 0;
  const temFora = c.faturamentoForaDaDre > 0;
  if (!temFranquia && !temFora) return null;

  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl px-4 py-3 text-sm">
      <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">
        Conciliação com a tela “Faturamento por Loja”
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
        <Parcela label="Rede (lojas próprias)" valor={c.faturamentoRede} />
        {temFranquia && <><span className="text-slate-400">+</span>
          <Parcela label="Franquias" valor={c.faturamentoFranquias} /></>}
        {temFora && <><span className="text-slate-400">+</span>
          <Parcela label="Fora da DRE" valor={c.faturamentoForaDaDre} alerta /></>}
        <span className="text-slate-400">=</span>
        <Parcela label="Total do grupo" valor={c.totalGrupo} forte />
      </div>
      <p className="text-[11px] text-slate-400 mt-2">
        A DRE mostra o resultado das <b>lojas próprias</b>. Franquia entra só pelos royalties —
        o faturamento dela não é receita sua.
        {temFora && ` Fora da DRE (depósito/CD ou marcada FORA): ${c.lojasForaDaDre.join(', ')}.`}
      </p>
    </div>
  );
}

function Parcela({ label, valor, forte, alerta }: {
  label: string; valor: number; forte?: boolean; alerta?: boolean;
}) {
  return (
    <span className={`px-2.5 py-1 rounded-lg border ${
      forte ? 'bg-[#FBF6E6] border-[#D4AF37] text-slate-800'
        : alerta ? 'bg-amber-50 border-amber-300 text-amber-800'
        : 'bg-slate-50 border-[#E7E2D8] text-slate-700'
    }`}>
      <span className="text-[11px] font-bold text-slate-500 mr-1.5">{label}</span>
      <span className="tabular-nums">{brl(valor)}</span>
    </span>
  );
}

/**
 * FRANQUIAS — o dono não ganha o resultado da loja franqueada, ganha o
 * royalty. Por isso ela não é coluna da DRE: é este bloco.
 */
function BlocoFranquias({ data }: { data: Resultado }) {
  const f = data.franquias;
  if (!f.lojas.length) return null;

  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#E7E2D8] bg-[#FBF6E6]/50">
        <h2 className="font-extrabold text-slate-800">Franquias</h2>
        <p className="text-xs text-slate-500">
          Não entram na DRE da rede — seu ganho aqui é o royalty de {f.royaltiesPct}% sobre a venda delas
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#E7E2D8] text-xs text-slate-500">
              <th className="text-left px-4 py-2 font-bold">Franquia</th>
              <th className="text-right px-3 py-2 font-bold">Faturamento dela</th>
              <th className="text-right px-3 py-2 font-bold">Cupons</th>
              <th className="text-right px-3 py-2 font-bold">Peças</th>
              <th className="text-right px-3 py-2 font-bold text-[#2E7D46]">
                Royalties {f.royaltiesPct}% <span className="font-normal">(seu)</span>
              </th>
              <th className="text-right px-4 py-2 font-bold">
                Marketing {f.marketingPct}% <span className="font-normal text-slate-400">(repasse)</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {f.lojas.map((l) => (
              <tr key={l.code} className="border-b border-[#F5F2EB]">
                <td className="px-4 py-2 font-semibold">{l.name}</td>
                <td className="text-right px-3 py-2 tabular-nums text-slate-500">{brl(l.faturamentoBruto)}</td>
                <td className="text-right px-3 py-2 tabular-nums text-slate-500">{l.cupons}</td>
                <td className="text-right px-3 py-2 tabular-nums text-slate-500">{l.pecas}</td>
                <td className="text-right px-3 py-2 tabular-nums font-extrabold text-[#2E7D46]">{brl(l.royalties)}</td>
                <td className="text-right px-4 py-2 tabular-nums text-slate-500">{brl(l.marketing)}</td>
              </tr>
            ))}
            <tr className="bg-[#F4F8F5] font-extrabold border-t border-[#E7E2D8]">
              <td className="px-4 py-2">TOTAL</td>
              <td className="text-right px-3 py-2 tabular-nums">{brl(f.faturamentoBruto)}</td>
              <td colSpan={2} />
              <td className="text-right px-3 py-2 tabular-nums text-[#2E7D46]">{brl(f.royalties)}</td>
              <td className="text-right px-4 py-2 tabular-nums">{brl(f.marketing)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[11px] text-slate-400 border-t border-[#F5F2EB]">
        O marketing de {f.marketingPct}% é repasse pra cobrir a verba da rede — entra como caixa, não como lucro.
        A mercadoria vendida pra franquia (preço ÷ 2,5) também não conta aqui.
      </p>
    </div>
  );
}

/**
 * Confronto com a PLANILHA IDEAL: rubrica por rubrica, o que tem lançamento
 * e o que está faltando. Responde de forma permanente o "quais despesas a
 * planilha tem que a DRE não tem".
 */
function CoberturaPlanilha({ data }: { data: Resultado }) {
  const [aberto, setAberto] = useState(false);
  const p = data.planilha;
  const temCount = p.itens.filter((i) => i.presente).length;

  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
      <button
        onClick={() => setAberto((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#FBF6E6]/50 text-left"
      >
        <ClipboardList className="w-4 h-4 text-[#B8912B]" />
        <div className="flex-1">
          <h2 className="font-extrabold text-slate-800">Cobertura da planilha</h2>
          <p className="text-xs text-slate-500">
            {temCount} de {p.itens.length} rubricas da PLANILHA IDEAL têm lançamento no período
            {p.faltando.length > 0 && ` · faltando: ${p.faltando.slice(0, 4).join(', ')}${p.faltando.length > 4 ? '…' : ''}`}
          </p>
        </div>
        <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${aberto ? 'rotate-90' : ''}`} />
      </button>

      {aberto && (
        <div className="border-t border-[#E7E2D8] p-4 grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] font-bold text-slate-500 uppercase mb-2">Rubrica a rubrica</div>
            <table className="w-full text-sm">
              <tbody>
                {p.itens.map((i) => (
                  <tr key={i.rubrica} className="border-b border-[#F5F2EB]">
                    <td className="py-1.5 w-5">
                      {i.presente
                        ? <span className="text-[#2E7D46] font-bold">✓</span>
                        : <span className="text-rose-500 font-bold">✗</span>}
                    </td>
                    <td className={i.presente ? '' : 'text-rose-700 font-semibold'}>
                      {i.rubrica}
                      {i.especies.length > 0 && (
                        <span className="text-[11px] text-slate-400 ml-1.5">({i.especies.join(', ')})</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums text-slate-600">
                      {i.valor ? brl(i.valor) : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {p.faltando.length > 0 && (
              <p className="text-[11px] text-slate-500 mt-2">
                Rubrica sem lançamento não é erro do sistema: quer dizer que a despesa não está no
                Contas a Pagar do período, ou está com um nome de espécie que não bate.
              </p>
            )}
          </div>

          <div>
            <div className="text-[11px] font-bold text-slate-500 uppercase mb-2">
              Gasto que a planilha não previa
            </div>
            {p.foraDaPlanilha.length === 0 ? (
              <p className="text-xs text-slate-400">Nada — tudo que gastou casa com uma rubrica da planilha.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {p.foraDaPlanilha.map((f) => (
                    <tr key={f.especie} className="border-b border-[#F5F2EB]">
                      <td className="py-1.5">{f.especie}</td>
                      <td className="text-right tabular-nums text-slate-600">{brl(f.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {data.ajustes.length > 0 && (
              <>
                <div className="text-[11px] font-bold text-slate-500 uppercase mt-4 mb-2">
                  Ajustes gerenciais aplicados
                </div>
                <ul className="text-xs text-slate-600 space-y-1">
                  {data.ajustes.map((a) => (
                    <li key={a.id}>
                      {a.tipo === 'EXCLUIR_FORNECEDOR' ? (
                        <>🚫 <b>{a.descricao}</b> — fora da DRE (fornecedor “{a.fornecedorMatch}”)</>
                      ) : (
                        <>➕ <b>{a.descricao}</b> — {brl(a.valorMensal || 0)}/mês por loja
                          {a.lojasExcluidas && <span className="text-slate-400"> · exceto {a.lojasExcluidas}</span>}</>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-slate-400 mt-2">
                  Ajuste gerencial não mexe no Contas a Pagar — a conta real continua lá.
                </p>
              </>
            )}
          </div>
        </div>
      )}
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
  // "Cadê o aluguel?" — tudo que veio do Contas a Pagar e a DRE NÃO somou.
  const d = data.despesaDescartada;
  for (const e of d.porEspecie) {
    const porque = e.grupo === 'CMV'
      ? 'classificada como compra de mercadoria (o CMV vem das peças vendidas)'
      : e.grupo === 'IMPOSTO'
        ? `classificada como imposto (a DRE usa os ${data.config.aliquotaPadrao}% da receita)`
        : 'classificada como IGNORAR';
    itens.push(
      `${brl(e.valor)} da espécie “${e.especie}” NÃO entrou: ${porque}. ` +
      'Se isso é despesa de verdade, reclassifique em Configuração.',
    );
  }
  if (d.semColuna > 0) {
    itens.push(
      `${brl(d.semColuna)} em contas de loja que não é coluna da DRE (sem papel definido ou marcada FORA).`,
    );
  }
  for (const a of d.porAjuste || []) {
    itens.push(
      `${brl(a.valor)} de “${a.descricao}” saiu por ajuste gerencial — fornecedor excluído da DRE. ` +
      'A conta continua no Contas a Pagar.',
    );
  }
  if (d.emFranquia > 0) {
    itens.push(`${brl(d.emFranquia)} lançados em franquia — despesa dela, não sua. Fora do seu resultado.`);
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
        Fonte: {data.fonte}. CMV = venda ÷ {data.config.markup} · imposto de {data.config.aliquotaPadrao}% sobre a receita líquida
        (dá pra sobrepor por CNPJ/mês em Configuração).
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
  FRANQUIA: 'Loja franqueada — sai da DRE; entra só pelos 8% de royalties',
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
  const [novaEspecie, setNovaEspecie] = useState({ nome: '', dreGrupo: 'FIXA' });
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
  const criarEspecie = async () => {
    const nome = novaEspecie.nome.trim();
    if (nome.length < 2) return avisar('erro', 'Informe o nome da espécie');
    try {
      const r = await api<any>('/dre/config/especie', { method: 'POST', body: JSON.stringify(novaEspecie) });
      avisar('ok', r?.reativada ? `${nome} voltou a ficar disponível` : `Espécie ${nome} criada`);
      setNovaEspecie({ nome: '', dreGrupo: 'FIXA' });
      carregar();
    } catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };
  const inativarEspecie = async (e: any) => {
    try { await api(`/dre/config/especie/${e.id}`, { method: 'DELETE' }); avisar('ok', `${e.nome} saiu do lançamento`); carregar(); }
    catch (err: any) { avisar('erro', err?.message || 'Falhou'); }
  };
  const reativarEspecie = async (e: any) => {
    try { await api(`/dre/config/especie/${e.id}/reativar`, { method: 'PATCH' }); avisar('ok', `${e.nome} voltou`); carregar(); }
    catch (err: any) { avisar('erro', err?.message || 'Falhou'); }
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
      <Bloco
        titulo={`Imposto — padrão ${cfg.aliquotaPadrao}% da receita líquida`}
        subtitulo="Só preencha abaixo se algum CNPJ estiver numa faixa diferente do Simples num mês específico"
      >
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
          <p className="text-xs text-slate-400">
            Nenhum override cadastrado — todas as colunas estão usando os {cfg.aliquotaPadrao}% padrão.
          </p>
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

      <BlocoTaxas avisar={avisar} />
      <BlocoAjustes avisar={avisar} />

      {/* Espécies */}
      <Bloco
        titulo="Classificação das espécies de conta"
        subtitulo="Onde cada tipo de despesa entra na DRE. Compra de mercadoria e DAS ficam FORA — entrariam duas vezes"
      >
        {/* Criar espécie — não existia no sistema até 26/07. Sem isso, toda
            despesa nova era obrigada a virar "OUTROS" e cair em FIXA. */}
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <Campo label="Nova espécie">
            <input
              value={novaEspecie.nome}
              onChange={(e) => setNovaEspecie({ ...novaEspecie, nome: e.target.value.toUpperCase() })}
              onKeyDown={(e) => { if (e.key === 'Enter') criarEspecie(); }}
              placeholder="ex: CONTADOR"
              maxLength={30}
              className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-52"
            />
          </Campo>
          <Campo label="Entra na DRE como">
            <select value={novaEspecie.dreGrupo} onChange={(e) => setNovaEspecie({ ...novaEspecie, dreGrupo: e.target.value })}
              className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm">
              {cfg.grupos.especie.map((g: string) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Campo>
          <button onClick={criarEspecie}
            className="bg-[#B8912B] hover:bg-[#8C7325] text-white font-bold px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Criar
          </button>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
          {cfg.especies.map((e: any) => (
            <div key={e.id} className="flex items-center gap-1.5 border border-[#E7E2D8] rounded-lg pl-3 pr-1.5 py-1.5">
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
              <button
                onClick={() => inativarEspecie(e)}
                title="Tirar do lançamento novo (o histórico continua)"
                className="p-1 hover:bg-rose-50 rounded text-slate-300 hover:text-rose-500"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          Fundo amarelo = ainda não confirmada por você (está valendo a classificação automática pelo nome).
          Excluir só tira do lançamento novo — as contas antigas continuam apontando pra ela.
        </p>

        {cfg.especiesInativas?.length > 0 && (
          <div className="mt-3 pt-3 border-t border-[#F0EDE6]">
            <div className="text-[11px] font-bold text-slate-400 uppercase mb-1.5">
              Fora de uso ({cfg.especiesInativas.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cfg.especiesInativas.map((e: any) => (
                <button
                  key={e.id}
                  onClick={() => reativarEspecie(e)}
                  title="Voltar a usar"
                  className="text-[11px] px-2 py-1 rounded-full border border-[#E7E2D8] text-slate-400 hover:bg-[#FBF6E6] hover:text-slate-600"
                >
                  {e.nome} ↩
                </button>
              ))}
            </div>
          </div>
        )}
      </Bloco>
    </div>
  );
}

/**
 * Taxas da adquirente por bandeira × faixa de parcela. A DRE cruza isto com
 * a bandeira e o nº de parcelas que o PDV já grava em cada pagamento, e joga
 * o resultado em DESPESA VARIÁVEL — ninguém precisa lançar no Contas a Pagar.
 */
function BlocoTaxas({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const [taxas, setTaxas] = useState<any[]>([]);
  const [bandeiras, setBandeiras] = useState<any[]>([]);
  const [editando, setEditando] = useState<Record<string, string>>({});
  const hoje = new Date();
  const de = iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const ate = iso(hoje);

  const carregar = useCallback(() => {
    api<any[]>('/dre/config/taxas').then(setTaxas).catch(() => {});
    api<any[]>(`/dre/config/bandeiras?de=${de}&ate=${ate}`).then(setBandeiras).catch(() => {});
  }, [de, ate]);
  useEffect(() => { carregar(); }, [carregar]);

  const salvar = async (t: any, valor: string) => {
    const pct = Number(String(valor).replace(',', '.'));
    if (!Number.isFinite(pct)) return;
    try {
      await api('/dre/config/taxa', {
        method: 'POST',
        body: JSON.stringify({
          forma: t.forma, bandeira: t.bandeira, faixaParcela: t.faixaParcela, taxaPct: pct,
        }),
      });
      avisar('ok', `${t.bandeira} ${t.faixaParcela !== 'UNICA' ? t.faixaParcela + 'x' : ''} → ${pct}%`);
      carregar();
    } catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };

  // Volume observado por bandeira/faixa no mês — pra ele saber onde a taxa dói.
  const volumePor = useMemo(() => {
    const m: Record<string, { volume: number; transacoes: number }> = {};
    for (const b of bandeiras) m[`${b.bandeira}|${b.faixaParcela}`] = b;
    return m;
  }, [bandeiras]);

  const semCadastro = bandeiras.filter((b) => !b.temTaxa && b.volume > 0);
  const porForma = ['PIX', 'DEBITO', 'CREDITO'] as const;
  const rotuloFaixa = (f: string) =>
    f === 'UNICA' ? '—' : f === '1' ? 'à vista' : f === '2-6' ? '2 a 6x' : '7 a 12x';

  /**
   * A tabela mostra a UNIÃO de: taxa já cadastrada + bandeira que APARECEU nas
   * vendas do mês. Sem isso, quando o cadastro estava vazio a tela não tinha
   * onde digitar — foi o que aconteceu no primeiro deploy. Agora as linhas
   * nascem do movimento real: o que a rede passou, você tarifa.
   */
  const linhas = useMemo(() => {
    const m = new Map<string, any>();
    for (const b of bandeiras) {
      m.set(`${b.bandeira}|${b.faixaParcela}`, {
        id: null, forma: b.forma, bandeira: b.bandeira,
        faixaParcela: b.faixaParcela, taxaPct: 0, novo: true,
      });
    }
    for (const t of taxas) m.set(`${t.bandeira}|${t.faixaParcela}`, { ...t, novo: false });
    return [...m.values()];
  }, [taxas, bandeiras]);

  return (
    <Bloco
      titulo="Taxas de cartão e PIX"
      subtitulo="Vira despesa VARIÁVEL sozinha, cruzando com a bandeira e as parcelas que o PDV já grava em cada venda"
    >
      {semCadastro.length > 0 && (
        <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
          <b>Apareceu no mês e não tem taxa cadastrada:</b>{' '}
          {semCadastro.map((b) => `${b.bandeira}${b.faixaParcela !== 'UNICA' ? ` ${b.faixaParcela}x` : ''} (${brl(b.volume)})`).join(' · ')}.
          Essa parte está entrando com taxa zero.
        </div>
      )}

      {porForma.map((forma) => {
        // Maior volume primeiro: você começa pela taxa que mais dói.
        const doGrupo = linhas
          .filter((t) => t.forma === forma)
          .sort((a, b) =>
            (volumePor[`${b.bandeira}|${b.faixaParcela}`]?.volume || 0)
            - (volumePor[`${a.bandeira}|${a.faixaParcela}`]?.volume || 0));
        if (!doGrupo.length) return null;
        return (
          <div key={forma} className="mb-4">
            <div className="text-[11px] font-bold text-slate-500 uppercase mb-1">
              {forma === 'PIX' ? 'PIX' : forma === 'DEBITO' ? 'Débito' : 'Crédito'}
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-slate-500 border-b border-[#E7E2D8]">
                <th className="text-left py-1">Bandeira</th>
                <th className="text-left">Parcelas</th>
                <th className="text-right w-24">Taxa %</th>
                <th className="text-right">Volume no mês</th>
                <th className="text-right">Custo estimado</th>
              </tr></thead>
              <tbody>
                {doGrupo.map((t) => {
                  const chave = `${t.bandeira}|${t.faixaParcela}`;
                  const vol = volumePor[chave];
                  const valor = editando[chave] ?? (Number(t.taxaPct) ? String(t.taxaPct).replace('.', ',') : '');
                  const num = Number(String(valor).replace(',', '.')) || 0;
                  const custo = vol ? (vol.volume * num) / 100 : 0;
                  return (
                    <tr key={chave} className="border-b border-[#F5F2EB]">
                      <td className="py-1 font-semibold">{t.bandeira}</td>
                      <td className="text-slate-500">{rotuloFaixa(t.faixaParcela)}</td>
                      <td className="text-right">
                        <input
                          value={valor}
                          placeholder="0,00"
                          inputMode="decimal"
                          onChange={(e) => setEditando({ ...editando, [chave]: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          onBlur={() => {
                            const v = editando[chave];
                            if (v == null || v === '') return;
                            if (Number(v.replace(',', '.')) !== Number(t.taxaPct)) salvar(t, v);
                          }}
                          className={`w-16 text-right px-1.5 py-0.5 rounded border text-sm ${
                            num > 0 ? 'border-[#E7E2D8]' : 'border-amber-300 bg-amber-50'
                          }`}
                        />
                        <span className="text-slate-400 ml-0.5">%</span>
                      </td>
                      <td className="text-right tabular-nums text-slate-500">
                        {vol ? brl(vol.volume) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="text-right tabular-nums font-semibold">
                        {custo ? brl(custo) : <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {linhas.length === 0 && (
        <p className="text-xs text-slate-400">
          Nenhuma venda com cartão/PIX no mês corrente — sem isso não há o que tarifar.
        </p>
      )}

      <p className="text-[11px] text-slate-400">
        As taxas valem pra rede toda. Volume e custo mostram o mês corrente, só pra você conferir a
        ordem de grandeza — na DRE vale o período do filtro. Campo amarelo = taxa ainda em branco. As linhas saem do que a rede passou no mês — digite e aperte Enter (ou clique fora) que salva sozinho.
      </p>
    </Bloco>
  );
}

/**
 * Ajustes gerenciais: corrigem o resultado SEM mexer no Contas a Pagar.
 * Dois casos reais que motivaram (26/07): tirar a VERISURE da DRE (contrato
 * encerrado, conta ainda lançada) e somar R$ 200/loja de segurança que não
 * está lançado em lugar nenhum.
 */
function BlocoAjustes({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const [lista, setLista] = useState<any[]>([]);
  const [novo, setNovo] = useState({
    tipo: 'DESPESA_FIXA', descricao: '', fornecedorMatch: '',
    valorMensal: '', percentual: '', grupo: 'FIXA', lojasExcluidas: '',
  });

  const carregar = useCallback(() => {
    api<any[]>('/dre/config/ajustes').then(setLista).catch(() => {});
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const salvar = async () => {
    try {
      await api('/dre/config/ajuste', {
        method: 'POST',
        body: JSON.stringify({
          ...novo,
          valorMensal: novo.valorMensal ? Number(String(novo.valorMensal).replace(',', '.')) : undefined,
          percentual: novo.percentual ? Number(String(novo.percentual).replace(',', '.')) : undefined,
        }),
      });
      avisar('ok', 'Ajuste salvo');
      setNovo({ ...novo, descricao: '', fornecedorMatch: '', valorMensal: '', percentual: '', lojasExcluidas: '' });
      carregar();
    } catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };
  const remover = async (id: string) => {
    try { await api(`/dre/config/ajuste/${id}`, { method: 'DELETE' }); carregar(); }
    catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };

  const ehExclusao = novo.tipo === 'EXCLUIR_FORNECEDOR';

  return (
    <Bloco
      titulo="Ajustes gerenciais"
      subtitulo="Corrigem o resultado sem mexer no Contas a Pagar — a conta real continua lá"
    >
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <Campo label="Tipo">
          <select value={novo.tipo} onChange={(e) => setNovo({ ...novo, tipo: e.target.value })}
            className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm">
            <option value="DESPESA_FIXA">Somar R$ por loja/mês</option>
            <option value="DESPESA_PCT">Somar % do faturamento</option>
            <option value="EXCLUIR_FORNECEDOR">Excluir fornecedor da DRE</option>
          </select>
        </Campo>
        <Campo label="Descrição">
          <input value={novo.descricao} onChange={(e) => setNovo({ ...novo, descricao: e.target.value })}
            placeholder={ehExclusao ? 'VERISURE (contrato encerrado)' : 'Segurança e monitoramento'}
            className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-60" />
        </Campo>
        {ehExclusao ? (
          <Campo label="Fornecedor contém">
            <input value={novo.fornecedorMatch} onChange={(e) => setNovo({ ...novo, fornecedorMatch: e.target.value })}
              placeholder="VERISURE" className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-40" />
          </Campo>
        ) : (
          <>
            {novo.tipo === 'DESPESA_PCT' ? (
              <Campo label="% do faturamento">
                <input value={novo.percentual} onChange={(e) => setNovo({ ...novo, percentual: e.target.value })}
                  placeholder="5" className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-24" />
              </Campo>
            ) : (
              <Campo label="R$ por loja/mês">
                <input value={novo.valorMensal} onChange={(e) => setNovo({ ...novo, valorMensal: e.target.value })}
                  placeholder="200,00" className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-28" />
              </Campo>
            )}
            <Campo label="Entra como">
              <select value={novo.grupo} onChange={(e) => setNovo({ ...novo, grupo: e.target.value })}
                className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm">
                <option value="VARIAVEL">Despesa variável</option>
                <option value="FIXA">Despesa fixa</option>
                <option value="FINANCEIRA">Despesa financeira</option>
              </select>
            </Campo>
            <Campo label="Lojas que NÃO pagam">
              <input value={novo.lojasExcluidas} onChange={(e) => setNovo({ ...novo, lojasExcluidas: e.target.value })}
                placeholder="SANTOS" className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] text-sm w-44" />
            </Campo>
          </>
        )}
        <button onClick={salvar}
          className="bg-[#B8912B] hover:bg-[#8C7325] text-white font-bold px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> Salvar
        </button>
      </div>

      {lista.length === 0 ? (
        <p className="text-xs text-slate-400">Nenhum ajuste — a DRE está usando o Contas a Pagar cru.</p>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-slate-500 border-b border-[#E7E2D8]">
            <th className="text-left py-1.5">Ajuste</th><th className="text-left">Regra</th><th />
          </tr></thead>
          <tbody>
            {lista.map((a) => (
              <tr key={a.id} className="border-b border-[#F5F2EB]">
                <td className="py-1.5 font-semibold">
                  {a.tipo === 'EXCLUIR_FORNECEDOR' ? '🚫 ' : '➕ '}{a.descricao}
                </td>
                <td className="text-slate-500 text-xs">
                  {a.tipo === 'EXCLUIR_FORNECEDOR'
                    ? `fornecedor contém “${a.fornecedorMatch}” → fora da DRE`
                    : a.tipo === 'DESPESA_PCT'
                      ? `${a.percentual}% do faturamento de cada loja${a.lojasExcluidas ? ` · exceto ${a.lojasExcluidas}` : ''}`
                      : `${brl(a.valorMensal || 0)}/mês por loja${a.lojasExcluidas ? ` · exceto ${a.lojasExcluidas}` : ''}`}
                </td>
                <td className="text-right">
                  <button onClick={() => remover(a.id)} className="p-1 hover:bg-rose-50 rounded text-rose-500">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-slate-400 mt-2">
        Despesa por loja é valor MENSAL e entra proporcional aos dias do período — filtrar 7 dias
        não cobra o mês inteiro. Só vale pra loja física (canal digital não tem ponto pra vigiar).
      </p>
    </Bloco>
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
