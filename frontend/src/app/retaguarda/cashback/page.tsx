'use client';

/**
 * /retaguarda/cashback — prévia e interruptor do cashback da rede.
 *
 * A regra nasce DESLIGADA. Esta tela existe pra o dono ver o custo medido
 * sobre venda que já aconteceu ANTES de ligar, e o botão de ligar mora aqui
 * mesmo — decisão dele em 01/08/2026, mesmo padrão do limite da rede.
 *
 * O número que mais importa não é o custo: é o ALCANCE. Três em cada quatro
 * vendas não têm CPF, e sem CPF não há cashback.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import { Gift, Loader2, Power, AlertTriangle, Save } from 'lucide-react';

const brl = (n: number) =>
  `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${Number(n || 0).toFixed(1)}%`;

interface Config {
  ativo: boolean;
  pctPrimeiraCompra: number;
  pctDemais: number;
  carenciaDias: number;
  validadeDias: number;
  usoMaxPctCompra: number;
  minimoUsoReais: number;
  crediarioNoPagamento: boolean;
}

interface Previa {
  janelaDias: number;
  config: Config;
  totais: {
    vendasComCpf: number; pessoas: number; faturadoComCpf: number;
    primeirasCompras: number; custoPrimeira: number; custoDemais: number;
    custoTotal: number; pctSobreFaturadoComCpf: number;
  };
  alcance: {
    totalVendas: number; semCpf: number; pctSemCpf: number;
    faturadoTotal: number; faturadoSemCpf: number;
  };
  porLoja: Array<{
    loja: string; vendas: number; pessoas: number; faturado: number;
    primeirasCompras: number; custoTotal: number; pctSobreFaturado: number;
  }>;
  avisos: string[];
}

export default function CashbackPage() {
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [extrato, setExtrato] = useState<any>(null);
  const [dias, setDias] = useState(30);
  const [loading, setLoading] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function carregar() {
    setLoading(true);
    setErro(null);
    try {
      const [p, e] = await Promise.all([
        api<Previa>(`/cashback/previa?dias=${dias}`),
        api<any>('/cashback/extrato').catch(() => null),
      ]);
      setPrevia(p);
      setCfg(p.config);
      setExtrato(e);
    } catch (e: any) {
      setErro(e?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { carregar(); /* eslint-disable-next-line */ }, [dias]);

  async function salvar(patch: Partial<Config>) {
    if (!cfg) return;
    setSalvando(true);
    try {
      const r = await api<{ ok: boolean; erro?: string; config?: Config }>('/cashback/config', {
        method: 'POST',
        body: JSON.stringify({ ...cfg, ...patch }),
      });
      if (!r.ok) { alert(r.erro || 'Não foi possível salvar'); return; }
      if (r.config) setCfg(r.config);
      await carregar();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setSalvando(false);
    }
  }

  async function alternar() {
    if (!cfg) return;
    const ligando = !cfg.ativo;
    const msg = ligando
      ? `LIGAR o cashback?\n\n` +
        `A partir de agora toda venda com CPF gera crédito: ` +
        `${cfg.pctPrimeiraCompra}% na primeira compra da pessoa e ${cfg.pctDemais}% nas seguintes.\n\n` +
        `Custo estimado: ${brl(previa?.totais.custoTotal || 0)} a cada ${dias} dias.\n\n` +
        `Crédito já gerado NÃO some se você desligar depois — é dívida com a cliente.`
      : `DESLIGAR o cashback?\n\nPara de gerar crédito novo. O saldo que as ` +
        `clientes já têm continua valendo e pode ser usado.`;
    if (!confirm(msg)) return;
    await salvar({ ativo: ligando });
  }

  return (
    <PastelShell title="Cashback" subtitle="Prévia do custo e interruptor da regra" backHref="/retaguarda">
      {loading && (
        <div className="flex items-center gap-2 text-slate-500 py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Medindo sobre as vendas reais…
        </div>
      )}

      {erro && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded p-4 text-sm">{erro}</div>
      )}

      {!loading && previa && cfg && (
        <div className="space-y-5">
          {/* ── INTERRUPTOR ── */}
          <div className={`rounded-xl border p-5 ${cfg.ativo ? 'bg-emerald-50 border-emerald-300' : 'bg-slate-50 border-slate-300'}`}>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2 font-semibold text-lg">
                  <Gift className="w-5 h-5" />
                  Cashback {cfg.ativo ? 'LIGADO' : 'desligado'}
                </div>
                <p className="text-sm text-slate-600 mt-1">
                  {cfg.ativo
                    ? 'Toda venda com CPF está gerando crédito agora.'
                    : 'Nada está sendo creditado. Os números abaixo são simulação.'}
                </p>
              </div>
              <button
                onClick={alternar}
                disabled={salvando}
                className={`px-5 py-2.5 rounded-lg text-white font-semibold flex items-center gap-2 disabled:opacity-50 ${
                  cfg.ativo ? 'bg-slate-700 hover:bg-slate-800' : 'bg-emerald-700 hover:bg-emerald-800'
                }`}
              >
                <Power className="w-4 h-4" />
                {cfg.ativo ? 'Desligar' : 'Ligar cashback'}
              </button>
            </div>
          </div>

          {/* ── O ALCANCE, ANTES DO CUSTO ── */}
          {previa.alcance.pctSemCpf > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-amber-900">
                    {pct(previa.alcance.pctSemCpf)} das vendas não têm CPF
                  </div>
                  <p className="text-sm text-amber-900/80 mt-1">
                    São {previa.alcance.semCpf.toLocaleString('pt-BR')} de{' '}
                    {previa.alcance.totalVendas.toLocaleString('pt-BR')} vendas —{' '}
                    {brl(previa.alcance.faturadoSemCpf)} de {brl(previa.alcance.faturadoTotal)}.
                    O cashback não alcança nenhuma delas.
                  </p>
                  <p className="text-sm text-amber-900/80 mt-2">
                    Isso pode ser o maior valor da regra: dar à vendedora um motivo
                    concreto pra pedir o CPF.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── CUSTO ── */}
          <div className="rounded-xl border bg-white p-5">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <h2 className="font-semibold">Custo estimado</h2>
              <div className="flex gap-1">
                {[7, 30, 90].map((d) => (
                  <button
                    key={d}
                    onClick={() => setDias(d)}
                    className={`px-3 py-1.5 text-sm rounded border ${
                      dias === d ? 'bg-slate-800 text-white border-slate-800' : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    {d} dias
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi label="Custo total" valor={brl(previa.totais.custoTotal)} destaque />
              <Kpi label={`Primeiras compras (${cfg.pctPrimeiraCompra}%)`} valor={brl(previa.totais.custoPrimeira)} />
              <Kpi label={`Demais (${cfg.pctDemais}%)`} valor={brl(previa.totais.custoDemais)} />
              <Kpi label="% do faturamento com CPF" valor={pct(previa.totais.pctSobreFaturadoComCpf)} />
            </div>

            <p className="text-xs text-slate-500 mt-3">
              {previa.totais.primeirasCompras.toLocaleString('pt-BR')} primeiras compras de verdade
              (CPF sem nenhuma compra no Flow nem ficha no Giga) entre{' '}
              {previa.totais.vendasComCpf.toLocaleString('pt-BR')} vendas com CPF de{' '}
              {previa.totais.pessoas.toLocaleString('pt-BR')} pessoas.
            </p>

            {previa.avisos.map((a, i) => (
              <p key={i} className="text-xs text-slate-600 mt-2 pl-3 border-l-2 border-slate-200">{a}</p>
            ))}
          </div>

          {/* ── POR LOJA ── */}
          <div className="rounded-xl border bg-white overflow-hidden">
            <h2 className="font-semibold px-5 py-3 border-b">Por loja</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <Th>Loja</Th><Th right>Vendas c/ CPF</Th><Th right>Pessoas</Th>
                    <Th right>Faturado</Th><Th right>1ªs compras</Th>
                    <Th right>Custo</Th><Th right>% do faturado</Th>
                  </tr>
                </thead>
                <tbody>
                  {previa.porLoja.map((l) => (
                    <tr key={l.loja} className="border-t">
                      <Td><b>{l.loja}</b></Td>
                      <Td right>{l.vendas.toLocaleString('pt-BR')}</Td>
                      <Td right>{l.pessoas.toLocaleString('pt-BR')}</Td>
                      <Td right>{brl(l.faturado)}</Td>
                      <Td right>{l.primeirasCompras.toLocaleString('pt-BR')}</Td>
                      <Td right><b>{brl(l.custoTotal)}</b></Td>
                      <Td right>{pct(l.pctSobreFaturado)}</Td>
                    </tr>
                  ))}
                  {!previa.porLoja.length && (
                    <tr><td colSpan={7} className="px-5 py-6 text-center text-slate-500">
                      Nenhuma venda com CPF no período.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── REGRA ── */}
          <div className="rounded-xl border bg-white p-5">
            <h2 className="font-semibold mb-4">Regra</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Num label="% primeira compra" valor={cfg.pctPrimeiraCompra} onChange={(v) => setCfg({ ...cfg, pctPrimeiraCompra: v })} sufixo="%" />
              <Num label="% demais compras" valor={cfg.pctDemais} onChange={(v) => setCfg({ ...cfg, pctDemais: v })} sufixo="%" />
              <Num label="Libera depois de" valor={cfg.carenciaDias} onChange={(v) => setCfg({ ...cfg, carenciaDias: v })} sufixo="dias" />
              <Num label="Vale por" valor={cfg.validadeDias} onChange={(v) => setCfg({ ...cfg, validadeDias: v })} sufixo="dias" />
              <Num label="Paga no máximo" valor={cfg.usoMaxPctCompra} onChange={(v) => setCfg({ ...cfg, usoMaxPctCompra: v })} sufixo="% da compra" />
              <Num label="Saldo mínimo pra usar" valor={cfg.minimoUsoReais} onChange={(v) => setCfg({ ...cfg, minimoUsoReais: v })} sufixo="R$" />
            </div>
            <label className="flex items-center gap-2 mt-4 text-sm">
              <input
                type="checkbox"
                checked={cfg.crediarioNoPagamento}
                onChange={(e) => setCfg({ ...cfg, crediarioNoPagamento: e.target.checked })}
              />
              Crediário credita conforme a parcela é paga (e não no fechamento da venda)
            </label>
            <button
              onClick={() => salvar({})}
              disabled={salvando}
              className="mt-4 px-4 py-2 rounded bg-slate-800 text-white text-sm flex items-center gap-2 disabled:opacity-50"
            >
              <Save className="w-4 h-4" /> Salvar regra
            </button>
            <p className="text-xs text-slate-500 mt-2">
              Salvar a regra não liga o cashback — o interruptor é o botão lá em cima.
            </p>
          </div>

          {/* ── O QUE JÁ FOI CREDITADO ── */}
          {extrato && extrato.creditos > 0 && (
            <div className="rounded-xl border bg-white p-5">
              <h2 className="font-semibold mb-4">Já creditado</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Kpi label="Saldo disponível" valor={brl(extrato.saldoDisponivel)} destaque />
                <Kpi label="Total ganho" valor={brl(extrato.totalGanho)} />
                <Kpi label="Já usado" valor={brl(extrato.totalUsado)} />
                <Kpi label="Cancelado por devolução" valor={brl(extrato.totalCancelado)} />
              </div>
              <p className="text-xs text-slate-500 mt-3">
                {extrato.pessoas.toLocaleString('pt-BR')} pessoas com crédito.
                {extrato.saldoNegativo < 0 && (
                  <> {brl(Math.abs(extrato.saldoNegativo))} em saldo negativo (devolução de cashback já gasto).</>
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </PastelShell>
  );
}

function Kpi({ label, valor, destaque }: { label: string; valor: string; destaque?: boolean }) {
  return (
    <div className={`rounded-lg p-3 border ${destaque ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50'}`}>
      <div className="text-xs text-slate-600">{label}</div>
      <div className={`font-bold ${destaque ? 'text-emerald-800 text-xl' : 'text-slate-800 text-lg'}`}>{valor}</div>
    </div>
  );
}

function Num({ label, valor, onChange, sufixo }: {
  label: string; valor: number; onChange: (v: number) => void; sufixo?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600">{label}</span>
      <div className="flex items-center gap-2 mt-1">
        <input
          type="number"
          step="0.01"
          value={valor}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full px-3 py-2 border rounded"
        />
        {sufixo && <span className="text-xs text-slate-500 whitespace-nowrap">{sufixo}</span>}
      </div>
    </label>
  );
}

const Th = ({ children, right }: any) => (
  <th className={`px-4 py-2 font-medium ${right ? 'text-right' : 'text-left'}`}>{children}</th>
);
const Td = ({ children, right }: any) => (
  <td className={`px-4 py-2 ${right ? 'text-right' : 'text-left'}`}>{children}</td>
);
