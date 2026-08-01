'use client';

/**
 * /retaguarda/giga-sombra
 *
 * Acompanhamento do MODO SOMBRA da saída do Giga (Fase 1).
 *
 * A consulta nova roda no Postgres em paralelo, mas quem responde ao sistema
 * continua sendo o Giga. Esta tela mostra se as duas concordam — é o placar
 * que decide quando virar a chave.
 *
 * Feita pra ser olhada NO CELULAR, dentro da loja, durante o teste: números
 * grandes, atualização automática, e a leitura do resultado escrita na tela
 * (divergência em produto duplicado costuma ser latência do estoque, não erro
 * — e sem isso escrito, a conclusão errada é a mais provável).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Eye, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';

type Metodo = {
  metodo: string;
  iguais: number;
  formato: number;
  diferentes: number;
  erros: number;
  taxa: string;
  ultimaDivergencia?: string;
  ultimaEm?: string;
};

type Resp = {
  ligado: boolean;
  aviso?: string;
  metodos: Metodo[];
  total: { iguais: number; formato: number; diferentes: number; erros: number };
  nota?: string;
};

export default function GigaSombraPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [auto, setAuto] = useState(true);

  const carregar = useCallback(async () => {
    try {
      setData(await api<Resp>('/erp/sombra'));
      setErro(null);
    } catch (e: any) {
      setErro(e?.message || 'Falha ao ler o placar');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // 20s: o placar muda no ritmo do bipe da loja, não precisa de mais.
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(carregar, 20_000);
    return () => clearInterval(id);
  }, [auto, carregar]);

  const t = data?.total;
  const total = t ? t.iguais + t.formato + t.diferentes : 0;
  const acertos = t ? t.iguais + t.formato : 0;
  const taxa = total ? (acertos / total) * 100 : 0;

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-slate-800">Saída do Giga · modo sombra</h1>
            <p className="text-sm text-slate-500">
              A consulta nova roda no Postgres; quem responde continua sendo o Giga.
            </p>
          </div>
          <button
            onClick={() => setAuto((v) => !v)}
            className={`rounded-lg px-3 py-2 text-xs font-bold ${
              auto ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
            }`}
          >
            {auto ? '● ao vivo' : '‖ pausado'}
          </button>
          <button
            onClick={carregar}
            className="rounded-lg bg-slate-800 p-2 text-white hover:bg-slate-700"
            aria-label="Atualizar"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {carregando && (
          <div className="flex items-center gap-2 rounded-lg bg-white p-6 text-slate-500 shadow">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </div>
        )}

        {erro && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {erro}
          </div>
        )}

        {/* Sem a flag, placar vazio parece "tudo certo" — o pior mal-entendido
            possível nesta tela. Por isso o aviso é grande e vem primeiro. */}
        {data && !data.ligado && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="text-sm text-amber-900">
              <p className="font-bold">A sombra está DESLIGADA — nada está sendo comparado.</p>
              <p className="mt-1">
                Crie a variável <code className="rounded bg-amber-200 px-1">GIGA_SOMBRA=1</code> no
                Railway (serviço flowops-lite). Enquanto isso, os números abaixo não significam nada.
              </p>
            </div>
          </div>
        )}

        {data && data.ligado && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Cartao rotulo="Iguais" valor={t!.iguais} cor="text-emerald-600" />
              <Cartao
                rotulo="Só formato"
                valor={t!.formato}
                cor="text-sky-600"
                dica="Mesmo produto, zero à esquerda diferente. Conta como acerto."
              />
              <Cartao
                rotulo="Divergentes"
                valor={t!.diferentes}
                cor={t!.diferentes ? 'text-red-600' : 'text-slate-400'}
              />
              <Cartao rotulo="Erros" valor={t!.erros} cor={t!.erros ? 'text-amber-600' : 'text-slate-400'} />
            </div>

            <div className="mb-5 rounded-lg bg-white p-5 shadow">
              <div className="flex items-baseline gap-3">
                <span className="text-4xl font-bold text-slate-800">
                  {total ? `${taxa.toFixed(2)}%` : '—'}
                </span>
                <span className="text-sm text-slate-500">
                  de concordância em {total.toLocaleString('pt-BR')} comparações
                </span>
              </div>
              {total === 0 && (
                <p className="mt-2 text-sm text-slate-500">
                  Nenhuma comparação ainda. O placar enche conforme as lojas bipam no
                  realinhamento e na entrada de remessa.
                </p>
              )}
              {total > 0 && t!.diferentes === 0 && (
                <p className="mt-2 flex items-center gap-1.5 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" /> Nenhuma divergência até agora.
                </p>
              )}
            </div>

            <div className="overflow-hidden rounded-lg bg-white shadow">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Método</th>
                    <th className="px-3 py-2 text-right">Iguais</th>
                    <th className="px-3 py-2 text-right">Formato</th>
                    <th className="px-3 py-2 text-right">Diverg.</th>
                    <th className="px-3 py-2 text-right">Taxa</th>
                  </tr>
                </thead>
                <tbody>
                  {data.metodos.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                        Aguardando o primeiro bipe.
                      </td>
                    </tr>
                  )}
                  {data.metodos.map((m) => (
                    <tr key={m.metodo} className="border-t border-slate-100">
                      <td className="px-4 py-3">
                        <div className="font-mono text-xs font-semibold text-slate-800">{m.metodo}</div>
                        {m.ultimaDivergencia && (
                          <div className="mt-1 break-all font-mono text-[11px] text-red-600">
                            {m.ultimaDivergencia}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-emerald-700">{m.iguais}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-sky-700">{m.formato}</td>
                      <td
                        className={`px-3 py-3 text-right tabular-nums ${
                          m.diferentes ? 'font-bold text-red-600' : 'text-slate-400'
                        }`}
                      >
                        {m.diferentes}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums">{m.taxa}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Sem isto, divergência vira alarme falso e alguém manda reverter
                uma migração que está correta. */}
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
              <Eye className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              <div>
                <p className="font-semibold text-slate-700">Como ler divergência</p>
                <p className="mt-1">
                  Em produto <strong>duplicado</strong> (mesma REF+cor+tamanho em códigos
                  diferentes), o desempate é “quem tem mais estoque” — e o espelho de estoque
                  atualiza de hora em hora. Divergência aí é <strong>latência</strong>, não erro de
                  tradução, e some quando o estoque virar nativo.
                </p>
                <p className="mt-1">
                  Divergência em produto <strong>não duplicado</strong> é tradução errada. Essa
                  precisa ser investigada antes de virar a chave.
                </p>
                <p className="mt-2 text-slate-500">
                  Nada disso afeta a loja: o sistema responde com o Giga o tempo todo.
                </p>
              </div>
            </div>

            <button
              onClick={async () => {
                if (!confirm('Zerar o placar? Use ao começar uma janela nova de observação.')) return;
                await api('/erp/sombra/zerar', { method: 'POST' });
                carregar();
              }}
              className="mt-4 flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              <RotateCcw className="h-4 w-4" /> Zerar placar
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Cartao({ rotulo, valor, cor, dica }: { rotulo: string; valor: number; cor: string; dica?: string }) {
  return (
    <div className="rounded-lg bg-white p-4 shadow" title={dica}>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{rotulo}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${cor}`}>{valor.toLocaleString('pt-BR')}</div>
    </div>
  );
}
