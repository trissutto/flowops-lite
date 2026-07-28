'use client';

/**
 * /retaguarda/dce — DC-e (Declaração de Conteúdo eletrônica, modelo 99).
 *
 * 1. EMITIR TESTE em HOMOLOGAÇÃO — valida o fluxo completo contra o ambiente
 *    de teste da SEFAZ (SVD/PR) com o certificado real da loja, SEM valor
 *    fiscal. É o botão da fase de homologação: o retorno cru (cStat/xMotivo)
 *    guia os ajustes de layout via envs (DCE_SOAP_*, DCE_NSITE...).
 * 2. LISTA das DC-e emitidas (status, chave, protocolo) + baixar DACE.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, RefreshCw, FlaskConical, Download } from 'lucide-react';
import { api } from '@/lib/api';

function downloadPdf(b64: string, nome: string) {
  const a = document.createElement('a');
  a.href = `data:application/pdf;base64,${b64}`;
  a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
}

export default function DcePage() {
  const [lista, setLista] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeCode, setStoreCode] = useState('01');
  const [emitindo, setEmitindo] = useState(false);
  const [resultado, setResultado] = useState<any>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try { setLista(await api<any[]>('/dce?limit=50')); } catch { setLista([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const emitirTeste = async () => {
    setEmitindo(true); setResultado(null);
    try {
      const r = await api<any>('/dce/emitir', {
        method: 'POST',
        body: JSON.stringify({
          storeCode,
          ambiente: '2', // HOMOLOGAÇÃO — sem valor fiscal
          dest: {
            nome: 'CLIENTE TESTE HOMOLOGACAO', cpfCnpj: '',
            logradouro: 'Rua Teste', numero: '100', bairro: 'Centro',
            cidade: 'Sao Paulo', uf: 'SP', cep: '01001000',
          },
          itens: [{ descricao: 'Blusa Feminina Plus Size Teste', quantidade: 1, valorUnit: 79.9 }],
        }),
      });
      setResultado(r);
      carregar();
    } catch (e: any) {
      setResultado({ status: 'error', erro: e?.message || 'falha' });
    } finally { setEmitindo(false); }
  };

  const baixarDace = async (id: string, numero: number) => {
    try {
      const b = await api<any>(`/dce/${id}/dace-b64`);
      if (b?.ok && b.pdfBase64) downloadPdf(b.pdfBase64, `dace-${numero}.pdf`);
    } catch { /* mostrado no status */ }
  };

  const badge = (s: string) =>
    s === 'authorized' ? 'bg-emerald-100 text-emerald-700' :
    s === 'rejected' ? 'bg-rose-100 text-rose-700' :
    s === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600';

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-5">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft size={20} /></Link>
          <FileText size={22} className="text-slate-700" />
          <h1 className="text-xl font-semibold text-slate-800">DC-e — Declaração de Conteúdo eletrônica</h1>
          <button onClick={carregar} className="ml-auto text-slate-500 hover:text-slate-800"><RefreshCw size={18} /></button>
        </div>

        {/* Teste de homologação */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <h2 className="font-medium flex items-center gap-2 mb-1"><FlaskConical size={16} /> Emitir TESTE em homologação</h2>
          <p className="text-xs text-slate-500 mb-3">
            Emite uma DC-e de teste no ambiente de <b>homologação</b> da SEFAZ (sem valor fiscal), com o certificado
            real da loja. O retorno cru abaixo (cStat/xMotivo) guia os ajustes de layout.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-500">
              Código da loja
              <input value={storeCode} onChange={(e) => setStoreCode(e.target.value)}
                className="block mt-1 border border-slate-300 rounded-md px-3 py-2 text-sm w-28" placeholder="01" />
            </label>
            <button onClick={emitirTeste} disabled={emitindo || !storeCode.trim()}
              className="bg-violet-600 text-white text-sm rounded-md px-4 py-2 hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
              {emitindo ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />} Emitir teste (homolog)
            </button>
          </div>
          {resultado && (
            <pre className="mt-3 text-[11px] bg-slate-50 border border-slate-200 rounded-md p-3 overflow-auto max-h-80 whitespace-pre-wrap break-all">
              {JSON.stringify(resultado, null, 2)}
            </pre>
          )}
        </section>

        {/* Lista */}
        <section className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-medium mb-3">Emitidas</h2>
          {loading ? <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Carregando…</div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase text-slate-400">
                    <th className="py-1 pr-3">Data</th><th className="py-1 pr-3">Loja</th><th className="py-1 pr-3">Nº</th>
                    <th className="py-1 pr-3">Destinatário</th><th className="py-1 pr-3">Valor</th>
                    <th className="py-1 pr-3">Amb</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">cStat</th><th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {lista.map((d) => (
                    <tr key={d.id} className="border-t border-slate-100">
                      <td className="py-2 pr-3 whitespace-nowrap">{new Date(d.createdAt).toLocaleString('pt-BR')}</td>
                      <td className="py-2 pr-3">{d.storeCode}</td>
                      <td className="py-2 pr-3">{d.numero}</td>
                      <td className="py-2 pr-3">{d.destNome || '—'}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">R$ {((d.valorCents || 0) / 100).toFixed(2).replace('.', ',')}</td>
                      <td className="py-2 pr-3">{d.tpAmb === '2' ? 'Homolog' : 'Prod'}</td>
                      <td className="py-2 pr-3"><span className={`px-2 py-0.5 rounded-full text-xs ${badge(d.status)}`}>{d.status}</span></td>
                      <td className="py-2 pr-3" title={d.xMotivo || ''}>{d.cStat || '—'}</td>
                      <td className="py-2 text-right">
                        {d.status === 'authorized' && (
                          <button onClick={() => baixarDace(d.id, d.numero)}
                            className="text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 text-xs border border-slate-300 rounded-md px-2 py-1">
                            <Download size={13} /> DACE
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!lista.length && <tr><td colSpan={9} className="py-6 text-center text-slate-400 text-sm">Nenhuma DC-e emitida ainda.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
