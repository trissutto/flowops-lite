'use client';

/**
 * /retaguarda/clientes-duplicados
 *
 * Admin: unificação de cadastros duplicados do Giga POR LOJA.
 *
 * Caso Livia (03/07, Piracicaba): a mesma cliente com 2 cadastros na loja —
 * um com CPF e um sem (cadastro rápido de balcão), com o crediário pendurado
 * no sem-CPF. A tela lista os grupos (mesmo CPF ou mesmo nome), mostra onde
 * as parcelas estão e move tudo pro cadastro escolhido como principal:
 * parcelas (movimento) + histórico de compras (caixa) + campos vazios.
 * O cadastro antigo fica marcado '#UNIF>cod' no Giga (nada é deletado).
 */

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Search, Users, ArrowRightLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';

type Cli = {
  codCliente: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  parcelasAbertas: number;
};
type Grupo = { motivo: 'nome' | 'cpf'; chave: string; clientes: Cli[] };

export default function ClientesDuplicadosPage() {
  const [storeCode, setStoreCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [grupos, setGrupos] = useState<Grupo[] | null>(null);
  const [loja, setLoja] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Seleção do cadastro PRINCIPAL (destino) por grupo — key = índice do grupo
  const [destinoPorGrupo, setDestinoPorGrupo] = useState<Record<number, string>>({});
  const [unificando, setUnificando] = useState<string | null>(null);
  const [feito, setFeito] = useState<string[]>([]);

  const buscar = async () => {
    const code = storeCode.replace(/\D/g, '');
    if (!code) { setErr('Informe o código da loja (ex: 05)'); return; }
    setLoading(true);
    setErr(null);
    setGrupos(null);
    setFeito([]);
    setDestinoPorGrupo({});
    try {
      const r = await api<{ loja: string; grupos: Grupo[] }>(
        `/crediarios/baixa/clientes-duplicados?storeCode=${encodeURIComponent(code)}`,
      );
      setLoja(r.loja);
      setGrupos(r.grupos || []);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao buscar duplicados');
    } finally {
      setLoading(false);
    }
  };

  const unificar = async (gIdx: number, grupo: Grupo) => {
    const destino = destinoPorGrupo[gIdx];
    if (!destino) { setErr('Escolha qual cadastro fica como PRINCIPAL (destino)'); return; }
    const origens = grupo.clientes.filter((c) => c.codCliente !== destino);
    if (origens.length === 0) return;
    setErr(null);

    // 1) Dry-run de cada origem → prévia consolidada pro confirm
    setUnificando(`${gIdx}`);
    try {
      const previews: string[] = [];
      for (const o of origens) {
        const p = await api<any>('/crediarios/baixa/unificar-clientes', {
          method: 'POST',
          body: JSON.stringify({ storeCode: loja, codOrigem: o.codCliente, codDestino: destino, dryRun: true }),
        });
        previews.push(
          `cód ${o.codCliente} (${p.origem?.nome || '—'}) → cód ${destino}: ` +
          `${p.parcelasAbertas} parcelas abertas, ${p.movimentoLinhas} linhas de crediário, ` +
          `${p.caixaLinhas} compras no histórico` +
          (p.camposACopiar?.length ? `, copia ${p.camposACopiar.join('/')}` : ''),
        );
      }
      const ok = window.confirm(
        `UNIFICAR na loja ${loja}?\n\n${previews.join('\n')}\n\n` +
        `O cadastro antigo fica marcado '#UNIF>' no Giga (nada é apagado). Confirma?`,
      );
      if (!ok) return;

      // 2) Executa de verdade, uma origem por vez
      for (const o of origens) {
        await api<any>('/crediarios/baixa/unificar-clientes', {
          method: 'POST',
          body: JSON.stringify({ storeCode: loja, codOrigem: o.codCliente, codDestino: destino }),
        });
      }
      setFeito((prev) => [...prev, `${gIdx}`]);
    } catch (e: any) {
      setErr(e?.message || 'Falha na unificação');
    } finally {
      setUnificando(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800 flex items-center gap-1 text-sm">
            <ArrowLeft className="w-4 h-4" /> Voltar
          </Link>
          <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <Users className="w-5 h-5" /> Clientes duplicados (Giga)
          </h1>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
          <div className="text-xs text-slate-500 leading-snug">
            Lista cadastros duplicados da loja no Wincred (mesmo CPF ou mesmo nome) e unifica:
            move o crediário e o histórico de compras pro cadastro principal. O antigo fica
            marcado <b>#UNIF&gt;</b> — nada é apagado do Giga.
          </div>
          <div className="flex gap-2">
            <input
              value={storeCode}
              onChange={(e) => setStoreCode(e.target.value)}
              placeholder="Código da loja (ex: 05)"
              className="flex-1 border-2 border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
              onKeyDown={(e) => e.key === 'Enter' && buscar()}
            />
            <button
              onClick={buscar}
              disabled={loading}
              className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg font-bold text-sm flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Buscar duplicados
            </button>
          </div>
        </div>

        {err && (
          <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-3 text-sm text-rose-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {err}
          </div>
        )}

        {grupos && grupos.length === 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
            ✓ Nenhum cadastro duplicado encontrado na loja {loja}.
          </div>
        )}

        {grupos && grupos.map((g, gIdx) => {
          const jaFeito = feito.includes(`${gIdx}`);
          return (
            <div key={gIdx} className={`bg-white rounded-xl border-2 p-4 space-y-2 ${jaFeito ? 'border-emerald-300 opacity-70' : 'border-amber-300'}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold uppercase text-amber-800">
                  {g.motivo === 'cpf' ? `Mesmo CPF · ${g.chave}` : `Mesmo nome`}
                </div>
                {jaFeito && (
                  <span className="text-xs font-bold text-emerald-700 flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" /> Unificado
                  </span>
                )}
              </div>

              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {g.clientes.map((c) => (
                  <label
                    key={c.codCliente}
                    className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-violet-50 ${destinoPorGrupo[gIdx] === c.codCliente ? 'bg-violet-50' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`destino-${gIdx}`}
                      checked={destinoPorGrupo[gIdx] === c.codCliente}
                      onChange={() => setDestinoPorGrupo((prev) => ({ ...prev, [gIdx]: c.codCliente }))}
                      disabled={jaFeito}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-slate-800 truncate">{c.nome}</div>
                      <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-2">
                        <span>cód {c.codCliente}</span>
                        <span>{c.cpf ? `CPF ${c.cpf}` : '— SEM CPF —'}</span>
                        {c.telefone && <span>tel {c.telefone}</span>}
                      </div>
                    </div>
                    {c.parcelasAbertas > 0 && (
                      <span className="text-[10px] font-bold bg-rose-100 text-rose-800 rounded px-1.5 py-0.5 shrink-0">
                        {c.parcelasAbertas} parcela{c.parcelasAbertas > 1 ? 's' : ''} aberta{c.parcelasAbertas > 1 ? 's' : ''}
                      </span>
                    )}
                  </label>
                ))}
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">
                  Marque o cadastro <b>PRINCIPAL</b> (de preferência o COM CPF) — os outros são unificados nele.
                </div>
                <button
                  onClick={() => unificar(gIdx, g)}
                  disabled={!destinoPorGrupo[gIdx] || unificando !== null || jaFeito}
                  className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-lg font-bold text-xs flex items-center gap-1.5 shrink-0"
                >
                  {unificando === `${gIdx}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                  Unificar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
