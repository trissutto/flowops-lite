'use client';

/**
 * /retaguarda/email-marketing
 *
 * Disparo de campanha de e-mail SEM sair do FlowOps (dono, 14/08/2026).
 * A operadora escolhe um segmento do Mautic, escreve assunto e texto e
 * envia (ou agenda). O backend fala com a API do Mautic (mkt.lurds.com.br),
 * que entrega pelo SES e cuida de abertura/clique/descadastro.
 *
 * A comunicação é toda VIA SISTEMA: nenhuma tela do Mautic é aberta aqui.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, Loader2, Mail,
  Send, TestTube2, Users,
} from 'lucide-react';
import { api } from '@/lib/api';

type Segmento = { id: number; nome: string; alias: string; contatos: number | null };
type Status = { ok: boolean; configurado: boolean; erro?: string };

export default function EmailMarketingPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [segmentos, setSegmentos] = useState<Segmento[]>([]);
  const [carregando, setCarregando] = useState(true);

  const [segmentoId, setSegmentoId] = useState<number | ''>('');
  const [assunto, setAssunto] = useState('');
  const [corpo, setCorpo] = useState('');
  const [cupom, setCupom] = useState('');
  const [agendar, setAgendar] = useState(false);
  const [quando, setQuando] = useState('');

  const [emailTeste, setEmailTeste] = useState('');
  const [enviandoPrevia, setEnviandoPrevia] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; msg: string } | null>(null);
  const [confirmar, setConfirmar] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const st = await api<Status>('/email-marketing/status');
      setStatus(st);
      if (st.configurado && st.ok) {
        const segs = await api<Segmento[]>('/email-marketing/segmentos');
        setSegmentos(segs);
      }
    } catch (e: any) {
      setStatus({ ok: false, configurado: false, erro: e?.message ?? 'Falha ao conectar.' });
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const segAtual = useMemo(
    () => segmentos.find((s) => s.id === segmentoId),
    [segmentos, segmentoId],
  );

  async function enviarPrevia() {
    setAviso(null);
    setEnviandoPrevia(true);
    try {
      const r = await api<{ destino: string }>('/email-marketing/previa', {
        method: 'POST',
        body: JSON.stringify({ destino: emailTeste, assunto, corpo, cupom: cupom || null }),
      });
      setAviso({ tipo: 'ok', msg: `Prévia enviada para ${r.destino}. Veja como chegou antes de disparar.` });
    } catch (e: any) {
      setAviso({ tipo: 'erro', msg: e?.message ?? 'Não conseguimos enviar a prévia.' });
    } finally {
      setEnviandoPrevia(false);
    }
  }

  async function dispararDeVerdade() {
    setConfirmar(false);
    setAviso(null);
    setEnviando(true);
    try {
      const r = await api<{ agendado: boolean; enfileirados?: number | null; para?: string }>(
        '/email-marketing/enviar',
        {
          method: 'POST',
          body: JSON.stringify({
            segmentoId,
            assunto,
            corpo,
            cupom: cupom || null,
            agendarPara: agendar && quando ? new Date(quando).toISOString() : null,
          }),
        },
      );
      setAviso({
        tipo: 'ok',
        msg: r.agendado
          ? `Campanha AGENDADA para ${new Date(r.para!).toLocaleString('pt-BR')}. O Mautic dispara sozinho.`
          : `Campanha disparada! ${r.enfileirados != null ? `${r.enfileirados} contatos na fila de envio.` : 'Em processamento no Mautic.'}`,
      });
      setAssunto(''); setCorpo(''); setCupom('');
    } catch (e: any) {
      setAviso({ tipo: 'erro', msg: e?.message ?? 'Falha ao disparar a campanha.' });
    } finally {
      setEnviando(false);
    }
  }

  const podeDisparar =
    !!segmentoId && assunto.trim().length >= 3 && corpo.trim().length >= 10 && (!agendar || !!quando);

  /* ---------- Mautic não conectado ---------- */
  if (!carregando && status && (!status.configurado || !status.ok)) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <Voltar />
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-6">
          <div className="flex items-center gap-3 text-amber-800">
            <AlertTriangle className="size-6 shrink-0" />
            <h1 className="text-lg font-semibold">Mautic ainda não conectado</h1>
          </div>
          <p className="mt-3 text-sm text-amber-900">{status.erro}</p>
          <div className="mt-4 rounded-lg bg-white/70 p-4 text-sm text-amber-900">
            <p className="font-medium">Para ligar (uma vez só):</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>No Mautic: <b>Configurações → API</b> → habilitar API e “HTTP basic auth”.</li>
              <li>No Railway (backend): <code>MAUTIC_BASE=https://mkt.lurds.com.br</code>, <code>MAUTIC_USER</code>, <code>MAUTIC_PASS</code>.</li>
            </ol>
          </div>
          <button onClick={() => void carregar()} className="mt-4 rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800">
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Voltar />
      <div className="mt-4 flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-[#FBF6E6] text-[#8C7325]"><Mail className="size-6" /></span>
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Campanha de e-mail</h1>
          <p className="text-sm text-neutral-500">Escolha o público, escreva e dispare — pelo Mautic, sem sair do sistema.</p>
        </div>
      </div>

      {carregando ? (
        <div className="mt-10 flex justify-center text-neutral-400"><Loader2 className="size-6 animate-spin" /></div>
      ) : (
        <div className="mt-6 space-y-5">
          {/* Público */}
          <Campo titulo="Público" icone={<Users className="size-4" />}>
            <select
              value={segmentoId}
              onChange={(e) => setSegmentoId(e.target.value ? Number(e.target.value) : '')}
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm"
            >
              <option value="">Escolha um segmento…</option>
              {segmentos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}{s.contatos != null ? ` — ${s.contatos.toLocaleString('pt-BR')} contatos` : ''}
                </option>
              ))}
            </select>
            {segAtual && segAtual.contatos != null && (
              <p className="mt-1.5 text-xs text-neutral-500">
                Vai para <b>{segAtual.contatos.toLocaleString('pt-BR')}</b> pessoas (menos quem já descadastrou).
              </p>
            )}
          </Campo>

          {/* Assunto */}
          <Campo titulo="Assunto do e-mail">
            <input
              value={assunto}
              onChange={(e) => setAssunto(e.target.value)}
              maxLength={120}
              placeholder="Ex: Chegaram novidades do seu tamanho 💛"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
            />
          </Campo>

          {/* Corpo */}
          <Campo titulo="Texto" dica="Escreva normal. Linha em branco separa parágrafo; **assim** vira negrito.">
            <textarea
              value={corpo}
              onChange={(e) => setCorpo(e.target.value)}
              rows={7}
              placeholder={'Oi! Separamos peças novas que combinam com você.\n\nSão do **46 ao 60**, com troca fácil e retirada em qualquer uma das 14 lojas.'}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm leading-relaxed"
            />
          </Campo>

          {/* Cupom opcional */}
          <Campo titulo="Cupom (opcional)" dica="Se preencher, vira um bloco destacado no e-mail.">
            <input
              value={cupom}
              onChange={(e) => setCupom(e.target.value.toUpperCase())}
              maxLength={30}
              placeholder="PRIMEIRA10"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm uppercase"
            />
          </Campo>

          {/* Agendar */}
          <div className="rounded-lg border border-neutral-200 p-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-neutral-800">
              <input type="checkbox" checked={agendar} onChange={(e) => setAgendar(e.target.checked)} />
              <CalendarClock className="size-4" /> Agendar para depois
            </label>
            {agendar && (
              <input
                type="datetime-local"
                value={quando}
                onChange={(e) => setQuando(e.target.value)}
                className="mt-3 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              />
            )}
          </div>

          {/* Prévia */}
          <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-neutral-800">
              <TestTube2 className="size-4" /> Enviar prévia pra você antes
            </p>
            <div className="mt-2 flex gap-2">
              <input
                value={emailTeste}
                onChange={(e) => setEmailTeste(e.target.value)}
                placeholder="seu@email.com"
                className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => void enviarPrevia()}
                disabled={enviandoPrevia || assunto.trim().length < 3 || corpo.trim().length < 10 || !emailTeste}
                className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {enviandoPrevia ? <Loader2 className="size-4 animate-spin" /> : 'Enviar prévia'}
              </button>
            </div>
          </div>

          {aviso && (
            <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${aviso.tipo === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
              {aviso.tipo === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
              {aviso.msg}
            </div>
          )}

          {/* Disparar */}
          <button
            onClick={() => setConfirmar(true)}
            disabled={!podeDisparar || enviando}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-5 py-3.5 text-base font-semibold text-white disabled:opacity-40"
          >
            {enviando ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5" />}
            {agendar ? 'Agendar campanha' : 'Disparar agora'}
          </button>
        </div>
      )}

      {/* Confirmação — passo humano antes de mandar pra milhares */}
      {confirmar && segAtual && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setConfirmar(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-neutral-900">Confirmar disparo</h2>
            <p className="mt-2 text-sm text-neutral-600">
              {agendar ? 'Agendar' : 'Enviar agora'} <b>“{assunto}”</b> para o segmento{' '}
              <b>{segAtual.nome}</b>
              {segAtual.contatos != null ? ` (${segAtual.contatos.toLocaleString('pt-BR')} contatos)` : ''}?
            </p>
            <p className="mt-2 text-xs text-neutral-400">Quem já descadastrou não recebe. Não dá pra “despublicar” depois de sair.</p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setConfirmar(false)} className="flex-1 rounded-lg border border-neutral-300 py-2.5 text-sm font-medium">Cancelar</button>
              <button onClick={() => void dispararDeVerdade()} className="flex-1 rounded-lg bg-neutral-900 py-2.5 text-sm font-semibold text-white">
                {agendar ? 'Agendar' : 'Disparar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Voltar() {
  return (
    <Link href="/retaguarda" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800">
      <ArrowLeft className="size-4" /> Retaguarda
    </Link>
  );
}

function Campo({ titulo, dica, icone, children }: { titulo: string; dica?: string; icone?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-sm font-medium text-neutral-800">{icone}{titulo}</label>
      {dica && <p className="mb-1.5 mt-0.5 text-xs text-neutral-400">{dica}</p>}
      <div className={dica ? '' : 'mt-1.5'}>{children}</div>
    </div>
  );
}
