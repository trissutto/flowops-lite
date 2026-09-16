'use client';

/**
 * Painel lateral de uma loja × dia: cada venda no cartão ao lado da
 * transação da Stone que casou com ela (ou da falta dela).
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, CreditCard, Loader2, RotateCw, X } from 'lucide-react';
import { api } from '@/lib/api';
import { BTN_PRIMARIO, BTN_SECUNDARIO, CAMPO } from '@/components/enterprise/Form';
import {
  Detalhe,
  LinhaDetalhe,
  PagamentoDetalhe,
  SITUACAO,
  STATUS,
  TOM_PONTO,
  TOM_TEXTO,
  TransacaoDetalhe,
  dataBr,
  dataHoraBr,
  reais,
  tipoCartao,
} from './tipos';

const GRUPOS: { titulo: string; tons: string[]; aberto: boolean }[] = [
  { titulo: 'Divergências', tons: ['danger'], aberto: true },
  { titulo: 'Atenção', tons: ['warning'], aberto: true },
  { titulo: 'Conferidas', tons: ['success'], aberto: false },
  { titulo: 'Sem efeito no caixa', tons: ['muted'], aberto: false },
];

export default function DetalheDia({
  storeCode,
  dia,
  podeAgir,
  onFechar,
  onMudou,
}: {
  storeCode: string;
  dia: string;
  podeAgir: boolean;
  onFechar: () => void;
  onMudou: () => void;
}) {
  const [dados, setDados] = useState<Detalhe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [baixando, setBaixando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [nota, setNota] = useState('');
  const [salvandoNota, setSalvandoNota] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const d = await api<Detalhe>(`/admin/conciliacao-cartao/dia/${encodeURIComponent(storeCode)}/${dia}`);
      setDados(d);
      setNota((n) => n || d.revisadoNota || '');
    } catch (e: any) {
      setErro(e?.body?.message || 'Não consegui abrir este dia');
    }
  }, [storeCode, dia]);

  useEffect(() => {
    setDados(null);
    carregar();
  }, [carregar]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onFechar();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onFechar]);

  async function baixarDeNovo() {
    setBaixando(true);
    setAviso(null);
    try {
      const r = await api<{ ok: boolean; resumos: { stoneCode: string; status: string; erro?: string }[] }>(
        `/admin/conciliacao-cartao/dia/${encodeURIComponent(storeCode)}/${dia}/baixar-de-novo`,
        { method: 'POST' },
      );
      setAviso(
        r.ok
          ? 'Arquivo da Stone baixado de novo e dia reconferido.'
          : r.resumos.map((x) => `${x.stoneCode}: ${x.erro || x.status}`).join(' · '),
      );
      await carregar();
      onMudou();
    } catch (e: any) {
      setAviso(e?.body?.message || 'Não consegui falar com a Stone agora');
    } finally {
      setBaixando(false);
    }
  }

  async function marcarRevisado() {
    setSalvandoNota(true);
    try {
      await api(`/admin/conciliacao-cartao/dia/${encodeURIComponent(storeCode)}/${dia}/revisar`, {
        method: 'POST',
        body: JSON.stringify({ nota }),
      });
      await carregar();
      onMudou();
    } catch (e: any) {
      setAviso(e?.body?.message || 'Não consegui marcar como revisado');
    } finally {
      setSalvandoNota(false);
    }
  }

  const st = dados ? STATUS[dados.status] : null;
  const conta = dados && !['aguardando_arquivo', 'erro_arquivo', 'sem_stone', 'em_andamento'].includes(dados.status);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Conferência do dia">
      <button type="button" className="absolute inset-0 bg-oo-nav/40" aria-label="Fechar" onClick={onFechar} />
      <aside className="relative flex h-full w-full max-w-[760px] flex-col bg-oo-bg font-oo-sans text-oo-ink shadow-oo-pop">
        <header className="border-b border-oo-line bg-oo-surface px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-oo-muted">Conferência dos cartões</p>
              <h2 className="mt-1 font-oo-display text-[22px] font-bold leading-tight tracking-[-0.02em]">
                {storeCode} {dados?.storeName || ''} · {dados?.diaCurto || dataBr(dia)}
              </h2>
              {st && (
                <p className={`mt-1 inline-flex items-center gap-2 text-[13px] font-semibold ${TOM_TEXTO[st.tom]}`}>
                  <span className={`h-2 w-2 rounded-full ${TOM_PONTO[st.tom]}`} />
                  {st.rotulo}
                </p>
              )}
            </div>
            <button type="button" onClick={onFechar} className={`${BTN_SECUNDARIO} h-9 px-2.5`} aria-label="Fechar">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {erro && (
            <div className="rounded-lg border border-oo-danger/30 bg-oo-danger-soft p-4 text-[14px] text-oo-danger">{erro}</div>
          )}
          {!dados && !erro && (
            <div className="flex items-center gap-2 py-16 text-oo-muted">
              <Loader2 className="h-5 w-5 animate-spin" /> Conferindo o dia…
            </div>
          )}

          {dados && (
            <>
              <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-oo-line bg-oo-line sm:grid-cols-3">
                <div className="bg-oo-surface px-4 py-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-oo-muted">Vendido no cartão</dt>
                  <dd className="mt-1 font-oo-display text-[22px] font-bold tabular-nums">{reais(dados.totais.sistema.valor)}</dd>
                  <dd className="text-[12px] text-oo-ink-2">{dados.totais.sistema.qtd} pagamento(s) no PDV</dd>
                </div>
                <div className="bg-oo-surface px-4 py-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-oo-muted">Na maquininha Stone</dt>
                  <dd className="mt-1 font-oo-display text-[22px] font-bold tabular-nums">
                    {conta ? reais(dados.totais.maquininha.valor) : '—'}
                  </dd>
                  <dd className="text-[12px] text-oo-ink-2">
                    {conta ? `${dados.totais.maquininha.qtd} transação(ões)` : 'arquivo ainda não chegou'}
                  </dd>
                </div>
                <div className="bg-oo-surface px-4 py-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-oo-muted">Em divergência</dt>
                  <dd
                    className={`mt-1 font-oo-display text-[22px] font-bold tabular-nums ${
                      conta && dados.totais.valorDivergente > 0 ? 'text-oo-danger' : ''
                    }`}
                  >
                    {conta ? reais(dados.totais.valorDivergente) : '—'}
                  </dd>
                  <dd className="text-[12px] text-oo-ink-2">soma das linhas que não batem</dd>
                </div>
              </dl>

              {dados.frases.length > 0 && (
                <ul className="mt-4 space-y-1 text-[14px] text-oo-ink">
                  {dados.frases.map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-oo-danger" />
                      {f}
                    </li>
                  ))}
                </ul>
              )}

              <section className="mt-5 rounded-lg border border-oo-line bg-oo-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-oo-display text-[15px] font-semibold">Arquivo da Stone</h3>
                  {podeAgir && dados.stoneCodes.length > 0 && (
                    <button type="button" onClick={baixarDeNovo} disabled={baixando} className={`${BTN_SECUNDARIO} h-9`}>
                      {baixando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                      Baixar de novo
                    </button>
                  )}
                </div>
                {dados.stoneCodes.length === 0 ? (
                  <p className="mt-2 text-[13px] text-oo-ink-2">
                    Esta loja não tem StoneCode cadastrado — cadastre em <b>Configurar Stone</b>.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5 text-[13px]">
                    {dados.stoneCodes.map((c) => {
                      const a = dados.arquivos.find((x) => x.stoneCode === c);
                      return (
                        <li key={c} className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-semibold tabular-nums">StoneCode {c}</span>
                          {!a ? (
                            <span className="text-oo-muted">ainda não baixado — sai a partir das 4h do dia seguinte</span>
                          ) : a.status === 'ok' ? (
                            <span className="text-oo-success">
                              ok · {a.capturas ?? 0} transação(ões) · baixado {dataHoraBr(a.baixadoEm)}
                            </span>
                          ) : (
                            <span className="text-oo-danger">
                              {a.status}: {a.erro || '—'} ({dataHoraBr(a.ultimaTentativa)})
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {aviso && <p className="mt-2 text-[13px] font-medium text-oo-ink-2">{aviso}</p>}
              </section>

              {conta && (
                <section className="mt-5 rounded-lg border border-oo-line bg-oo-surface p-4">
                  <h3 className="font-oo-display text-[15px] font-semibold">Revisão da matriz</h3>
                  {dados.revisadoEm && (
                    <p className="mt-1 text-[13px] text-oo-success">
                      <CheckCircle2 className="mr-1 inline h-4 w-4" />
                      revisado por {dados.revisadoPor || '—'} em {dataHoraBr(dados.revisadoEm)}
                    </p>
                  )}
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={nota}
                      onChange={(e) => setNota(e.target.value)}
                      placeholder="O que foi apurado (opcional)"
                      className={`${CAMPO} h-10`}
                      aria-label="Nota da revisão"
                    />
                    <button type="button" onClick={marcarRevisado} disabled={salvandoNota} className={`${BTN_PRIMARIO} shrink-0`}>
                      {salvandoNota ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      {dados.revisadoEm ? 'Atualizar revisão' : 'Marcar como revisado'}
                    </button>
                  </div>
                </section>
              )}

              {!conta && dados.linhas.length > 0 && (
                <p className="mt-5 flex gap-2 rounded-lg border border-oo-line bg-oo-subtle p-3 text-[13px] text-oo-ink-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-oo-warning" />
                  Sem o arquivo da Stone, a lista abaixo mostra só o lado do sistema — nada aqui é divergência ainda.
                </p>
              )}

              <div className="mt-5 space-y-4">
                {GRUPOS.map((g) => {
                  const linhas = dados.linhas.filter((l) => g.tons.includes(SITUACAO[l.situacao].tom));
                  if (!linhas.length) return null;
                  return (
                    <GrupoLinhas key={g.titulo} titulo={g.titulo} linhas={linhas} abertoDeInicio={g.aberto || !conta} conta={!!conta} />
                  );
                })}
                {dados.linhas.length === 0 && (
                  <p className="py-10 text-center text-[14px] text-oo-muted">
                    <CreditCard className="mx-auto mb-2 h-6 w-6" />
                    Nenhuma venda no cartão nem transação na Stone neste dia.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function GrupoLinhas({
  titulo,
  linhas,
  abertoDeInicio,
  conta,
}: {
  titulo: string;
  linhas: LinhaDetalhe[];
  abertoDeInicio: boolean;
  conta: boolean;
}) {
  const [aberto, setAberto] = useState(abertoDeInicio);
  return (
    <section>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left"
        aria-expanded={aberto}
      >
        <span className="font-oo-display text-[15px] font-semibold">
          {conta ? titulo : 'Vendas no cartão do dia'} <span className="text-oo-muted">({linhas.length})</span>
        </span>
        <ChevronDown className={`h-4 w-4 text-oo-muted transition-transform ${aberto ? 'rotate-180' : ''}`} />
      </button>
      {aberto && (
        <ul className="mt-2 space-y-2">
          {linhas.map((l, i) => (
            <CartaoLinha key={`${l.pagamento?.id || ''}-${l.transacao?.id || ''}-${i}`} linha={l} conta={conta} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CartaoLinha({ linha, conta }: { linha: LinhaDetalhe; conta: boolean }) {
  const s = SITUACAO[linha.situacao];
  return (
    <li className="relative overflow-hidden rounded-lg border border-oo-line bg-oo-surface">
      {conta && s.tom === 'danger' && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r bg-oo-danger" />}
      {conta && s.tom === 'warning' && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r bg-oo-warning" />}
      {conta && (
        <div className={`flex items-center gap-2 border-b border-oo-line px-4 py-2 text-[13px] font-semibold ${TOM_TEXTO[s.tom]}`}>
          <span className={`h-2 w-2 rounded-full ${TOM_PONTO[s.tom]}`} />
          {s.rotulo}
          {linha.diferenca !== 0 && (
            <span className="ml-auto tabular-nums text-oo-ink">
              {linha.diferenca > 0
                ? `o sistema tem ${reais(linha.diferenca)} a mais`
                : `a maquininha tem ${reais(-linha.diferenca)} a mais`}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-px bg-oo-line sm:grid-cols-2">
        <LadoSistema p={linha.pagamento} />
        <LadoStone t={linha.transacao} conta={conta} />
      </div>
      {conta && linha.notas.length > 0 && (
        <ul className="border-t border-oo-line bg-oo-subtle px-4 py-2 text-[13px] text-oo-ink-2">
          {linha.notas.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function LadoSistema({ p }: { p: PagamentoDetalhe | null }) {
  return (
    <div className="bg-oo-surface px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-oo-muted">No sistema (PDV)</p>
      {!p ? (
        <p className="mt-1 text-[13px] text-oo-muted">nenhuma venda no cartão casou</p>
      ) : (
        <>
          <p className="mt-1 font-oo-display text-[18px] font-bold tabular-nums">{reais(p.valor)}</p>
          <p className="text-[13px] text-oo-ink">
            Venda #{p.venda} · {p.hora || p.horaVenda || '—'}
            {p.vendaCancelada && <span className="ml-1 font-semibold text-oo-danger">· estornada</span>}
          </p>
          <p className="text-[13px] text-oo-ink-2">
            {p.metodo === 'venda_online' ? 'Venda online (link)' : tipoCartao(p.tipo, p.parcelas)}
            {p.bandeira ? ` · ${p.bandeira}` : ''}
            {p.vendedora ? ` · ${p.vendedora}` : ''}
          </p>
          {p.cliente && <p className="truncate text-[12px] text-oo-muted">{p.cliente}</p>}
        </>
      )}
    </div>
  );
}

function LadoStone({ t, conta }: { t: TransacaoDetalhe | null; conta: boolean }) {
  return (
    <div className="bg-oo-surface px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-oo-muted">Na maquininha (Stone)</p>
      {!t ? (
        <p className="mt-1 text-[13px] text-oo-muted">{conta ? 'nenhuma transação casou' : 'arquivo ainda não chegou'}</p>
      ) : (
        <>
          <p className="mt-1 font-oo-display text-[18px] font-bold tabular-nums">
            {reais(Math.round((t.valorCapturado - t.valorCancelado) * 100) / 100)}
            {t.valorCancelado > 0 && (
              <span className="ml-2 text-[12px] font-semibold text-oo-danger">cancelado {reais(t.valorCancelado)}</span>
            )}
          </p>
          <p className="text-[13px] text-oo-ink">
            NSU {t.nsu} · {t.hora || '—'}
          </p>
          <p className="text-[13px] text-oo-ink-2">
            {tipoCartao(t.tipo, t.parcelas)}
            {t.bandeira ? ` · ${t.bandeira}` : ''}
            {t.finalCartao ? ` · final ${t.finalCartao}` : ''}
            {t.autorizacao ? ` · aut ${t.autorizacao}` : ''}
          </p>
          {(t.taxa != null || t.previsaoPagamento) && (
            <p className="text-[12px] text-oo-muted">
              {t.taxa != null ? `taxa ${reais(t.taxa)}` : ''}
              {t.valorLiquido != null ? ` · líquido ${reais(t.valorLiquido)}` : ''}
              {t.previsaoPagamento ? ` · cai ${dataBr(t.previsaoPagamento)}` : ''}
              {t.terminal ? ` · ${t.terminal}` : ''}
            </p>
          )}
        </>
      )}
    </div>
  );
}
