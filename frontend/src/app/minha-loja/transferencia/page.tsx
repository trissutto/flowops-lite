'use client';

/**
 * /minha-loja/transferencia — TRANSFERÊNCIA PONTO A PONTO
 *
 * A loja ORIGEM escolhe a loja DESTINO e bipa o código de cada peça.
 * Cada bipe cria uma peça numa remessa REM-xxx (tipo TRANSFERENCIA) e usa o
 * MESMO trilho da triagem (status Montando → Em trânsito → Recebida, baixa/
 * entrada Giga, financeiro ÷2,5, conferência por bip no destino).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowLeftRight, Send, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';

interface Store {
  id: string;
  code: string;
  name: string;
  active?: boolean;
}
interface ShipItem {
  id: string;
  refCode: string;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  descricao: string | null;
  precoUnitCents?: number | null;
}

const brl = (cents?: number | null) =>
  ((cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
interface OpenShip {
  id: string;
  code: string;
  tipo: string;
  toStoreCode: string;
  toStoreName: string;
  status: string;
  items: ShipItem[];
}

export default function TransferenciaPage() {
  const router = useRouter();
  const [stores, setStores] = useState<Store[]>([]);
  const [myStoreCode, setMyStoreCode] = useState('');
  const [destino, setDestino] = useState('');
  const [codigo, setCodigo] = useState('');
  const [shipment, setShipment] = useState<OpenShip | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Store[]>('/stores')
      .then((s) => setStores((s || []).filter((x) => x.active !== false)))
      .catch(() => {});
    api<{ storeCode?: string | null }>('/auth/me')
      .then((me) => setMyStoreCode(me?.storeCode || ''))
      .catch(() => {});
  }, []);

  // Carrega a remessa TRANSFERENCIA aberta do par origem→destino (restaura ao recarregar)
  async function loadOpen(dest: string) {
    if (!dest) {
      setShipment(null);
      return;
    }
    try {
      const all = await api<OpenShip[]>('/realignment/shipments/open');
      const s = (all || []).find(
        (x) => x.tipo === 'TRANSFERENCIA' && x.toStoreCode === dest && x.status === 'open',
      );
      setShipment(s || null);
    } catch {
      setShipment(null);
    }
  }
  useEffect(() => {
    loadOpen(destino);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destino]);

  async function bipar(e?: React.FormEvent) {
    e?.preventDefault();
    const c = codigo.trim();
    if (!destino) {
      setMsg({ type: 'err', text: 'Escolha a loja destino primeiro.' });
      return;
    }
    if (!c) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ shipmentCode: string; alerta?: string | null; item: any }>(
        '/realignment/shipments/transferencia/bipar',
        { method: 'POST', body: JSON.stringify({ destinoCode: destino, codigo: c }) },
      );
      setCodigo('');
      await loadOpen(destino);
      setMsg(
        r.alerta
          ? { type: 'warn', text: r.alerta }
          : {
              type: 'ok',
              text: `Bipado: ${r.item?.ref || c} ${r.item?.cor || ''} ${r.item?.tamanho || ''} → ${r.shipmentCode}`,
            },
      );
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || 'Falha ao bipar' });
    } finally {
      setBusy(false);
      setTimeout(() => codeRef.current?.focus(), 0);
    }
  }

  async function removerItem(id: string) {
    if (!confirm('Remover esta peça da remessa?')) return;
    setBusy(true);
    try {
      await api(`/realignment/shipments/items/${id}`, { method: 'DELETE' });
      await loadOpen(destino);
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || 'Falha ao remover' });
    } finally {
      setBusy(false);
    }
  }

  // Imprime a remessa: PDF com CAPA A4 paisagem (cidade destino + nº remessa
  // grandes) + romaneio com a lista de produtos. Electron imprime silencioso;
  // no navegador, abre popup e dispara print. Mesma estratégia do realinhamento.
  async function imprimirRemessa(shipmentId: string, code: string) {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      if (!token) return;
      const { API_URL } = await import('@/lib/api');
      const r = await fetch(`${API_URL}/api/realignment/shipments/${shipmentId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`);
      const blobUrl = URL.createObjectURL(await r.blob());

      // Romaneio é A4 (capa + lista) → imprime na impressora A4 CONFIGURADA.
      // Antes ia direto no silentPrint (impressora ativa = quase sempre a
      // térmica) e saía esticado no rolo. printPdfA4 escolhe a A4 antes.
      const { printPdfA4 } = await import('@/lib/printer-router');
      const res = await printPdfA4(blobUrl);
      if (res.mode === 'popup-blocked') {
        setMsg({ type: 'warn', text: `Remessa enviada. Popup de impressão bloqueado — habilite popups ou imprima a remessa ${code} no Realinhamento.` });
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (e: any) {
      setMsg({ type: 'warn', text: `Remessa enviada, mas falhou imprimir: ${e?.message || e}. Imprima pela tela de Realinhamento.` });
    }
  }

  async function processar() {
    if (!shipment) return;
    const shipId = shipment.id;
    const shipCode = shipment.code;
    const dest = shipment.toStoreName || shipment.toStoreCode;
    if (
      !confirm(
        `Processar e ENVIAR a remessa ${shipment.code} (${shipment.items.length} peça(s)) para ${dest}?\n\nIsso baixa o estoque na origem e a remessa vai pra "Em trânsito".`,
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      await api(`/realignment/shipments/${shipId}/close-and-send`, { method: 'POST' });
      setMsg({ type: 'ok', text: `Remessa ${shipCode} enviada para ${dest} — imprimindo capa + romaneio…` });
      setShipment(null);
      // Imprime CAPA (A4 paisagem) + romaneio (lista de produtos) automaticamente.
      await imprimirRemessa(shipId, shipCode);
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || 'Falha ao processar/enviar' });
    } finally {
      setBusy(false);
    }
  }

  const lojasDestino = stores.filter((s) => s.code !== myStoreCode);
  const totalValor = shipment?.items.reduce((sum, i) => sum + (i.precoUnitCents || 0), 0) || 0;
  const totalPecas = shipment?.items.reduce((sum, i) => sum + (i.qtyOrigem || 1), 0) || 0;

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-3xl p-4">
        {/* Header */}
        <button
          onClick={() => router.push('/minha-loja')}
          className="mb-2 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="h-4 w-4" /> Voltar
        </button>
        <div className="mb-4 flex items-center gap-2">
          <ArrowLeftRight className="h-6 w-6 text-sky-600" />
          <div>
            <h1 className="text-xl font-bold text-slate-800">Transferir Mercadoria</h1>
            <p className="text-xs text-slate-500">Ponto a ponto — escolha o destino e bipe as peças</p>
          </div>
        </div>

        {/* Destino + bipe */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Loja destino</label>
          <select
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">— escolha a loja que vai receber —</option>
            {lojasDestino.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>

          <form onSubmit={bipar} className="mt-3">
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Código do produto</label>
            <div className="mt-1 flex gap-2">
              <input
                ref={codeRef}
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                placeholder="Bipe ou digite o código e tecle Enter"
                disabled={!destino || busy}
                inputMode="numeric"
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
              <button
                type="submit"
                disabled={!destino || busy || !codigo.trim()}
                className="shrink-0 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-50"
              >
                Bipar
              </button>
            </div>
          </form>

          {msg && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
                msg.type === 'ok'
                  ? 'bg-emerald-50 text-emerald-800'
                  : msg.type === 'warn'
                  ? 'bg-amber-50 text-amber-800'
                  : 'bg-rose-50 text-rose-700'
              }`}
            >
              {msg.type === 'ok' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span>{msg.text}</span>
            </div>
          )}
        </div>

        {/* Remessa em montagem */}
        {shipment && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <span className="text-sm font-bold text-slate-800">Remessa {shipment.code}</span>
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-800">
                  Montando caixa
                </span>
              </div>
              <span className="text-xs text-slate-500">
                total <b className="text-slate-800">{brl(totalValor)}</b> · → {shipment.toStoreName || shipment.toStoreCode}
              </span>
            </div>

            {/* TOTAL DE PEÇAS — destacado */}
            <div className="mb-3 flex items-center justify-between rounded-lg bg-slate-900 px-4 py-2.5 text-white">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                Total de peças nesta remessa
              </span>
              <span className="text-3xl font-black tabular-nums leading-none">{totalPecas}</span>
            </div>

            <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
              {shipment.items.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-slate-400">Nenhuma peça bipada ainda.</div>
              )}
              {shipment.items.map((it) => (
                <div key={it.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-800">
                      {it.refCode}
                      {it.cor ? ` · ${it.cor}` : ''}
                      {it.tamanho ? ` · ${it.tamanho}` : ''}
                    </div>
                    {it.descricao && <div className="truncate text-xs text-slate-500">{it.descricao}</div>}
                  </div>
                  <span
                    className="shrink-0 text-sm font-bold tabular-nums text-slate-900"
                    title="Preço unitário (cheio) — confira com a etiqueta"
                  >
                    {brl(it.precoUnitCents)}
                  </span>
                  <button
                    onClick={() => removerItem(it.id)}
                    disabled={busy}
                    title="Remover peça"
                    className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-rose-100 hover:text-rose-600 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={processar}
              disabled={busy || shipment.items.length === 0}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" /> Processar e Enviar ({shipment.items.length})
            </button>
            <p className="mt-1 text-center text-[11px] text-slate-400">
              Ao enviar, baixa o estoque na origem. A loja destino confere por bip no Recebimento.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
