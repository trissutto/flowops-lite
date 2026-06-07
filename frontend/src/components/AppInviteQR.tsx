'use client';

/**
 * AppInviteQR — gera QR Code pra captação de cliente do app PWA.
 *
 * Use em qualquer tela pós-venda (PDV, comprovante, etc).
 *
 * Exemplo:
 *   <AppInviteQR sellerName="Karine" pdvSaleId={sale.id} customerCpf={customer.cpf} />
 */

import { useEffect, useState } from 'react';
import { Loader2, Sparkles, X, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';

type InviteResult = {
  token: string;
  qrUrl: string;
  bonus: number;
  expiresAt: string;
};

export default function AppInviteQR({
  sellerName,
  pdvSaleId,
  customerCpf,
  bonusCents = 2000,
  autoOpen = false,
}: {
  sellerName?: string;
  pdvSaleId?: string;
  customerCpf?: string;
  bonusCents?: number;
  autoOpen?: boolean;
}) {
  const [data, setData] = useState<InviteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(autoOpen);

  const generate = async () => {
    setLoading(true);
    try {
      const r = await api<InviteResult>('/customers/app/admin/invite/create', {
        method: 'POST',
        body: JSON.stringify({ sellerName, pdvSaleId, customerCpf, bonusCents }),
      });
      setData(r);
    } catch (err: any) {
      alert('Erro ao gerar QR: ' + (err?.message || 'desconhecido'));
    } finally {
      setLoading(false);
    }
  };

  // Auto-gera quando abrir
  useEffect(() => {
    if (open && !data && !loading) generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-br from-yellow-400 to-yellow-600 text-stone-900 rounded-xl font-bold uppercase tracking-wider text-sm shadow-lg active:scale-95 transition"
      >
        <Sparkles className="w-5 h-5" />
        Oferecer R$ {(bonusCents / 100).toFixed(0)} no app
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur flex items-center justify-center p-4">
      <div className="relative w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl">
        <button
          onClick={() => { setOpen(false); setData(null); }}
          aria-label="Fechar"
          className="absolute top-3 right-3 p-2 rounded-full bg-stone-100 hover:bg-stone-200"
        >
          <X className="w-5 h-5 text-stone-600" />
        </button>

        <div className="text-center mb-4">
          <div className="text-xs font-bold uppercase tracking-widest text-yellow-700">
            🎁 Cortesia Lurd's
          </div>
          <h2 className="font-serif text-2xl font-black mt-1 text-stone-900">
            R$ {data ? data.bonus.toFixed(0) : (bonusCents / 100).toFixed(0)} grátis
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Cliente aponta o celular no QR pra resgatar
          </p>
        </div>

        <div className="bg-stone-50 rounded-2xl p-6 mb-4">
          {loading || !data ? (
            <div className="aspect-square flex items-center justify-center">
              <Loader2 className="w-10 h-10 animate-spin text-stone-400" />
            </div>
          ) : (
            <QRCodeImage url={data.qrUrl} />
          )}
        </div>

        {data && (
          <>
            <div className="text-center text-xs text-stone-600 mb-3 font-mono break-all">
              {data.qrUrl}
            </div>
            <div className="bg-yellow-50 border border-yellow-300 rounded-xl p-3 text-xs text-stone-700">
              <strong>📣 Script vendedora:</strong>
              <p className="mt-1 italic">
                "Volta pra gente em uma promoção exclusiva! Aponta o celular aqui
                e ganha R$ {data.bonus.toFixed(0)} pra usar na próxima compra."
              </p>
            </div>
          </>
        )}

        <div className="flex gap-2 mt-4">
          <button
            onClick={generate}
            disabled={loading}
            className="flex-1 px-3 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg text-sm font-bold flex items-center justify-center gap-1.5"
          >
            <RefreshCw className="w-4 h-4" />
            Novo QR
          </button>
          <button
            onClick={() => { setOpen(false); setData(null); }}
            className="flex-1 px-3 py-2 bg-stone-900 hover:bg-stone-800 text-white rounded-lg text-sm font-bold"
          >
            Concluir
          </button>
        </div>
      </div>
    </div>
  );
}

/** Gera QR Code via API do Google (sem dep extra). Pra precisão alta, troca pelo qrcode.react. */
function QRCodeImage({ url }: { url: string }) {
  const src = `https://chart.googleapis.com/chart?cht=qr&chs=280x280&chld=H|0&chl=${encodeURIComponent(url)}`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="QR Code" className="w-full h-auto" />;
}
