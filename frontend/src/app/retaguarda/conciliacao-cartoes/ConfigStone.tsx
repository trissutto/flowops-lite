'use client';

/**
 * Configuração da conferência com a Stone: StoneCode de cada loja, quem
 * recebe o resumo no WhatsApp e a carga do histórico. As CHAVES não passam por
 * aqui — ficam no Railway (STONE_CONCILIACAO_CHAVES); a tela só diz quantas há.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, KeyRound, Loader2, MessageCircle, Save, Store, X } from 'lucide-react';
import { api } from '@/lib/api';
import { BTN_PRIMARIO, BTN_SECUNDARIO, CAMPO, ROTULO } from '@/components/enterprise/Form';
import { Integracao, dataHoraBr, diaMais, hojeBr } from './tipos';

type Form = { lojas: Record<string, string>; destinos: string; hora: number; ativo: boolean };

export default function ConfigStone({
  podeEditar,
  onFechar,
  onSalvou,
}: {
  podeEditar: boolean;
  onFechar: () => void;
  onSalvou: () => void;
}) {
  const [integ, setInteg] = useState<Integracao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const formPronto = useRef(false);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cargaDe, setCargaDe] = useState(diaMais(hojeBr(), -30));
  const [cargaAte, setCargaAte] = useState(diaMais(hojeBr(), -1));
  const [cargaMsg, setCargaMsg] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const d = await api<Integracao>('/admin/conciliacao-cartao/integracao');
      setInteg(d);
      setErro(null);
      // Só na primeira carga: o recarregamento do progresso não pode apagar o que está sendo digitado.
      if (!formPronto.current) {
        formPronto.current = true;
        setForm({
          lojas: Object.fromEntries(d.lojas.map((l) => [l.code, l.stoneCodes.join(', ')])),
          destinos: (d.whats?.destinos || []).join('\n'),
          hora: d.whats?.hora ?? 9,
          ativo: d.whats?.ativo !== false,
        });
      }
    } catch (e: any) {
      setErro(e?.body?.message || 'Não consegui ler a configuração');
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const cargaRodando = !!integ?.carga?.rodando;
  useEffect(() => {
    if (!cargaRodando) return;
    const t = window.setInterval(carregar, 4000);
    return () => window.clearInterval(t);
  }, [cargaRodando, carregar]);

  async function salvar() {
    if (!form) return;
    setSalvando(true);
    setMsg(null);
    try {
      await api('/admin/conciliacao-cartao/config', {
        method: 'POST',
        body: JSON.stringify({
          lojas: Object.fromEntries(
            Object.entries(form.lojas).map(([loja, texto]) => [loja, texto.split(/[\s,;]+/).filter(Boolean)]),
          ),
          whats: {
            ativo: form.ativo,
            hora: form.hora,
            destinos: form.destinos.split(/[\n,;]+/).map((d) => d.trim()).filter(Boolean),
          },
        }),
      });
      setMsg('Configuração salva.');
      onSalvou();
    } catch (e: any) {
      setMsg(e?.body?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function iniciarCarga() {
    setCargaMsg(null);
    try {
      const r = await api<{ dias: number; arquivos: number }>('/admin/conciliacao-cartao/carga', {
        method: 'POST',
        body: JSON.stringify({ de: cargaDe, ate: cargaAte }),
      });
      setCargaMsg(`Buscando ${r.arquivos} arquivo(s) de ${r.dias} dia(s) na Stone…`);
      carregar();
    } catch (e: any) {
      setCargaMsg(e?.body?.message || 'Não consegui iniciar a busca');
    }
  }

  const carga = integ?.carga;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-oo-nav/40 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label="Configurar Stone">
      <div className="w-full max-w-3xl rounded-xl border border-oo-line bg-oo-surface font-oo-sans text-oo-ink shadow-oo-pop">
        <header className="flex items-center justify-between border-b border-oo-line px-5 py-4 sm:px-6">
          <h2 className="font-oo-display text-[20px] font-bold tracking-[-0.02em]">Configurar a conferência com a Stone</h2>
          <button type="button" onClick={onFechar} className={`${BTN_SECUNDARIO} h-9 px-2.5`} aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </header>

        {erro && <p className="m-5 rounded-lg bg-oo-danger-soft p-3 text-[14px] text-oo-danger">{erro}</p>}
        {!integ && !erro && (
          <p className="flex items-center gap-2 p-8 text-oo-muted">
            <Loader2 className="h-5 w-5 animate-spin" /> Carregando…
          </p>
        )}

        {integ && form && (
          <div className="divide-y divide-oo-line">
            <section className="px-5 py-5 sm:px-6">
              <h3 className="flex items-center gap-2 font-oo-display text-[16px] font-semibold">
                <KeyRound className="h-4 w-4 text-oo-muted" /> Chaves da Stone
              </h3>
              {integ.chaves > 0 ? (
                <p className="mt-2 flex items-center gap-2 text-[14px] text-oo-success">
                  <CheckCircle2 className="h-4 w-4" /> {integ.chaves} chave(s) cadastrada(s) no Railway.
                </p>
              ) : (
                <div className="mt-2 rounded-lg border border-oo-warning/40 bg-oo-warning-soft p-3 text-[14px] leading-relaxed text-oo-ink">
                  <b>Nenhuma chave ainda.</b> O <b>titular</b> da conta Stone gera no Portal Stone:{' '}
                  <b>Perfil → Chaves de Autenticação → Criar Chave → &quot;API de Conciliação Stone&quot;</b>. A chave vale
                  pro CNPJ inteiro — uma por empresa. Cole no Railway (flowops-lite → Variables) na variável{' '}
                  <code className="rounded bg-oo-surface px-1">STONE_CONCILIACAO_CHAVES</code>, separadas por vírgula.
                </div>
              )}
              {!integ.ligado && (
                <p className="mt-2 text-[13px] text-oo-danger">A rotina está desligada no Railway (STONE_CONCILIACAO=0).</p>
              )}
            </section>

            <section className="px-5 py-5 sm:px-6">
              <h3 className="flex items-center gap-2 font-oo-display text-[16px] font-semibold">
                <Store className="h-4 w-4 text-oo-muted" /> StoneCode de cada loja
              </h3>
              <p className="mt-1 text-[13px] text-oo-ink-2">
                Aparece no Portal Stone e no comprovante da maquininha. Loja com mais de uma maquininha em cadastros
                diferentes: separe por vírgula.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-oo-muted">
                      <th className="py-2 pr-3 font-semibold">Loja</th>
                      <th className="py-2 font-semibold">StoneCode(s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {integ.lojas.map((l) => (
                      <tr key={l.code} className="border-t border-oo-line">
                        <td className="py-2 pr-3">
                          <span className="font-semibold tabular-nums">{l.code}</span> {l.nome}
                          {l.tipo === 'FILIAL' && <span className="ml-1 text-[12px] text-oo-muted">franquia</span>}
                        </td>
                        <td className="py-2">
                          <input
                            value={form.lojas[l.code] ?? ''}
                            onChange={(e) =>
                              setForm((f) => (f ? { ...f, lojas: { ...f.lojas, [l.code]: e.target.value } } : f))
                            }
                            disabled={!podeEditar}
                            inputMode="numeric"
                            placeholder="ex.: 123456789"
                            aria-label={`StoneCode da loja ${l.code}`}
                            className={`${CAMPO} h-9`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="px-5 py-5 sm:px-6">
              <h3 className="flex items-center gap-2 font-oo-display text-[16px] font-semibold">
                <MessageCircle className="h-4 w-4 text-oo-muted" /> Resumo diário no WhatsApp
              </h3>
              <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_180px]">
                <label className="block">
                  <span className={`mb-1.5 block ${ROTULO}`}>Quem recebe (um número por linha, com DDD)</span>
                  <textarea
                    value={form.destinos}
                    onChange={(e) => setForm((f) => (f ? { ...f, destinos: e.target.value } : f))}
                    disabled={!podeEditar}
                    rows={3}
                    placeholder="11999998888"
                    className={`${CAMPO} py-2`}
                  />
                </label>
                <div className="space-y-3">
                  <label className="block">
                    <span className={`mb-1.5 block ${ROTULO}`}>Hora do envio</span>
                    <select
                      value={form.hora}
                      onChange={(e) => setForm((f) => (f ? { ...f, hora: Number(e.target.value) } : f))}
                      disabled={!podeEditar}
                      className={`${CAMPO} h-10`}
                    >
                      {Array.from({ length: 18 }, (_, i) => i + 5).map((h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:50
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-[14px]">
                    <input
                      type="checkbox"
                      checked={form.ativo}
                      onChange={(e) => setForm((f) => (f ? { ...f, ativo: e.target.checked } : f))}
                      disabled={!podeEditar}
                      className="h-4 w-4"
                    />
                    Enviar todo dia
                  </label>
                </div>
              </div>
            </section>

            {podeEditar && (
              <div className="flex flex-wrap items-center justify-end gap-3 bg-oo-subtle px-5 py-4 sm:px-6">
                {msg && <span className="mr-auto text-[13px] font-medium text-oo-ink-2">{msg}</span>}
                <button type="button" onClick={salvar} disabled={salvando} className={BTN_PRIMARIO}>
                  {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Salvar
                </button>
              </div>
            )}

            {podeEditar && (
              <section className="px-5 py-5 sm:px-6">
                <h3 className="flex items-center gap-2 font-oo-display text-[16px] font-semibold">
                  <Download className="h-4 w-4 text-oo-muted" /> Buscar histórico na Stone
                </h3>
                <p className="mt-1 text-[13px] text-oo-ink-2">
                  Pra conferir dias que já passaram (a rotina automática busca só o dia anterior). Salve os StoneCodes antes.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="block">
                    <span className={`mb-1.5 block ${ROTULO}`}>De</span>
                    <input type="date" value={cargaDe} onChange={(e) => setCargaDe(e.target.value)} className={`${CAMPO} h-10`} />
                  </label>
                  <label className="block">
                    <span className={`mb-1.5 block ${ROTULO}`}>Até</span>
                    <input type="date" value={cargaAte} max={diaMais(hojeBr(), -1)} onChange={(e) => setCargaAte(e.target.value)} className={`${CAMPO} h-10`} />
                  </label>
                  <button type="button" onClick={iniciarCarga} disabled={cargaRodando || integ.chaves === 0} className={BTN_SECUNDARIO}>
                    {cargaRodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {cargaRodando ? 'Buscando…' : 'Buscar'}
                  </button>
                </div>
                {cargaMsg && <p className="mt-2 text-[13px] text-oo-ink-2">{cargaMsg}</p>}
                {carga && carga.total > 0 && (
                  <p className="mt-2 text-[13px] text-oo-ink-2">
                    {carga.rodando ? 'Andamento' : 'Última busca'}: {carga.feitos}/{carga.total} arquivo(s)
                    {carga.erros.length > 0 && <span className="text-oo-danger"> · {carga.erros.length} com erro</span>}
                  </p>
                )}
                {carga && carga.erros.length > 0 && (
                  <ul className="mt-1 max-h-32 overflow-y-auto text-[12px] text-oo-danger">
                    {carga.erros.slice(0, 20).map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="px-5 py-5 sm:px-6">
              <h3 className="font-oo-display text-[16px] font-semibold">Arquivos dos últimos 7 dias</h3>
              {integ.arquivos.length === 0 ? (
                <p className="mt-2 text-[13px] text-oo-muted">Nenhum arquivo baixado ainda.</p>
              ) : (
                <div className="mt-2 max-h-72 overflow-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-oo-muted">
                        <th className="py-1.5 pr-3 font-semibold">Dia</th>
                        <th className="py-1.5 pr-3 font-semibold">Loja</th>
                        <th className="py-1.5 pr-3 font-semibold">StoneCode</th>
                        <th className="py-1.5 pr-3 font-semibold">Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {integ.arquivos.map((a) => (
                        <tr key={`${a.stoneCode}-${a.dia}`} className="border-t border-oo-line align-top">
                          <td className="py-1.5 pr-3 tabular-nums">{a.dia.split('-').reverse().join('/')}</td>
                          <td className="py-1.5 pr-3">{a.storeCode || '—'}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{a.stoneCode}</td>
                          <td className="py-1.5 pr-3">
                            {a.status === 'ok' ? (
                              <span className="text-oo-success">ok · {a.capturas} transação(ões) · {dataHoraBr(a.baixadoEm)}</span>
                            ) : (
                              <span className="text-oo-danger">
                                {a.status}: {a.erro}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
