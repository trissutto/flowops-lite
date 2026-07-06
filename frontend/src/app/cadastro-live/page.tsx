'use client';

/**
 * /cadastro-live — página PÚBLICA (sem login) do cadastro da cliente na Live.
 *
 * A cliente chega aqui pelo link que o ManyChat manda quando ela escreve
 * "CARRINHO" na live:
 *   /cadastro-live?ig=@fulana&nome=Fulana&t=<token>
 *
 * O @ vem pré-preenchido e TRAVADO (é a chave do carrinho da Live — não pode
 * ter typo). A cliente só confirma nome e digita o celular. Posta em
 * POST /public/cadastro-live (dedup por telefone/@, grava em Customer 'live').
 *
 * Estilo em Tailwind (styled-jsx não aplica de forma confiável no App Router /
 * webview do Instagram — a v1 saiu "crua" em produção).
 */

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

function maskPhone(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function parseErr(e: any): string {
  const raw = String(e?.message || '');
  const i = raw.indexOf(': ');
  const tail = i >= 0 ? raw.slice(i + 2) : raw;
  try {
    const j = JSON.parse(tail);
    if (j?.message) return Array.isArray(j.message) ? j.message[0] : j.message;
  } catch { /* texto puro */ }
  return 'Não consegui enviar agora. Confira os dados e tente de novo.';
}

// Ignora placeholder não-resolvido do ManyChat (ex.: "{{IG_USERNAME}}") — se o
// link vier mal configurado, tratamos como vazio em vez de mostrar o texto cru.
function cleanParam(v: string | null): string {
  const s = (v || '').trim();
  if (!s || s.includes('{{') || s.includes('}}')) return '';
  return s;
}

const inputCls =
  'w-full box-border px-3.5 py-3.5 text-base rounded-xl bg-[#FCFBF7] text-[#2A2620] ' +
  'border-[1.5px] border-[#E4DDCB] outline-none transition-colors ' +
  'focus:border-[#B8912B] focus:ring-2 focus:ring-[#EBD9A6]';
const labelCls = 'block mb-3.5';
const labelSpanCls = 'block text-[13px] font-bold text-[#6B6456] mb-1.5';

function CadastroForm() {
  const params = useSearchParams();
  const igParam = cleanParam(params.get('ig')).replace(/^@/, '');
  const nomeParam = cleanParam(params.get('nome'));
  const token = (params.get('t') || '').trim();

  const [nome, setNome] = useState('');
  const [ig, setIg] = useState('');
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (nomeParam) setNome(nomeParam);
    if (igParam) setIg(igParam);
  }, [nomeParam, igParam]);

  const igLocked = !!igParam;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const digits = phone.replace(/\D/g, '');
    if (nome.trim().length < 2) { setErr('Escreve seu nome, por favor 💜'); return; }
    if (digits.length !== 10 && digits.length !== 11) { setErr('Confere o celular com o DDD (ex.: 11 91234-5678).'); return; }
    setSending(true);
    try {
      const r = await api<{ ok: boolean; name: string }>('/public/cadastro-live', {
        method: 'POST',
        body: JSON.stringify({ name: nome.trim(), phone: digits, instagram: ig.trim(), token }),
      });
      setDone({ name: r.name || nome.trim() });
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div className="w-full max-w-[420px] bg-white border border-[#EDE7D6] rounded-3xl p-6 text-center shadow-[0_10px_30px_rgba(140,115,37,0.08)]">
        <div className="w-[68px] h-[68px] mx-auto mb-4 rounded-full bg-[#FBF6E6] text-[#B8912B] text-4xl font-extrabold flex items-center justify-center">✓</div>
        <h1 className="text-[23px] font-extrabold text-[#2A2620]">Tudo certo, {done.name.split(' ')[0]}! 💜</h1>
        <p className="text-[#7A7264] text-[15px] mt-1">Seu cadastro na live foi feito.</p>
        <p className="text-[17px] text-[#2A2620] mt-3 leading-relaxed">Agora volta pra live e comenta o <b>número da peça</b> que você quer.</p>
        <div className="mt-4 bg-[#FBF6E6] border border-[#ECD9A0] rounded-xl p-3 text-sm text-[#8C7325] font-semibold">A gente já te encontra pelo seu @ 😉</div>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-[420px] bg-white border border-[#EDE7D6] rounded-3xl p-6 shadow-[0_10px_30px_rgba(140,115,37,0.08)]"
    >
      <div className="text-[13px] font-extrabold tracking-wide text-[#B8912B] uppercase mb-3">
        Lurd&apos;s <span className="text-[#C9A94E] font-semibold">Plus Size</span>
      </div>
      <h1 className="text-2xl font-extrabold text-[#2A2620] mb-1">Cadastro da Live</h1>
      <p className="text-[#7A7264] text-[15px] mb-5">Preenche rapidinho pra garantir seu carrinho 💜</p>

      {igLocked && (
        <div className="flex items-center gap-2.5 bg-[#FBF6E6] border border-[#ECD9A0] rounded-xl px-3.5 py-2.5 mb-4">
          <span className="font-extrabold text-[#8C7325] text-base">@{ig}</span>
          <span className="text-xs text-[#A08A4E]">confirmado do seu Instagram</span>
        </div>
      )}

      <label className={labelCls}>
        <span className={labelSpanCls}>Seu nome</span>
        <input
          className={inputCls}
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="Nome completo"
          autoComplete="name"
          autoFocus={!nomeParam}
        />
      </label>

      {!igLocked && (
        <label className={labelCls}>
          <span className={labelSpanCls}>Seu @ do Instagram</span>
          <input
            className={inputCls}
            value={ig}
            onChange={(e) => setIg(e.target.value.replace(/^@/, ''))}
            placeholder="seu_usuario"
            autoCapitalize="none"
          />
        </label>
      )}

      <label className={labelCls}>
        <span className={labelSpanCls}>Seu celular (WhatsApp)</span>
        <input
          className={inputCls}
          value={phone}
          onChange={(e) => setPhone(maskPhone(e.target.value))}
          placeholder="(11) 91234-5678"
          inputMode="numeric"
          autoComplete="tel"
        />
      </label>

      {err && (
        <div className="bg-[#FDECEC] border border-[#F3C0C0] text-[#9B2C2C] rounded-lg px-3 py-2.5 text-sm mb-3.5">
          {err}
        </div>
      )}

      <button
        type="submit"
        disabled={sending}
        className="w-full py-3.5 text-[17px] font-extrabold text-white bg-[#B8912B] rounded-xl shadow-[0_4px_14px_rgba(184,145,43,0.25)] hover:bg-[#A07F22] active:translate-y-px disabled:opacity-60 transition-colors"
      >
        {sending ? 'Enviando…' : 'Quero participar 💜'}
      </button>

      <p className="text-center text-xs text-[#A69E8C] mt-3.5">Usamos seus dados só pra te atender na live e no seu pedido.</p>
    </form>
  );
}

export default function CadastroLivePage() {
  return (
    <div className="min-h-screen bg-[#FAFAF7] flex items-start justify-center px-4 pt-[6vh] pb-12">
      <Suspense fallback={<div className="text-[#7A7264] text-sm mt-10">Carregando…</div>}>
        <CadastroForm />
      </Suspense>
    </div>
  );
}
