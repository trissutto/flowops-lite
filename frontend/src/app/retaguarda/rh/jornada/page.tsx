'use client';

/**
 * /retaguarda/rh/jornada — o horário CADASTRADO × o que a loja realmente faz.
 *
 * Nasceu do sábado (dono, 11/09/2026): "o sábado do interior está descontando
 * 4h e não é". O ponto não errou nada. O espelho tira `minPrevisto` inteirinho
 * de `Seller.horarioTrabalho`, e o cadastro dizia sábado de 09:00–18:00 em loja
 * que fecha 13:00 — o "aplicar padrão" da ficha carimbava 48h/semana. Toda
 * semana o saldo nascia 4h no vermelho, sem erro na tela, sem alerta, sem
 * ninguém saber de onde vinha.
 *
 * A tela faz duas coisas e só:
 *   1. MOSTRA os dois lados lado a lado (previsto do papel × mediana batida);
 *   2. CORRIGE o dia pra loja inteira de uma vez — porque o horário é da LOJA,
 *      e consertar 30 fichas uma a uma é tarefa que fica pela metade.
 *
 * O que ela deliberadamente NÃO faz: adivinhar o horário certo. Quem digita a
 * hora é quem conhece a loja; a tela sugere o que as batidas mostram e espera
 * a confirmação.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, AlertTriangle, CalendarClock, CheckCircle2, Loader2, RefreshCw, Store,
} from 'lucide-react';
import { api } from '@/lib/api';

type Item = {
  sellerId: string;
  nome: string;
  storeId: string | null;
  lojaCodigo: string | null;
  lojaNome: string | null;
  cadastrado:
    | { folga: true }
    | {
        folga: false;
        inicio: string | null;
        fim: string | null;
        almocoInicio: string | null;
        almocoFim: string | null;
      }
    | null;
  minPrevisto: number;
  diasComBatida: number;
  minRealMediana: number | null;
  saidaTipica: string | null;
  difMin: number | null;
  veredito: 'ok' | 'sem_batida' | 'sem_cadastro' | 'cadastro_maior' | 'cadastro_menor';
};

type Conferencia = {
  dia: string;
  semanas: number;
  itens: Item[];
  totais: {
    funcionarias: number;
    cadastroMaior: number;
    cadastroMenor: number;
    semCadastro: number;
    minDescontadosPorSemana: number;
  } | null;
};

type Loja = { id: string; code: string; name: string; active?: boolean };

const DIAS = [
  { key: 'SEG', label: 'Segunda' },
  { key: 'TER', label: 'Terça' },
  { key: 'QUA', label: 'Quarta' },
  { key: 'QUI', label: 'Quinta' },
  { key: 'SEX', label: 'Sexta' },
  { key: 'SAB', label: 'Sábado' },
  { key: 'DOM', label: 'Domingo' },
];

const fmtMin = (min: number | null) => {
  if (min === null) return '—';
  const sinal = min < 0 ? '-' : '';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (abs === 0) return '0h';
  return m === 0 ? `${sinal}${h}h` : `${sinal}${h}h${String(m).padStart(2, '0')}`;
};

const janela = (c: Item['cadastrado']) => {
  if (!c) return 'sem esse dia no cadastro';
  if (c.folga) return 'folga';
  const almoco =
    c.almocoInicio && c.almocoFim && c.almocoInicio !== c.almocoFim
      ? ` (almoço ${c.almocoInicio}–${c.almocoFim})`
      : ' (sem intervalo)';
  return `${c.inicio}–${c.fim}${almoco}`;
};

const VEREDITO: Record<Item['veredito'], { rotulo: string; cor: string }> = {
  cadastro_maior: { rotulo: 'cadastro cobra a mais', cor: 'bg-rose-100 text-rose-800' },
  cadastro_menor: { rotulo: 'trabalha mais que o cadastro', cor: 'bg-amber-100 text-amber-800' },
  sem_batida: { rotulo: 'sem batida no período', cor: 'bg-slate-100 text-slate-600' },
  sem_cadastro: { rotulo: 'dia fora do cadastro', cor: 'bg-slate-100 text-slate-600' },
  ok: { rotulo: 'confere', cor: 'bg-emerald-100 text-emerald-800' },
};

export default function JornadaCadastradaPage() {
  const [dia, setDia] = useState('SAB');
  const [storeId, setStoreId] = useState('');
  const [semanas, setSemanas] = useState(8);
  const [lojas, setLojas] = useState<Loja[]>([]);
  const [dados, setDados] = useState<Conferencia | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [abrirCorrigir, setAbrirCorrigir] = useState(false);

  useEffect(() => {
    api<Loja[]>('/stores')
      .then((r) => setLojas(r.filter((l) => l.active !== false)))
      .catch(() => setLojas([]));
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams({ dia, semanas: String(semanas) });
      if (storeId) qs.set('storeId', storeId);
      setDados(await api<Conferencia>(`/ponto/jornada/conferir?${qs}`));
    } catch (e: any) {
      // Erro SOBE: lista vazia em silêncio aqui vira "está tudo certo", que é
      // exatamente a conclusão errada.
      setErro(e?.message || 'Não consegui conferir a jornada.');
      setDados(null);
    } finally {
      setCarregando(false);
    }
  }, [dia, storeId, semanas]);

  useEffect(() => { void carregar(); }, [carregar]);

  const divergentes = useMemo(
    () => (dados?.itens ?? []).filter((i) => i.veredito === 'cadastro_maior'),
    [dados],
  );
  const diaLabel = DIAS.find((d) => d.key === dia)?.label ?? dia;
  // Sugestão de horário: a saída típica das que estão divergindo. É palpite
  // com origem declarada — quem confirma é quem conhece a loja.
  const saidaSugerida = divergentes.find((i) => i.saidaTipica)?.saidaTipica ?? '13:00';

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 text-white">
        <div className="max-w-7xl mx-auto px-4 py-5 flex items-center gap-3">
          <Link href="/retaguarda/rh" className="p-2 rounded-lg hover:bg-white/10 transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold leading-tight">Jornada cadastrada</h1>
            <p className="text-white/70 text-sm">
              O horário do papel × o que a loja realmente faz
            </p>
          </div>
          <button
            onClick={() => setAbrirCorrigir(true)}
            disabled={!storeId}
            title={storeId ? '' : 'Escolha a loja primeiro'}
            className="flex items-center gap-2 bg-white text-slate-800 font-bold px-4 py-2 rounded-lg hover:bg-slate-100 transition disabled:opacity-40"
          >
            <CalendarClock className="w-4 h-4" /> Corrigir {diaLabel.toLowerCase()} da loja
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <div className="bg-white rounded-xl border p-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Dia</label>
            <select value={dia} onChange={(e) => setDia(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm">
              {DIAS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </div>
          <div className="min-w-[200px]">
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Loja</label>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Todas</option>
              {lojas.map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
              Olhando as últimas
            </label>
            <select value={semanas} onChange={(e) => setSemanas(Number(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm">
              {[4, 8, 12, 26].map((n) => <option key={n} value={n}>{n} semanas</option>)}
            </select>
          </div>
          <button onClick={() => void carregar()}
            className="p-2 border rounded-lg hover:bg-slate-50" title="Recarregar">
            <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {erro && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-4 flex gap-2 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0" /> {erro}
          </div>
        )}

        {dados?.totais && divergentes.length > 0 && (
          <div className="bg-rose-50 border-2 border-rose-300 rounded-xl p-4 flex gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-700 shrink-0 mt-0.5" />
            <div className="text-sm text-rose-900">
              <p className="font-bold">
                {divergentes.length} funcionária(s) com {diaLabel.toLowerCase()} maior no
                cadastro do que na porta da loja.
              </p>
              <p className="mt-1">
                Junto, o espelho tira{' '}
                <b>{fmtMin(dados.totais.minDescontadosPorSemana)}</b> do saldo
                a cada {diaLabel.toLowerCase()} — cerca de{' '}
                <b>{fmtMin(dados.totais.minDescontadosPorSemana * 4)}</b> por mês.
                Não é falta: é o horário do papel cobrando hora que a loja não abre.
              </p>
            </div>
          </div>
        )}

        {dados?.totais && divergentes.length === 0 && !carregando && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex gap-3 text-sm text-emerald-900">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            Nenhum cadastro cobrando mais horas do que a loja abre {diaLabel.toLowerCase()}.
          </div>
        )}

        <div className="bg-white rounded-xl border overflow-hidden">
          {carregando ? (
            <div className="p-10 text-center text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin mx-auto" />
            </div>
          ) : !dados || dados.itens.length === 0 ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              <Store className="w-8 h-8 mx-auto mb-2 opacity-40" />
              Nenhuma funcionária ativa nesse recorte.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Funcionária</th>
                    <th className="px-3 py-2">Loja</th>
                    <th className="px-3 py-2">{diaLabel} no cadastro</th>
                    <th className="px-3 py-2 text-right">Previsto</th>
                    <th className="px-3 py-2 text-right">Batido (mediana)</th>
                    <th className="px-3 py-2 text-right">Diferença</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {dados.itens.map((i) => {
                    const v = VEREDITO[i.veredito];
                    return (
                      <tr key={i.sellerId} className={`border-t ${i.veredito === 'cadastro_maior' ? 'bg-rose-50/40' : ''}`}>
                        <td className="px-3 py-2 font-bold">
                          <Link href={`/retaguarda/vendedoras/${i.sellerId}`} className="hover:underline">
                            {i.nome}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-[11px] text-slate-500">
                          {i.lojaCodigo ? `${i.lojaCodigo} · ${i.lojaNome}` : '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-[12px]">{janela(i.cadastrado)}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtMin(i.minPrevisto)}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {fmtMin(i.minRealMediana)}
                          {i.saidaTipica && (
                            <div className="text-[10px] text-slate-400 font-sans">
                              sai {i.saidaTipica} · {i.diasComBatida} dia(s)
                            </div>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono font-bold ${
                          i.difMin !== null && i.difMin <= -60 ? 'text-rose-700'
                            : i.difMin !== null && i.difMin >= 60 ? 'text-amber-700' : 'text-slate-500'
                        }`}>
                          {fmtMin(i.difMin)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-[11px] px-2 py-0.5 rounded font-bold ${v.cor}`}>
                            {v.rotulo}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-[11px] text-slate-500">
          &quot;Batido&quot; é a MEDIANA dos dias com entrada e saída no período — dia
          com batida faltando fica de fora em vez de virar zero e puxar a conta
          pra baixo. Sem nenhum dia batido a tela não opina.
        </p>
      </div>

      {abrirCorrigir && storeId && (
        <ModalCorrigir
          dia={dia}
          diaLabel={diaLabel}
          loja={lojas.find((l) => l.id === storeId) ?? null}
          sugestaoFim={saidaSugerida}
          quantos={divergentes.filter((i) => i.storeId === storeId).length}
          onFechar={() => setAbrirCorrigir(false)}
          onSalvo={() => { setAbrirCorrigir(false); void carregar(); }}
        />
      )}
    </div>
  );
}

/** Grava o mesmo dia da semana em todas as funcionárias ativas da loja. */
function ModalCorrigir({
  dia, diaLabel, loja, sugestaoFim, quantos, onFechar, onSalvo,
}: {
  dia: string;
  diaLabel: string;
  loja: Loja | null;
  sugestaoFim: string;
  quantos: number;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [folga, setFolga] = useState(false);
  const [inicio, setInicio] = useState('09:00');
  const [fim, setFim] = useState(sugestaoFim);
  const [comAlmoco, setComAlmoco] = useState(false);
  const [almocoInicio, setAlmocoInicio] = useState('12:00');
  const [almocoFim, setAlmocoFim] = useState('13:00');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState<{ alteradas: number; avaliadas: number; puladas: any[] } | null>(null);

  const salvar = async () => {
    setBusy(true);
    setErro(null);
    try {
      const r = await api<{ alteradas: number; avaliadas: number; puladas: any[] }>(
        '/ponto/jornada/dia',
        {
          method: 'POST',
          body: JSON.stringify({
            storeId: loja?.id,
            dia,
            folga,
            inicio: folga ? undefined : inicio,
            fim: folga ? undefined : fim,
            almocoInicio: folga || !comAlmoco ? null : almocoInicio,
            almocoFim: folga || !comAlmoco ? null : almocoFim,
          }),
        },
      );
      setFeito(r);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui gravar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b">
          <h2 className="font-bold text-lg">{diaLabel} de {loja?.code} · {loja?.name}</h2>
          <p className="text-xs text-slate-500">
            Grava em todas as funcionárias ativas desta loja. Os outros dias da
            semana e a folga de cada uma ficam como estão.
          </p>
        </div>

        {feito ? (
          <div className="p-5 space-y-3">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm text-emerald-900 flex gap-2">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <div>
                <p className="font-bold">
                  {feito.alteradas} de {feito.avaliadas} cadastro(s) atualizado(s).
                </p>
                <p className="text-xs mt-1">
                  Quem já estava com esse horário não foi reescrita. O espelho do
                  mês passa a contar o novo previsto na hora.
                </p>
              </div>
            </div>
            {feito.puladas?.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
                <p className="font-bold mb-1">
                  {feito.puladas.length} ficaram de fora — precisam da semana
                  preenchida na ficha:
                </p>
                <ul className="list-disc pl-4">
                  {feito.puladas.map((p: any) => (
                    <li key={p.sellerId}>{p.nome} — {p.motivo}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <button onClick={onSalvo}
                className="px-4 py-2 rounded-lg bg-slate-800 text-white font-bold text-sm">
                Fechar
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-5 space-y-4">
              {quantos > 0 && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-900">
                  {quantos} funcionária(s) desta loja estão hoje com {diaLabel.toLowerCase()}{' '}
                  maior no cadastro do que na porta.
                </div>
              )}

              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={folga}
                  onChange={(e) => setFolga(e.target.checked)} />
                A loja não abre {diaLabel.toLowerCase()} (marcar como folga)
              </label>

              {!folga && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Entrada</label>
                      <input type="time" value={inicio} onChange={(e) => setInicio(e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Saída</label>
                      <input type="time" value={fim} onChange={(e) => setFim(e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                  </div>

                  {/* Intervalo é OPT-IN: sábado de 4h não tem almoço obrigatório
                      (a CLT só exige acima de 6h), e um almoço fantasma de 1h
                      derrubaria o previsto de 4h pra 3h — o mesmo erro, ao
                      contrário. */}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={comAlmoco}
                      onChange={(e) => setComAlmoco(e.target.checked)} />
                    Tem intervalo de almoço neste dia
                  </label>
                  {comAlmoco && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Saída almoço</label>
                        <input type="time" value={almocoInicio} onChange={(e) => setAlmocoInicio(e.target.value)}
                          className="w-full border rounded-lg px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Volta almoço</label>
                        <input type="time" value={almocoFim} onChange={(e) => setAlmocoFim(e.target.value)}
                          className="w-full border rounded-lg px-3 py-2 text-sm" />
                      </div>
                    </div>
                  )}
                </>
              )}

              {erro && (
                <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3 text-sm flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {erro}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t flex justify-end gap-2">
              <button onClick={onFechar}
                className="px-4 py-2 rounded-lg border font-semibold text-sm">
                Cancelar
              </button>
              <button onClick={() => void salvar()} disabled={busy}
                className="px-4 py-2 rounded-lg bg-slate-800 text-white font-bold text-sm disabled:opacity-40 flex items-center gap-2">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Aplicar na loja
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
