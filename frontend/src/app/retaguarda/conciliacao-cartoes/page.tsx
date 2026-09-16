'use client';

/**
 * /retaguarda/conciliacao-cartoes — CONFERÊNCIA DOS CARTÕES (16/09/2026).
 *
 * Checklist diário da matriz: cada venda no cartão do PDV × a transação da
 * maquininha Stone, por loja e dia. O arquivo da Stone de um dia sai a partir
 * das 4h do dia seguinte; o Flow busca sozinho às 6h40 e repesca às 9h40,
 * 13h40 e 18h40. Sem o arquivo, o dia fica "Aguardando a Stone" — nunca vira
 * divergência.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, CreditCard, Loader2, MessageCircle, RefreshCw, Settings2, Send, X } from 'lucide-react';
import { api } from '@/lib/api';
import EnterpriseShell from '@/components/enterprise/EnterpriseShell';
import PageHeader from '@/components/enterprise/PageHeader';
import MetricStrip, { BarraSegmentos } from '@/components/enterprise/MetricStrip';
import { EmptyState } from '@/components/enterprise/Indicators';
import { BTN_ESCURO, BTN_PRIMARIO, BTN_SECUNDARIO, CAMPO, ROTULO } from '@/components/enterprise/Form';
import DetalheDia from './DetalheDia';
import ConfigStone from './ConfigStone';
import {
  LinhaLista,
  RespostaLista,
  STATUS,
  StatusDia,
  TOM_PONTO,
  TOM_TEXTO,
  dataHoraBr,
  diaMais,
  hojeBr,
  inicioDoMesBr,
  reais,
} from './tipos';

type Aba = 'todos' | 'divergente' | 'atencao' | 'aguardando' | 'confere' | 'sem_stone';

const ABAS: { id: Aba; rotulo: string; status: StatusDia[] | null }[] = [
  { id: 'todos', rotulo: 'Todos', status: null },
  { id: 'divergente', rotulo: 'Divergência', status: ['divergente'] },
  { id: 'atencao', rotulo: 'Atenção', status: ['atencao'] },
  { id: 'aguardando', rotulo: 'Aguardando Stone', status: ['aguardando_arquivo', 'erro_arquivo'] },
  { id: 'confere', rotulo: 'Batem', status: ['confere'] },
  { id: 'sem_stone', rotulo: 'Sem StoneCode', status: ['sem_stone'] },
];

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      }
    >
      <ConferenciaCartoes />
    </Suspense>
  );
}

function ConferenciaCartoes() {
  const params = useSearchParams();
  const diaDoLink = params.get('dia');
  const [periodo, setPeriodo] = useState(() => ({
    de: diaDoLink || diaMais(hojeBr(), -7),
    ate: diaDoLink || diaMais(hojeBr(), -1),
  }));
  const [dados, setDados] = useState<RespostaLista | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [aba, setAba] = useState<Aba>('todos');
  const [aberto, setAberto] = useState<{ storeCode: string; dia: string } | null>(null);
  const [config, setConfig] = useState(false);
  const [resumo, setResumo] = useState(false);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => setRole(me.role))
      .catch(() => setRole(null));
  }, []);

  const carregar = useCallback(async () => {
    if (!periodo.de || !periodo.ate) return;
    setCarregando(true);
    setErro(null);
    try {
      const d = await api<RespostaLista>(
        `/admin/conciliacao-cartao/lista?de=${periodo.de}&ate=${periodo.ate}`,
      );
      setDados(d);
    } catch (e: any) {
      setErro(e?.body?.message || 'Não consegui carregar a conferência');
    } finally {
      setCarregando(false);
    }
  }, [periodo.de, periodo.ate]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const linhas = dados?.linhas || [];
  const contar = (st: StatusDia[]) => linhas.filter((l) => st.includes(l.status)).length;
  const visiveis = useMemo(() => {
    const filtro = ABAS.find((a) => a.id === aba)?.status;
    return filtro ? linhas.filter((l) => filtro.includes(l.status)) : linhas;
  }, [linhas, aba]);

  const podeAgir = role === 'admin' || role === 'supervisor';
  const admin = role === 'admin';
  const n = {
    confere: contar(['confere']),
    atencao: contar(['atencao']),
    divergente: contar(['divergente']),
    aguardando: contar(['aguardando_arquivo', 'erro_arquivo']),
    semStone: contar(['sem_stone']),
  };

  return (
    <EnterpriseShell trilha={[{ label: 'Início', href: '/' }, { label: 'Gestão', href: '/retaguarda' }, { label: 'Conferência dos cartões' }]}>
      <div className="bg-oo-nav pb-16 sm:pb-20">
        <div className="mx-auto w-full max-w-[2400px] px-4 pt-6 sm:px-6 sm:pt-8 2xl:px-12">
          <PageHeader
            escuro
            icone={<CreditCard className="h-5 w-5" />}
            titulo="Conferência dos cartões"
            subtitulo="Vendas no cartão do PDV × transações da maquininha Stone · por loja e dia"
            acoes={
              <>
                {podeAgir && (
                  <button type="button" onClick={() => setResumo(true)} className={BTN_ESCURO}>
                    <MessageCircle className="h-4 w-4" />
                    <span className="hidden sm:inline">Resumo do WhatsApp</span>
                    <span className="sm:hidden">Resumo</span>
                  </button>
                )}
                {podeAgir && (
                  <button type="button" onClick={() => setConfig(true)} className={`${BTN_PRIMARIO} focus-visible:ring-offset-oo-nav`}>
                    <Settings2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Configurar Stone</span>
                    <span className="sm:hidden">Configurar</span>
                  </button>
                )}
              </>
            }
          />
          <div className="mt-6 sm:mt-8">
            <MetricStrip
              escuro
              carregando={!dados}
              metricas={[
                {
                  rotulo: 'Lojas × dias',
                  valor: linhas.length,
                  viz: (
                    <BarraSegmentos
                      escuro
                      partes={[
                        { valor: n.confere, cor: 'bg-[#47CD89]', title: `${n.confere} batem` },
                        { valor: n.atencao, cor: 'bg-[#FDB022]', title: `${n.atencao} com atenção` },
                        { valor: n.divergente, cor: 'bg-[#FF8A7A]', title: `${n.divergente} com divergência` },
                        { valor: n.aguardando, cor: 'bg-[#53B1FD]', title: `${n.aguardando} aguardando a Stone` },
                        { valor: n.semStone, cor: 'bg-slate-500', title: `${n.semStone} sem StoneCode` },
                      ]}
                    />
                  ),
                  apoio: `${n.confere} batem · ${n.divergente} com divergência`,
                },
                {
                  rotulo: 'Com divergência',
                  valor: n.divergente,
                  tom: n.divergente > 0 ? 'danger' : undefined,
                  apoio: `${reais(dados?.totais.valorDivergente ?? 0)} em jogo`,
                },
                {
                  rotulo: 'Vendido no cartão',
                  valor: reais(dados?.totais.valorSistema ?? 0),
                  apoio: `na Stone: ${reais(dados?.totais.valorStone ?? 0)}`,
                },
                {
                  rotulo: 'Aguardando a Stone',
                  valor: n.aguardando,
                  tom: n.aguardando > 0 ? 'warning' : undefined,
                  apoio: 'o arquivo do dia sai às 4h do dia seguinte',
                },
                {
                  rotulo: 'Sem StoneCode',
                  valor: n.semStone,
                  tom: n.semStone > 0 ? 'warning' : undefined,
                  apoio: 'cadastre em Configurar Stone',
                },
              ]}
            />
          </div>
        </div>
      </div>

      <main className="mx-auto -mt-10 w-full max-w-[2400px] px-4 pb-12 sm:-mt-12 sm:px-6 2xl:px-12">
        <section className="relative rounded-xl border border-oo-line bg-oo-surface shadow-[0_1px_2px_rgba(16,24,40,.06),0_8px_24px_-12px_rgba(16,24,40,.12)]">
          {dados && (dados.chaves === 0 || dados.lojasComStone === 0) && (
            <div className="flex flex-wrap items-start gap-3 border-b border-oo-line bg-oo-warning-soft px-4 py-3 text-[14px] sm:px-6">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-oo-warning" />
              <p className="min-w-[240px] flex-1 leading-relaxed">
                {dados.chaves === 0 ? (
                  <>
                    <b>A Stone ainda não está ligada.</b> O titular da conta gera a chave no Portal Stone (Perfil → Chaves de
                    Autenticação → Criar Chave → &quot;API de Conciliação Stone&quot;) e cola no Railway, em{' '}
                    <code className="rounded bg-oo-surface px-1">STONE_CONCILIACAO_CHAVES</code>.{' '}
                  </>
                ) : null}
                {dados.lojasComStone === 0 ? <>Falta cadastrar o <b>StoneCode de cada loja</b>. </> : null}
                Até lá, a lista mostra só o lado do sistema.
              </p>
              {podeAgir && (
                <button type="button" onClick={() => setConfig(true)} className={`${BTN_SECUNDARIO} h-9`}>
                  <Settings2 className="h-4 w-4" /> Configurar
                </button>
              )}
            </div>
          )}

          <div className="flex overflow-x-auto border-b border-oo-line px-2 [scrollbar-width:none] sm:px-4" role="tablist" aria-label="Filtrar por situação">
            {ABAS.map((a) => {
              const ativo = aba === a.id;
              const qtd = a.status ? contar(a.status) : linhas.length;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={ativo}
                  onClick={() => setAba(a.id)}
                  className={`relative flex h-12 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold uppercase tracking-[0.04em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oo-primary ${
                    ativo ? 'text-oo-ink' : 'text-oo-muted hover:text-oo-ink'
                  }`}
                >
                  {a.rotulo}
                  <span className={`rounded px-1.5 py-0.5 text-[12px] tabular-nums tracking-normal ${ativo ? 'bg-oo-ink text-white' : 'bg-oo-hover text-oo-ink-2'}`}>
                    {dados ? qtd : '–'}
                  </span>
                  {ativo && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-oo-ink" />}
                </button>
              );
            })}
          </div>

          <FiltroPeriodo periodo={periodo} onChange={setPeriodo} carregando={carregando} onRecarregar={carregar} />

          {erro && <p className="m-4 rounded-lg bg-oo-danger-soft p-3 text-[14px] text-oo-danger">{erro}</p>}

          {!dados && !erro ? (
            <p className="flex items-center gap-2 px-6 py-16 text-oo-muted">
              <Loader2 className="h-5 w-5 animate-spin" /> Carregando…
            </p>
          ) : visiveis.length === 0 ? (
            <EmptyState
              icone={<CreditCard className="h-5 w-5" />}
              titulo={linhas.length ? 'Nada nesta aba' : 'Nenhuma venda no cartão no período'}
              texto={linhas.length ? 'Troque a aba ou o período.' : 'Escolha outro período.'}
            />
          ) : (
            <TabelaDias linhas={visiveis} onAbrir={(l) => setAberto({ storeCode: l.storeCode, dia: l.dia })} />
          )}
        </section>
      </main>

      {aberto && (
        <DetalheDia
          storeCode={aberto.storeCode}
          dia={aberto.dia}
          podeAgir={podeAgir}
          onFechar={() => setAberto(null)}
          onMudou={carregar}
        />
      )}
      {config && <ConfigStone podeEditar={admin} onFechar={() => setConfig(false)} onSalvou={carregar} />}
      {resumo && <ResumoWhatsapp podeEnviar={admin} onFechar={() => setResumo(false)} />}
    </EnterpriseShell>
  );
}

function FiltroPeriodo({
  periodo,
  onChange,
  carregando,
  onRecarregar,
}: {
  periodo: { de: string; ate: string };
  onChange: (p: { de: string; ate: string }) => void;
  carregando: boolean;
  onRecarregar: () => void;
}) {
  const hoje = hojeBr();
  const ATALHOS = [
    { rotulo: 'Hoje', de: hoje, ate: hoje },
    { rotulo: 'Ontem', de: diaMais(hoje, -1), ate: diaMais(hoje, -1) },
    { rotulo: '7 dias', de: diaMais(hoje, -7), ate: diaMais(hoje, -1) },
    { rotulo: 'Mês', de: inicioDoMesBr(), ate: hoje },
  ];
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-oo-line px-4 py-3 sm:px-6">
      <label className="block">
        <span className={`mb-1 block ${ROTULO}`}>De</span>
        <input
          type="date"
          value={periodo.de}
          max={periodo.ate}
          onChange={(e) => e.target.value && onChange({ ...periodo, de: e.target.value })}
          className={`${CAMPO} h-9`}
        />
      </label>
      <label className="block">
        <span className={`mb-1 block ${ROTULO}`}>Até</span>
        <input
          type="date"
          value={periodo.ate}
          min={periodo.de}
          onChange={(e) => e.target.value && onChange({ ...periodo, ate: e.target.value })}
          className={`${CAMPO} h-9`}
        />
      </label>
      <div className="flex flex-wrap gap-1.5">
        {ATALHOS.map((a) => {
          const ativo = periodo.de === a.de && periodo.ate === a.ate;
          return (
            <button
              key={a.rotulo}
              type="button"
              onClick={() => onChange({ de: a.de, ate: a.ate })}
              className={`h-9 rounded-md border px-3 text-[13px] font-medium transition-colors ${
                ativo ? 'border-oo-ink bg-oo-ink text-white' : 'border-oo-line-strong bg-oo-surface text-oo-ink hover:bg-oo-subtle'
              }`}
            >
              {a.rotulo}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={onRecarregar} disabled={carregando} className={`${BTN_SECUNDARIO} ml-auto h-9`}>
        <RefreshCw className={`h-4 w-4 ${carregando ? 'animate-spin' : ''}`} /> Atualizar
      </button>
    </div>
  );
}

function Situacao({ status }: { status: StatusDia }) {
  const s = STATUS[status] || STATUS.sem_movimento;
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-semibold ${TOM_TEXTO[s.tom]}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${TOM_PONTO[s.tom]}`} aria-hidden="true" />
      {s.rotulo}
    </span>
  );
}

function TabelaDias({ linhas, onAbrir }: { linhas: LinhaLista[]; onAbrir: (l: LinhaLista) => void }) {
  const confere = (l: LinhaLista) => !['aguardando_arquivo', 'erro_arquivo', 'sem_stone', 'em_andamento'].includes(l.status);
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-b border-oo-line text-left text-[11px] uppercase tracking-[0.08em] text-oo-muted">
              <th className="px-6 py-3 font-semibold">Loja</th>
              <th className="px-3 py-3 font-semibold">Dia</th>
              <th className="px-3 py-3 font-semibold">Situação</th>
              <th className="px-3 py-3 text-right font-semibold">No sistema</th>
              <th className="px-3 py-3 text-right font-semibold">Na Stone</th>
              <th className="px-3 py-3 text-right font-semibold">Em divergência</th>
              <th className="px-3 py-3 font-semibold">O que apareceu</th>
              <th className="px-6 py-3 font-semibold">Revisão</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr
                key={`${l.storeCode}-${l.dia}`}
                onClick={() => onAbrir(l)}
                className="relative cursor-pointer border-b border-oo-line last:border-b-0 hover:bg-oo-subtle"
              >
                <td className="relative px-6 py-3">
                  {l.status === 'divergente' && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r bg-oo-danger" />}
                  {l.status === 'atencao' && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r bg-oo-warning" />}
                  <button type="button" className="text-left font-semibold hover:underline" onClick={(e) => { e.stopPropagation(); onAbrir(l); }}>
                    <span className="tabular-nums">{l.storeCode}</span> {l.storeName}
                  </button>
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums">{l.diaCurto}</td>
                <td className="px-3 py-3">
                  <Situacao status={l.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  <span className="font-semibold">{reais(l.valorSistema)}</span>
                  <span className="block text-[12px] text-oo-muted">{l.qtdSistema} pagamento(s)</span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {confere(l) ? (
                    <>
                      <span className="font-semibold">{reais(l.valorStone)}</span>
                      <span className="block text-[12px] text-oo-muted">{l.qtdStone} transação(ões)</span>
                    </>
                  ) : (
                    <span className="text-oo-muted">—</span>
                  )}
                </td>
                <td className={`whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums ${l.valorDivergente > 0 ? 'text-oo-danger' : 'text-oo-muted'}`}>
                  {confere(l) ? reais(l.valorDivergente) : '—'}
                </td>
                <td className="max-w-[420px] px-3 py-3 text-[13px] text-oo-ink-2">
                  {l.frases.length ? l.frases.slice(0, 2).join(' · ') : '—'}
                </td>
                <td className="whitespace-nowrap px-6 py-3 text-[12px] text-oo-muted">
                  {l.revisadoEm ? `${l.revisadoPor || '—'} · ${dataHoraBr(l.revisadoEm)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-oo-line lg:hidden">
        {linhas.map((l) => (
          <li key={`${l.storeCode}-${l.dia}`}>
            <button type="button" onClick={() => onAbrir(l)} className="relative block w-full px-4 py-3 text-left active:bg-oo-subtle">
              {l.status === 'divergente' && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r bg-oo-danger" />}
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold">
                  {l.storeCode} {l.storeName}
                </span>
                <span className="text-[13px] tabular-nums text-oo-ink-2">{l.diaCurto}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <Situacao status={l.status} />
                <span className="text-[13px] tabular-nums">
                  {reais(l.valorSistema)}
                  {confere(l) && l.valorDivergente > 0 && (
                    <span className="ml-2 font-semibold text-oo-danger">{reais(l.valorDivergente)}</span>
                  )}
                </span>
              </div>
              {l.frases.length > 0 && <p className="mt-1 text-[13px] text-oo-ink-2">{l.frases.slice(0, 2).join(' · ')}</p>}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ResumoWhatsapp({ podeEnviar, onFechar }: { podeEnviar: boolean; onFechar: () => void }) {
  const [texto, setTexto] = useState<string | null | undefined>(undefined);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  useEffect(() => {
    api<{ texto: string | null }>('/admin/conciliacao-cartao/resumo/previa')
      .then((r) => setTexto(r.texto))
      .catch((e) => setErro(e?.body?.message || 'Não consegui montar o resumo'));
  }, []);

  async function enviar() {
    if (!window.confirm('Mandar este resumo agora pros WhatsApps cadastrados?')) return;
    setEnviando(true);
    try {
      const r = await api<{ enviado: boolean; falhas?: string[]; motivo?: string }>('/admin/conciliacao-cartao/resumo/enviar', {
        method: 'POST',
      });
      setResultado(
        !r.enviado ? r.motivo || 'Nada a enviar' : r.falhas?.length ? `Falhou pra: ${r.falhas.join('; ')}` : 'Enviado.',
      );
    } catch (e: any) {
      setResultado(e?.body?.message || 'Não consegui enviar');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oo-nav/40 p-4" role="dialog" aria-modal="true" aria-label="Resumo do WhatsApp">
      <div className="w-full max-w-lg rounded-xl border border-oo-line bg-oo-surface font-oo-sans text-oo-ink shadow-oo-pop">
        <header className="flex items-center justify-between border-b border-oo-line px-5 py-4">
          <h2 className="font-oo-display text-[18px] font-bold">Resumo de ontem no WhatsApp</h2>
          <button type="button" onClick={onFechar} className={`${BTN_SECUNDARIO} h-9 px-2.5`} aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-5 py-4">
          {erro && <p className="text-[14px] text-oo-danger">{erro}</p>}
          {texto === undefined && !erro && (
            <p className="flex items-center gap-2 text-oo-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Montando…
            </p>
          )}
          {texto === null && <p className="text-[14px] text-oo-muted">Nenhuma loja com venda no cartão ontem.</p>}
          {texto && (
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-oo-subtle p-3 font-oo-sans text-[13px] leading-relaxed">
              {texto}
            </pre>
          )}
          <p className="mt-2 text-[12px] text-oo-muted">Sai sozinho todo dia na hora configurada em Configurar Stone.</p>
          {resultado && <p className="mt-2 text-[13px] font-medium">{resultado}</p>}
        </div>
        {podeEnviar && texto && (
          <div className="flex justify-end border-t border-oo-line bg-oo-subtle px-5 py-3">
            <button type="button" onClick={enviar} disabled={enviando} className={BTN_PRIMARIO}>
              {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Enviar agora
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
