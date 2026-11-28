'use client';

/**
 * NF-e EM LOTE (dono, 28/11/2026): emite a nota de transferência de TODAS as
 * remessas que uma loja RECEBEU no período e ficaram sem nota, juntando as
 * remessas em poucas notas. CFOP 5152, sem imposto. Prévia primeiro — o
 * botão Emitir só aparece depois dela e manda a lista exata conferida.
 */
import { useState } from 'react';
import { api } from '@/lib/api';

const brl = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function iso(d: Date) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function diasAtras(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

export default function NfeLoteModal({ onClose }: { onClose: () => void }) {
  const [loja, setLoja] = useState('07');
  const [de, setDe] = useState(diasAtras(92));
  const [ate, setAte] = useState(iso(new Date()));
  const [previa, setPrevia] = useState<any>(null);
  const [resultado, setResultado] = useState<any>(null);
  const [carregando, setCarregando] = useState(false);
  const [emitindo, setEmitindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const atalho = (dias: number) => {
    setDe(diasAtras(dias));
    setAte(iso(new Date()));
    setPrevia(null);
  };

  async function verPrevia() {
    setCarregando(true);
    setErro(null);
    setPrevia(null);
    setResultado(null);
    try {
      const q = new URLSearchParams({ toStoreCode: loja.trim(), de, ate });
      setPrevia(await api<any>(`/nfe/transfer/lote/preview?${q.toString()}`));
    } catch (e: any) {
      setErro(e?.message || 'Falha ao montar a prévia');
    } finally {
      setCarregando(false);
    }
  }

  async function emitir() {
    if (!previa?.notas?.length) return;
    const t = previa.totais;
    if (!confirm(`Emitir ${t.notas} NF-e na SEFAZ (produção), cobrindo ${t.remessas} remessas, ${t.pecas} peças, ${brl(t.valorTotal)}?\n\nNota autorizada não volta atrás.`)) return;
    setEmitindo(true);
    setErro(null);
    try {
      const shipmentIds = previa.notas.flatMap((n: any) => n.shipmentIds);
      setResultado(
        await api<any>('/nfe/transfer/lote/emit', {
          method: 'POST',
          body: JSON.stringify({ toStoreCode: loja.trim(), de, ate, shipmentIds }),
        }),
      );
    } catch (e: any) {
      setErro(e?.message || 'Falha ao emitir');
    } finally {
      setEmitindo(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-800 text-lg">🧾 NF-e em lote — remessas recebidas sem nota</h2>
            <p className="text-sm text-slate-500 mt-1">
              Junta as remessas que a loja recebeu no período e ficaram sem nota. Transferência CFOP 5152, sem imposto
              (ICMS CST 90 + cBenef SP099000, PIS/COFINS zerados). Cada nota leva as peças bipadas nas remessas que cobre.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">Loja que recebeu</span>
            <input value={loja} onChange={(e) => { setLoja(e.target.value); setPrevia(null); }} className="border rounded px-2 py-1.5 w-20" />
          </label>
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">De</span>
            <input type="date" value={de} onChange={(e) => { setDe(e.target.value); setPrevia(null); }} className="border rounded px-2 py-1.5" />
          </label>
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">Até</span>
            <input type="date" value={ate} onChange={(e) => { setAte(e.target.value); setPrevia(null); }} className="border rounded px-2 py-1.5" />
          </label>
          <div className="flex gap-1 text-xs">
            <button onClick={() => atalho(30)} className="px-2 py-1.5 rounded border hover:bg-slate-50">Mês</button>
            <button onClick={() => atalho(92)} className="px-2 py-1.5 rounded border hover:bg-slate-50">3 meses</button>
          </div>
          <button onClick={verPrevia} disabled={carregando || emitindo} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-bold disabled:opacity-50">
            {carregando ? 'Montando…' : 'Ver prévia'}
          </button>
        </div>

        {erro && <div className="mt-4 p-3 rounded bg-red-50 text-red-700 text-sm">{erro}</div>}

        {previa && !resultado && (
          <div className="mt-5 space-y-3">
            <div className="p-3 rounded-lg bg-slate-50 text-sm">
              <b>{previa.totais.notas}</b> nota(s) · <b>{previa.totais.remessas}</b> remessas · <b>{previa.totais.pecas}</b> peças ·{' '}
              <b>{brl(previa.totais.valorTotal)}</b> a custo
              {previa.jaComNota > 0 && <span className="text-slate-500"> · {previa.jaComNota} remessa(s) do período já têm nota</span>}
            </div>
            {previa.notas.map((n: any) => (
              <div key={n.ordem} className="border rounded-lg p-3 text-sm">
                <div className="flex justify-between gap-2">
                  <b>Nota {n.ordem}</b>
                  <b>{brl(n.valorTotal)}</b>
                </div>
                <div className="text-slate-600 mt-1">
                  {n.emitente.razaoSocial} ({n.emitente.cnpj}) → {n.destinatario.razaoSocial} ({n.destinatario.cnpj}) · CFOP {n.cfop}
                  {n.emitente.ambiente === '2' && <span className="ml-2 text-amber-700 font-bold">HOMOLOGAÇÃO</span>}
                </div>
                <div className="text-slate-600">{n.remessas.length} remessas · {n.itens} itens · {n.pecas} peças</div>
                <details className="mt-1 text-xs text-slate-500">
                  <summary className="cursor-pointer">Remessas e avisos</summary>
                  <div className="mt-1">{n.remessas.join(', ')}</div>
                  {n.warnings?.length > 0 && <ul className="mt-1 list-disc pl-4 text-amber-700">{n.warnings.slice(0, 30).map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}
                </details>
              </div>
            ))}
            {previa.excluidas?.length > 0 && (
              <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 text-sm">
                <b>{previa.excluidas.length} remessa(s) ficam FORA:</b>
                <ul className="mt-1 text-xs list-disc pl-4">
                  {previa.excluidas.map((x: any) => <li key={x.code}>{x.code} (de {x.de}): {x.motivo}</li>)}
                </ul>
              </div>
            )}
            {previa.notas.length > 0 ? (
              <button onClick={emitir} disabled={emitindo} className="w-full py-3 rounded-lg bg-emerald-700 text-white font-bold disabled:opacity-50">
                {emitindo ? 'Emitindo na SEFAZ… não feche' : `Emitir ${previa.totais.notas} NF-e`}
              </button>
            ) : (
              <div className="text-sm text-slate-600">Nenhuma remessa sem nota nesse período.</div>
            )}
          </div>
        )}

        {resultado && (
          <div className="mt-5 space-y-2 text-sm">
            <div className={`p-3 rounded-lg font-bold ${resultado.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>
              {resultado.emitidas} de {resultado.totalPlanejado} nota(s) autorizada(s)
              {!resultado.ok && ' — parou na primeira recusa. Corrija e clique Ver prévia de novo: as autorizadas não se repetem.'}
            </div>
            {resultado.resultados.map((r: any, i: number) => (
              <div key={i} className="border rounded p-2">
                NF-e nº <b>{r.doc?.numero}</b> · {r.doc?.status} {r.doc?.cStat ? `(${r.doc.cStat})` : ''} · {brl(r.valorTotal)} · {r.remessas.length} remessas
                {!r.ok && <div className="text-red-700 text-xs mt-1">{r.doc?.xMotivo || r.doc?.erro}</div>}
              </div>
            ))}
            <p className="text-slate-500">As notas aparecem em “📄 NF-e emitidas”, com XML e DANFE.</p>
          </div>
        )}
      </div>
    </div>
  );
}
