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
 */

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

const GOLD = '#B8912B';

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

function CadastroForm() {
  const params = useSearchParams();
  const igParam = (params.get('ig') || '').trim().replace(/^@/, '');
  const nomeParam = (params.get('nome') || '').trim();
  const token = (params.get('t') || '').trim();

  const [nome, setNome] = useState('');
  const [ig, setIg] = useState('');
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Pré-preenche com o que veio do ManyChat
  useEffect(() => {
    if (nomeParam) setNome(nomeParam);
    if (igParam) setIg(igParam);
  }, [nomeParam, igParam]);

  const igLocked = !!igParam; // veio do ManyChat → não deixa editar

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
      <div className="card success">
        <div className="check">✓</div>
        <h1>Tudo certo, {done.name.split(' ')[0]}! 💜</h1>
        <p>Seu cadastro na live foi feito.</p>
        <p className="big">Agora volta pra live e comenta o <b>número da peça</b> que você quer.</p>
        <div className="tag">A gente já te encontra pelo seu @ 😉</div>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="brand">Lurd&apos;s <span>Plus Size</span></div>
      <h1>Cadastro da Live</h1>
      <p className="sub">Preenche rapidinho pra garantir seu carrinho 💜</p>

      {igLocked && (
        <div className="iglock">
          <span className="ig">@{ig}</span>
          <span className="note">confirmado do seu Instagram</span>
        </div>
      )}

      <label className="field">
        <span>Seu nome</span>
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="Nome completo"
          autoComplete="name"
          autoFocus={!nomeParam}
        />
      </label>

      {!igLocked && (
        <label className="field">
          <span>Seu @ do Instagram</span>
          <input
            value={ig}
            onChange={(e) => setIg(e.target.value.replace(/^@/, ''))}
            placeholder="seu_usuario"
            autoCapitalize="none"
          />
        </label>
      )}

      <label className="field">
        <span>Seu celular (WhatsApp)</span>
        <input
          value={phone}
          onChange={(e) => setPhone(maskPhone(e.target.value))}
          placeholder="(11) 91234-5678"
          inputMode="numeric"
          autoComplete="tel"
        />
      </label>

      {err && <div className="err">{err}</div>}

      <button type="submit" disabled={sending}>
        {sending ? 'Enviando…' : 'Quero participar 💜'}
      </button>

      <p className="fine">Usamos seus dados só pra te atender na live e no seu pedido.</p>
    </form>
  );
}

export default function CadastroLivePage() {
  return (
    <div className="wrap">
      <Suspense fallback={<div className="card"><p className="sub">Carregando…</p></div>}>
        <CadastroForm />
      </Suspense>

      <style jsx global>{`
        html, body { margin: 0; background: #FAFAF7; }
      `}</style>
      <style jsx>{`
        .wrap {
          min-height: 100vh;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 28px 16px 48px;
          font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
          color: #2A2620;
        }
        .card {
          width: 100%;
          max-width: 420px;
          background: #fff;
          border: 1px solid #EDE7D6;
          border-radius: 20px;
          padding: 26px 22px 22px;
          box-shadow: 0 10px 30px rgba(140, 115, 37, 0.08);
          margin-top: 4vh;
        }
        .brand {
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 0.04em;
          color: ${GOLD};
          text-transform: uppercase;
          margin-bottom: 14px;
        }
        .brand span { color: #C9A94E; font-weight: 600; }
        h1 { font-size: 24px; font-weight: 800; margin: 0 0 4px; letter-spacing: -0.01em; }
        .sub { margin: 0 0 18px; color: #7A7264; font-size: 15px; }
        .iglock {
          display: flex; align-items: center; gap: 10px;
          background: #FBF6E6; border: 1px solid #ECD9A0;
          border-radius: 12px; padding: 10px 14px; margin-bottom: 16px;
        }
        .iglock .ig { font-weight: 800; color: #8C7325; font-size: 16px; }
        .iglock .note { font-size: 12px; color: #A08A4E; }
        .field { display: block; margin-bottom: 14px; }
        .field span {
          display: block; font-size: 13px; font-weight: 700;
          color: #6B6456; margin-bottom: 6px;
        }
        .field input {
          width: 100%; box-sizing: border-box;
          padding: 14px 14px; font-size: 16px;
          border: 1.5px solid #E4DDCB; border-radius: 12px;
          background: #FCFBF7; color: #2A2620;
          outline: none; transition: border-color .15s, box-shadow .15s;
        }
        .field input:focus {
          border-color: ${GOLD};
          box-shadow: 0 0 0 3px rgba(184, 145, 43, 0.15);
        }
        .err {
          background: #FDECEC; border: 1px solid #F3C0C0; color: #9B2C2C;
          border-radius: 10px; padding: 10px 12px; font-size: 14px; margin-bottom: 14px;
        }
        button {
          width: 100%; padding: 15px; font-size: 17px; font-weight: 800;
          color: #fff; background: ${GOLD}; border: none; border-radius: 12px;
          cursor: pointer; transition: background .15s, transform .05s;
          box-shadow: 0 4px 14px rgba(184, 145, 43, 0.25);
        }
        button:hover:not(:disabled) { background: #A07F22; }
        button:active:not(:disabled) { transform: translateY(1px); }
        button:disabled { opacity: .6; cursor: default; }
        .fine { text-align: center; font-size: 12px; color: #A69E8C; margin: 14px 0 0; }

        /* sucesso */
        .success { text-align: center; }
        .success .check {
          width: 68px; height: 68px; margin: 6px auto 14px;
          border-radius: 50%; background: #FBF6E6; color: ${GOLD};
          font-size: 38px; font-weight: 800;
          display: flex; align-items: center; justify-content: center;
        }
        .success h1 { font-size: 23px; }
        .success p { color: #7A7264; font-size: 15px; margin: 4px 0; }
        .success .big { font-size: 17px; color: #2A2620; margin-top: 12px; line-height: 1.5; }
        .success .tag {
          margin-top: 18px; background: #FBF6E6; border: 1px solid #ECD9A0;
          border-radius: 12px; padding: 12px; font-size: 14px; color: #8C7325; font-weight: 600;
        }
      `}</style>
    </div>
  );
}
