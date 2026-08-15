'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Pencil, Save, Send, Trash2, X } from 'lucide-react';

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
type Photo = { id: string; url: string; ordem: number; objectKey?: string | null };

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
  const [photos, setPhotos] = useState<Photo[]>([]);

  const endpoint = `/api/editor/product/${encodeURIComponent(props.reference)}?marca=${encodeURIComponent(props.brand)}${props.color ? `&cor=${encodeURIComponent(props.color)}` : ''}`;
  const photosEndpoint = `/api/editor/photos/${encodeURIComponent(props.reference)}${props.color ? `?cor=${encodeURIComponent(props.color)}` : ''}`;

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
    const gallery = await fetch(photosEndpoint, { cache: 'no-store' }).then((r) => r.json());
    if (Array.isArray(gallery)) setPhotos(gallery);
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

  async function upload(file?: File) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setMessage('Use JPG, PNG ou WebP.');
    if (file.size > 10 * 1024 * 1024) return setMessage('A foto deve ter no máximo 10 MB.');
    setBusy(true); setMessage('Enviando e otimizando no Cloudflare…');
    try {
      const preparedResponse = await fetch(photosEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare', filename: file.name }) });
      const prepared = await preparedResponse.json(); if (!preparedResponse.ok) throw new Error(prepared.error || 'Falha ao preparar upload.');
      const form = new FormData(); form.set('file', file);
      if (!(await fetch(prepared.uploadURL, { method: 'POST', body: form })).ok) throw new Error('Cloudflare recusou a imagem.');
      let confirmed: Response | undefined;
      for (let attempt = 0; attempt < 5; attempt++) { confirmed = await fetch(photosEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm', id: prepared.id }) }); if (confirmed.ok) break; await new Promise((resolve) => setTimeout(resolve, 1200)); }
      if (!confirmed?.ok) throw new Error((await confirmed?.json().catch(() => null))?.error || 'A imagem não terminou de processar.');
      await load(); setMessage('Foto adicionada. A primeira foto é a capa.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao enviar foto.'); }
    finally { setBusy(false); }
  }

  async function reorder(index: number, delta: number) {
    const next = [...photos]; const target = index + delta; if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; setPhotos(next); setBusy(true);
    const response = await fetch(photosEndpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: next.map((p) => p.id) }) });
    setBusy(false); if (!response.ok) { setMessage('Não foi possível reordenar.'); await load(); }
  }

  async function remove(photo: Photo) {
    if (!window.confirm('Excluir esta foto?')) return; setBusy(true);
    const response = await fetch(`${photosEndpoint}${photosEndpoint.includes('?') ? '&' : '?'}id=${encodeURIComponent(photo.id)}&cloudflare=${photo.objectKey?.startsWith('cloudflare:') ? '1' : '0'}`, { method: 'DELETE' });
    setBusy(false); if (!response.ok) return setMessage((await response.json()).error || 'Não foi possível excluir.');
    await load(); setMessage('Foto excluída.');
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
            <section className="space-y-3 border-t pt-5">
              <div><h3 className="font-semibold">Fotos · {props.color || 'geral'}</h3><p className="text-xs text-ink-soft">A primeira imagem é a capa. Novas fotos são otimizadas pelo Cloudflare.</p></div>
              <div className="grid grid-cols-2 gap-3">
                {photos.map((photo, index) => <div key={photo.id} className="relative overflow-hidden rounded border bg-sand">
                  {/* eslint-disable-next-line @next/next/no-img-element */}<img src={photo.url} alt={`Foto ${index + 1}`} className="aspect-[3/4] w-full object-cover" />
                  {index === 0 && <span className="absolute left-2 top-2 rounded bg-ink px-2 py-1 text-xs text-white">Capa</span>}
                  <div className="grid grid-cols-3 bg-white"><button aria-label="Mover para esquerda" disabled={busy || index === 0} onClick={() => void reorder(index, -1)} className="p-2 disabled:opacity-30"><ArrowLeft className="mx-auto h-4 w-4" /></button><button aria-label="Mover para direita" disabled={busy || index === photos.length - 1} onClick={() => void reorder(index, 1)} className="p-2 disabled:opacity-30"><ArrowRight className="mx-auto h-4 w-4" /></button><button aria-label="Excluir foto" disabled={busy} onClick={() => void remove(photo)} className="p-2 text-red-700"><Trash2 className="mx-auto h-4 w-4" /></button></div>
                </div>)}
              </div>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-dashed p-4 font-semibold"><ImagePlus className="h-5 w-5" /> Adicionar foto<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || photos.length >= 6} onChange={(e) => void upload(e.target.files?.[0])} className="sr-only" /></label>
            </section>
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
