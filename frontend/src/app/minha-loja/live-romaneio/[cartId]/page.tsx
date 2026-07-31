'use client';

/**
 * /minha-loja/live-romaneio/[cartId] — ROMANEIO do pedido da live (80mm).
 *
 * Impresso pela loja de origem na separação: destinatária completa, FORMA DE
 * ENVIO (SEDEX/PAC), itens e valores. Aberto via routePrint (app desktop =
 * impressão silenciosa na térmica; Chrome puro = diálogo). Mesmo padrão de
 * auto-print do recibo: notifyPrintReady no Electron, window.print no browser.
 *
 * Dados: GET /live-pdv/store-queue (a fila da própria loja logada) — o cart
 * precisa estar em separação/enviado NESTA loja, o que é sempre o caso quando
 * o botão é clicado no card da home.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

const brl = (cents: number | null | undefined) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function LiveRomaneioPage() {
  const params = useParams<{ cartId: string }>();
  const cartId = params?.cartId as string;
  const [group, setGroup] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cartId) return;
    api<any[]>('/live-pdv/store-queue')
      .then((groups) => {
        const g = (groups || []).find((x) => x.cartId === cartId);
        if (!g) setError('Pedido não está na fila desta loja.');
        else setGroup(g);
      })
      .catch((e: any) => setError(e?.message || 'Erro ao carregar pedido'));
  }, [cartId]);

  // Auto-print: app desktop → notifyPrintReady (main imprime silencioso na
  // térmica); browser puro → window.print(). Mesmo padrão do recibo/NFC-e.
  useEffect(() => {
    if (!group) return;
    const t = setTimeout(() => {
      const electron = (window as any).electronAPI;
      if (electron?.notifyPrintReady) {
        try { electron.notifyPrintReady(); } catch { try { window.print(); } catch {} }
      } else {
        try { window.print(); } catch {}
      }
    }, 350);
    return () => clearTimeout(t);
  }, [group]);

  if (error) return <div style={{ padding: 24, fontFamily: 'system-ui', color: '#b91c1c' }}>{error}</div>;
  if (!group) return <div style={{ padding: 16, fontFamily: 'monospace' }}>Carregando romaneio…</div>;

  const pagas = group.paymentMethod === 'link' ? 'LINK (CARTÃO)' : group.paymentMethod === 'pix' ? 'PIX' : '—';

  return (
    <>
      <style jsx global>{`
        @page { size: 80mm auto; margin: 0; }
        body {
          font-family: 'Courier New', monospace;
          font-size: 11px;
          font-weight: 600;
          width: 72mm;
          max-width: 72mm;
          box-sizing: border-box;
          margin: 0;
          padding: 2mm;
          color: #000;
          line-height: 1.3;
          overflow-wrap: anywhere;
        }
        .r { width: 100%; }
        .center { text-align: center; }
        .bold { font-weight: 900; }
        .lg { font-size: 13px; font-weight: 900; }
        .xl { font-size: 15px; font-weight: 900; }
        .sep { border-top: 2px dashed #000; margin: 5px 0; }
        .row { display: flex; justify-content: space-between; gap: 4px; }
        .envio { border: 2px solid #000; padding: 4px 6px; margin: 5px 0; text-align: center; font-size: 14px; font-weight: 900; }
      `}</style>
      <div className="r">
        <div className="center xl">PEDIDO DA LIVE</div>
        {group.liveStoreName && <div className="center">LIVE {String(group.liveStoreName).toUpperCase()}</div>}
        {group.cartNumber != null && <div className="center lg">Carrinho #{group.cartNumber}</div>}
        <div className="sep" />

        <div className="bold">DESTINATÁRIA</div>
        <div className="lg">{group.customerName}</div>
        {group.customerInstagram && <div>@{group.customerInstagram}</div>}
        {group.customerPhone && <div>Tel: {group.customerPhone}</div>}
        {group.customerCpf && <div>CPF: {group.customerCpf}</div>}
        <div className="sep" />

        {group.isPickup ? (
          <div className="envio">🏬 RETIRADA NA LOJA {String(group.pickupStoreName || group.pickupStoreCode || '').toUpperCase()} — NÃO POSTAR</div>
        ) : (
          <>
            <div className="bold">ENDEREÇO DE ENTREGA</div>
            <div>
              {group.customerEndereco}
              {group.customerNumero ? `, ${group.customerNumero}` : ''}
              {group.customerComplemento ? ` — ${group.customerComplemento}` : ''}
            </div>
            {group.customerBairro && <div>Bairro: {group.customerBairro}</div>}
            <div>
              {group.customerCidade}
              {group.customerUf ? ` - ${group.customerUf}` : ''}
            </div>
            {group.customerCep && <div className="bold">CEP: {group.customerCep}</div>}
            <div className="envio">📮 ENVIAR POR {group.freteServico || 'PAC'}</div>
          </>
        )}
        <div className="sep" />

        <div className="bold">PEÇAS ({group.items?.length || 0})</div>
        {(group.items || []).map((it: any) => (
          <div key={it.id} style={{ marginBottom: 3 }}>
            <div className="bold">
              {it.refCode} · {it.cor || ''} {it.tamanho || ''} ×{it.qty}
            </div>
            {it.descricao && <div style={{ fontSize: 10 }}>{it.descricao}</div>}
          </div>
        ))}
        <div className="sep" />

        <div className="row"><span>Pagamento</span><span className="bold">{pagas}</span></div>
        {group.subtotalCents != null && <div className="row"><span>Peças</span><span>{brl(group.subtotalCents)}</span></div>}
        {(group.freteCents ?? 0) > 0 && (
          <div className="row"><span>Frete{group.freteServico ? ` (${group.freteServico})` : ''}</span><span>{brl(group.freteCents)}</span></div>
        )}
        {group.totalCents != null && <div className="row lg"><span>TOTAL</span><span>{brl(group.totalCents)}</span></div>}
        {group.paidAt && (
          <div style={{ fontSize: 10 }}>
            Pago em {new Date(group.paidAt).toLocaleString('pt-BR')}
          </div>
        )}
        <div className="sep" />
        <div className="center" style={{ fontSize: 10 }}>
          Conferir peça a peça no bip antes de postar.
        </div>
        <div className="center bold" style={{ marginTop: 4 }}>LURD'S PLUS SIZE</div>
      </div>
    </>
  );
}
