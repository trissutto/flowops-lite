'use client';

/**
 * /minha-loja/live-expedicao — Painel da LOJA DE ORIGEM para vendas da Live.
 *
 * A loja recebe (em tempo real) as ordens de separação de itens vendidos na
 * live cuja origem foi atribuída a ela. Fluxo: separar → embalar/despachar
 * (gera transferência interna + conciliação) → entregue.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Check,
  Loader2,
  PackageCheck,
  Truck,
  User,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

interface QueueItem {
  id: string;
  refCode: string;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  qty: number;
  status: string;
  separatedAt: string | null;
  trackingCode: string | null;
}
interface QueueGroup {
  cartId: string;
  customerName: string;
  customerPhone: string;
  customerInstagram: string | null;
  customerCpf: string | null;
  paidAt: string | null;
  liveStoreCode: string | null;
  liveStoreName: string | null;
  items: QueueItem[];
}

export default function LiveExpedicaoPage() {
  const [groups, setGroups] = useState<QueueGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editCart, setEditCart] = useState<any | null>(null);

  // Abre o "Completar cadastro" — busca o carrinho completo pra prefill (o
  // endpoint de salvar sobrescreve tudo, então precisamos dos dados atuais).
  async function openCadastro(cartId: string) {
    try {
      const c = await api<any>(`/live-pdv/carts/${cartId}`);
      setEditCart(c);
    } catch (e: any) {
      alert('Erro ao carregar cadastro: ' + (e?.message || e));
    }
  }

  const load = useCallback(async () => {
    try {
      const data = await api<QueueGroup[]>('/live-pdv/store-queue');
      setGroups(data || []);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const onNew = () => load();
    socket.on('live-pdv:separation-new', onNew);
    return () => {
      socket.off('live-pdv:separation-new', onNew);
    };
  }, [load]);

  async function markSeparated(itemId: string) {
    setBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/separated`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function markShipped(itemId: string) {
    const trackingCode = prompt('Código de rastreio (opcional):') || undefined;
    setBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/shipped`, {
        method: 'POST',
        body: JSON.stringify({ trackingCode }),
      });
      await load();
    } catch (e: any) {
      alert(e?.message || 'Erro ao despachar');
    } finally {
      setBusy(null);
    }
  }

  async function markDelivered(itemId: string) {
    setBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/delivered`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold text-slate-800">
          <Box className="h-6 w-6 text-rose-500" /> Expedição — Live Commerce
        </h1>
        <p className="mb-4 text-sm text-slate-500">
          Pedidos da live para sua loja separar e despachar. Atualiza em tempo real.
        </p>

        {groups.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
            <PackageCheck className="mx-auto mb-2 h-10 w-10 text-slate-300" />
            Nenhum pedido pendente. 🎉
          </div>
        )}

        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.cartId} className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center gap-2 border-b border-slate-100 p-3">
                <User className="h-4 w-4 text-slate-400" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800">{g.customerName}</span>
                    {g.liveStoreName && (
                      <span
                        title="Live em que a venda foi feita (loja anfitriã)"
                        className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-rose-700"
                      >
                        Live {g.liveStoreName}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    {g.customerPhone}
                    {g.customerInstagram && ` · @${g.customerInstagram}`}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => openCadastro(g.cartId)}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                      g.customerCpf
                        ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                        : 'border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100'
                    }`}
                  >
                    {g.customerCpf ? '✓ Cadastro' : 'Completar cadastro (CPF)'}
                  </button>
                  <span className="text-xs text-slate-400">{g.items.length} item(s)</span>
                </div>
              </div>
              <div className="divide-y divide-slate-50">
                {g.items.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-800">
                        {it.refCode} · {it.cor} {it.tamanho}{' '}
                        <span className="text-slate-400">×{it.qty}</span>
                      </div>
                      <div className="truncate text-xs text-slate-500">{it.descricao}</div>
                      {it.trackingCode && (
                        <div className="text-xs text-emerald-600">Rastreio: {it.trackingCode}</div>
                      )}
                    </div>
                    {it.status === 'separating' && (
                      <>
                        {!it.separatedAt && (
                          <button
                            onClick={() => markSeparated(it.id)}
                            disabled={busy === it.id}
                            className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                          >
                            {busy === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            Separei
                          </button>
                        )}
                        <button
                          onClick={() => markShipped(it.id)}
                          disabled={busy === it.id}
                          className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                        >
                          {busy === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
                          Despachar
                        </button>
                      </>
                    )}
                    {it.status === 'shipped' && (
                      <button
                        onClick={() => markDelivered(it.id)}
                        disabled={busy === it.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {busy === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
                        Entregue
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {editCart && (
          <CadastroModal
            cart={editCart}
            onClose={() => setEditCart(null)}
            onSaved={() => {
              setEditCart(null);
              load();
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Completar cadastro (CPF + endereço) na expedição ─── */
function CadastroModal({
  cart,
  onClose,
  onSaved,
}: {
  cart: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(cart.customerName ?? '');
  const [phone, setPhone] = useState(cart.customerPhone ?? '');
  const [instagram, setInstagram] = useState(cart.customerInstagram ?? '');
  const [cpf, setCpf] = useState(cart.customerCpf ?? '');
  const [email, setEmail] = useState(cart.customerEmail ?? '');
  const [cep, setCep] = useState(cart.customerCep ?? '');
  const [endereco, setEndereco] = useState(cart.customerEndereco ?? '');
  const [numero, setNumero] = useState(cart.customerNumero ?? '');
  const [complemento, setComplemento] = useState(cart.customerComplemento ?? '');
  const [bairro, setBairro] = useState(cart.customerBairro ?? '');
  const [cidade, setCidade] = useState(cart.customerCidade ?? '');
  const [uf, setUf] = useState(cart.customerUf ?? '');
  const [cepLoading, setCepLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  async function lookupCep(raw: string) {
    const clean = raw.replace(/\D/g, '');
    if (clean.length !== 8) return;
    setCepLoading(true);
    try {
      const r = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
      const data = await r.json();
      if (!data?.erro) {
        setEndereco((prev: string) => prev || data.logradouro || '');
        setBairro((prev: string) => prev || data.bairro || '');
        setCidade((prev: string) => prev || data.localidade || '');
        setUf((prev: string) => prev || (data.uf || '').toUpperCase());
      }
    } catch {
      /* ViaCEP indisponível */
    } finally {
      setCepLoading(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      alert('Nome é obrigatório');
      return;
    }
    setSaving(true);
    try {
      await api(`/live-pdv/carts/${cart.id}/customer`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          phone: phone.replace(/\D/g, ''),
          instagram,
          cpf,
          email,
          cep: cep.replace(/\D/g, ''),
          endereco,
          numero,
          complemento,
          bairro,
          cidade,
          uf,
        }),
      });
      onSaved();
    } catch (e: any) {
      alert('Erro ao salvar: ' + (e?.message || e));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-800">
            <User className="h-5 w-5 text-rose-500" /> Completar cadastro
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-2.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome *" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          <div className="grid grid-cols-2 gap-2">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Telefone" inputMode="tel" className="rounded-lg border border-slate-300 px-3 py-2" />
            <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF" inputMode="numeric" className="rounded-lg border border-rose-300 bg-rose-50/40 px-3 py-2 font-semibold" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="Instagram (@)" className="rounded-lg border border-slate-300 px-3 py-2" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" className="rounded-lg border border-slate-300 px-3 py-2" />
          </div>
          <div className="mt-1 space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Endereço (CEP puxa o resto)</div>
            <div className="flex items-center gap-2">
              <input value={cep} onChange={(e) => { setCep(e.target.value); lookupCep(e.target.value); }} placeholder="CEP" inputMode="numeric" maxLength={9} className="w-32 rounded-lg border border-slate-300 px-3 py-2" />
              {cepLoading && <span className="text-xs text-slate-400">buscando…</span>}
            </div>
            <input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Rua / logradouro" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
            <div className="grid grid-cols-2 gap-2">
              <input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="Número" className="rounded-lg border border-slate-300 px-3 py-2" />
              <input value={complemento} onChange={(e) => setComplemento(e.target.value)} placeholder="Complemento" className="rounded-lg border border-slate-300 px-3 py-2" />
            </div>
            <input value={bairro} onChange={(e) => setBairro(e.target.value)} placeholder="Bairro" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
            <div className="grid grid-cols-[1fr_72px] gap-2">
              <input value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Cidade" className="rounded-lg border border-slate-300 px-3 py-2" />
              <input value={uf} onChange={(e) => setUf(e.target.value.toUpperCase().slice(0, 2))} placeholder="UF" maxLength={2} className="rounded-lg border border-slate-300 px-3 py-2 uppercase" />
            </div>
          </div>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-rose-600 py-2.5 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Salvar cadastro
        </button>
      </div>
    </div>
  );
}
