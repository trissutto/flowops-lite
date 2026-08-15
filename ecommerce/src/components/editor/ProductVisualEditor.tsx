'use client';

import { useEffect, useState } from 'react';
import { Pencil, Save, Send, X } from 'lucide-react';

type Props = {
  reference: string;
  brand: string;
  color?: string | null;
  initialName: string;
  initialDescription: string;
};

type EditorData = {
  published?: { nomeCurto?: string | null; descricao?: string | null } | null;
  draft?: { payload?: { ficha?: { nomeCurto?: string | null; descricao?: string | null } } } | null;
  currentVersion?: number;
};

export function ProductVisualEditor(props: Props) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(props.initialName);
  const [description, setDescription] = useState(props.initialDescription);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const endpoint = `/api/editor/product/${encodeURIComponent(props.reference)}?marca=${encodeURIComponent(props.brand)}${props.color ? `&cor=${encodeURIComponent(props.color)}` : ''}`;

  async function load() {
    const session = await fetch('/api/editor/session', { cache: 'no-store' }).then((r) => r.json());
    setEditor(session.editor ?? null);
    if (!session.editor) return;
    const response = await fetch(endpoint, { cache: 'no-store' });
    const data = await response.json() as EditorData & { error?: string };
    if (!response.ok) return setMessage(data.error || 'Não foi possível carregar o editor.');
    const ficha = data.draft?.payload?.ficha ?? data.published ?? {};
    setName(ficha.nomeCurto || props.initialName);
    setDescription(ficha.descricao || props.initialDescription);
    setVersion(data.currentVersion ?? 0);
  }

  useEffect(() => { if (open) void load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const response = await fetch('/api/editor/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setMessage(data.error || 'Não foi possível entrar.');
    setEditor(data.editor); setPassword(''); await load();
  }

  async function persist(publish: boolean) {
    setBusy(true); setMessage('');
    const draftResponse = await fetch(endpoint, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: version, ficha: { nomeCurto: name, descricao: description } }),
    });
    const draft = await draftResponse.json();
    if (!draftResponse.ok) { setBusy(false); return setMessage(draft.error || 'Falha ao salvar.'); }
    if (!publish) { setBusy(false); return setMessage('Rascunho salvo.'); }
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: version }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setMessage(data.error || 'Falha ao publicar.');
    setVersion(data.version ?? version + 1); setMessage('Produto publicado. Atualizando página…');
    window.setTimeout(() => window.location.reload(), 900);
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-[80] flex items-center gap-2 rounded-full bg-ink px-5 py-3 text-sm font-semibold text-white shadow-xl hover:bg-gold-dark">
        <Pencil className="h-4 w-4" /> Editar produto
      </button>
      {open && <div className="fixed inset-0 z-[100] bg-black/35" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 right-0 z-[110] w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl transition-transform ${open ? 'translate-x-0' : 'translate-x-full'}`} aria-hidden={!open}>
        <div className="mb-6 flex items-center justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-widest text-gold-dark">Modo edição</p><h2 className="font-serif text-2xl">{props.reference}</h2></div>
          <button onClick={() => setOpen(false)} aria-label="Fechar"><X /></button>
        </div>
        {editor === undefined && <p>Carregando…</p>}
        {editor === null && (
          <form onSubmit={login} className="space-y-4">
            <p className="text-sm text-ink-soft">Entre com o mesmo acesso administrativo do CRM.</p>
            <input type="email" required placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded border p-3" />
            <input type="password" required placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded border p-3" />
            <button disabled={busy} className="w-full rounded bg-ink p-3 font-semibold text-white">Entrar no modo edição</button>
          </form>
        )}
        {editor && (
          <div className="space-y-5">
            <label className="block text-sm font-semibold">Nome curto<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="mt-2 w-full rounded border p-3 font-normal" /></label>
            <label className="block text-sm font-semibold">Descrição<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={12} className="mt-2 w-full rounded border p-3 font-normal" /></label>
            <div className="grid grid-cols-2 gap-3">
              <button disabled={busy} onClick={() => void persist(false)} className="flex items-center justify-center gap-2 rounded border p-3 font-semibold"><Save className="h-4 w-4" /> Salvar rascunho</button>
              <button disabled={busy} onClick={() => void persist(true)} className="flex items-center justify-center gap-2 rounded bg-ink p-3 font-semibold text-white"><Send className="h-4 w-4" /> Publicar</button>
            </div>
          </div>
        )}
        {message && <p className="mt-5 rounded bg-champagne p-3 text-sm">{message}</p>}
      </aside>
    </>
  );
}
