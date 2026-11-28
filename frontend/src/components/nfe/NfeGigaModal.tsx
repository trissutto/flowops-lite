'use client';

/**
 * NF-e dos documentos de transferência do GIGA (dono, 28/11/2026): as
 * transferências da matriz LURDS pra Campinas feitas no sistema anterior e
 * que ficaram sem nota. Pega do documento MAIS ANTIGO pro mais novo até o
 * teto de valor (a custo). Emitente LURDS matriz, CFOP 5152, sem imposto.
 * Prévia primeiro; o Emitir manda as chaves exatas conferidas.
 */
import { useState } from 'react';
import { api } from '@/lib/api';

const brl = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso?: string | null) => (iso ? iso.split('-').reverse().join('/') : '?');

export default function NfeGigaModal({ onClose }: { onClose: () => void }) {
  const [origens, setOrigens] = useState('01,13');
  const [destino, setDestino] = useState('07');
  const [de, setDe] = useState('2025-01-01');
  const [ate, setAte] = useState('2026-03-31');
  const [teto, setTeto] = useState('300000');
  const [previa, setPrevia] = useState<any>(null);
  const [resultado, setResultado] = useState<any>(null);
  const [carregando, setCarregando] = useState(false);
  const [emitindo, setEmitindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const mudou = () => { setPrevia(null); setResultado(null); };

  async function verPrevia() {
    setCarregando(true); setErro(null); mudou();
    try {
      const q = new URLSearchParams({ destino: destino.trim(), origens: origens.replace(/\s/g, ''), de, ate, teto: String(Number(teto) || 0) });
      setPrevia(await api<any>(`/nfe/transfer/giga/preview?${q.toString()}`));
    } catch (e: any) {
      setErro(e?.message || 'Falha ao montar a prévia');
    } finally {
      setCarregando(false);
    }
  }

  async function emitir() {
    const t = previa?.totais;
    if (!t?.notas) return;
    if (!confirm(`Emitir ${t.notas} NF-e na SEFAZ (produção): ${t.documentos} documentos do Giga, ${t.pecas} peças, ${brl(t.valorTotal)}?\n\nNota autorizada não volta atrás.`)) return;
    setEmitindo(true); setErro(null);
    try {
      const chaves = previa.notas.flatMap((n: any) => n.chaves);
      setResultado(await api<any>('/nfe/transfer/giga/emit', {
        method: 'POST',
        body: JSON.stringify({ destino: destino.trim(), origens: origens.replace(/\s/g, '').split(','), de, ate, teto: Number(teto) || 0, chaves }),
      }));
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
            <h2 className="font-semibold text-slate-800 text-lg">📜 NF-e das transferências do Giga sem nota</h2>
            <p className="text-sm text-slate-500 mt-1">
              Documentos de transferência do sistema anterior, peça a peça, do mais antigo pro mais novo até o teto (valor a custo).
              Emitente LURDS matriz, CFOP 5152, sem imposto.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
          <label><span className="block text-slate-600 mb-1">Origens (Giga)</span>
            <input value={origens} onChange={(e) => { setOrigens(e.target.value); mudou(); }} className="border rounded px-2 py-1.5 w-24" /></label>
          <label><span className="block text-slate-600 mb-1">Destino</span>
            <input value={destino} onChange={(e) => { setDestino(e.target.value); mudou(); }} className="border rounded px-2 py-1.5 w-16" /></label>
          <label><span className="block text-slate-600 mb-1">De</span>
            <input type="date" value={de} onChange={(e) => { setDe(e.target.value); mudou(); }} className="border rounded px-2 py-1.5" /></label>
          <label><span className="block text-slate-600 mb-1">Até</span>
            <input type="date" value={ate} onChange={(e) => { setAte(e.target.value); mudou(); }} className="border rounded px-2 py-1.5" /></label>
          <label><span className="block text-slate-600 mb-1">Teto (R$)</span>
            <input value={teto} onChange={(e) => { setTeto(e.target.value.replace(/[^\d]/g, '')); mudou(); }} className="border rounded px-2 py-1.5 w-28" /></label>
          <button onClick={verPrevia} disabled={carregando || emitindo} className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50">
            {carregando ? 'Calculando o custo… (pode levar 1 min)' : 'Ver prévia'}
          </button>
        </div>

        {erro && <div className="mt-4 p-3 rounded bg-red-50 text-red-700 text-sm">{erro}</div>}

        {previa && !resultado && (
          <div className="mt-5 space-y-3 text-sm">
            <div className="p-3 rounded-lg bg-slate-50">
              <div><b>{previa.totais.notas}</b> nota(s) · <b>{previa.totais.documentos}</b> documentos · <b>{previa.totais.pecas}</b> peças · <b>{brl(previa.totais.valorTotal)}</b> a custo (teto {brl(previa.totais.teto)})</div>
              <div className="mt-1">Período coberto: <b>{br(previa.totais.periodoCoberto?.de)} a {br(previa.totais.periodoCoberto?.ate)}</b></div>
              <div className="mt-1 text-slate-600">
                {previa.emitente.razaoSocial} ({previa.emitente.cnpj}) → {previa.destinatario.razaoSocial} ({previa.destinatario.cnpj})
                {previa.emitente.ambiente === '2' && <span className="ml-2 text-amber-700 font-bold">HOMOLOGAÇÃO</span>}
              </div>
              <div className="mt-1 text-slate-500">
                Fica para depois (passa do teto): {previa.fora.documentos} documentos, {previa.fora.pecas} peças
                {previa.jaComNota > 0 && ` · ${previa.jaComNota} documento(s) já têm nota`}
                {previa.semCusto > 0 && ` · ${previa.semCusto} código(s) sem custo cadastrado (usado preço ÷ 2,5)`}
              </div>
            </div>
            {previa.notas.map((n: any) => (
              <div key={n.ordem} className="border rounded-lg p-3">
                <div className="flex justify-between"><b>Nota {n.ordem}</b><b>{brl(n.valorTotal)}</b></div>
                <div className="text-slate-600">{n.documentos.length} documentos · {n.itens} itens · {n.pecas} peças · {br(n.de)} a {br(n.ate)}</div>
                <details className="text-xs text-slate-500 mt-1"><summary className="cursor-pointer">Documentos do Giga</summary>{n.documentos.join(', ')}</details>
              </div>
            ))}
            {previa.totais.notas > 0 ? (
              <button onClick={emitir} disabled={emitindo} className="w-full py-3 rounded-lg bg-emerald-700 text-white font-bold disabled:opacity-50">
                {emitindo ? 'Emitindo na SEFAZ… não feche' : `Emitir ${previa.totais.notas} NF-e`}
              </button>
            ) : (
              <div className="text-slate-600">Nenhum documento sem nota nesse período.</div>
            )}
          </div>
        )}

        {resultado && (
          <div className="mt-5 space-y-2 text-sm">
            <div className={`p-3 rounded-lg font-bold ${resultado.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>
              {resultado.emitidas} de {resultado.totalPlanejado} nota(s) autorizada(s)
              {!resultado.ok && ' — parou na primeira recusa. Clique Ver prévia de novo: as autorizadas não se repetem.'}
            </div>
            {resultado.resultados.map((r: any, i: number) => (
              <div key={i} className="border rounded p-2">
                NF-e nº <b>{r.doc?.numero}</b> · {r.doc?.status} {r.doc?.cStat ? `(${r.doc.cStat})` : ''} · {brl(r.valorTotal)} · {r.documentos} documentos
                {!r.ok && <div className="text-red-700 text-xs mt-1">{r.doc?.xMotivo}</div>}
              </div>
            ))}
            <p className="text-slate-500">As notas aparecem em “📄 NF-e emitidas” e no Relatório Fiscal (download em ZIP).</p>
          </div>
        )}
      </div>
    </div>
  );
}
