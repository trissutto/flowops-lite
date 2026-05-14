'use client';

/**
 * /minha-loja/imprimir/[id] — Cupom de separação pra impressora térmica 80mm.
 *
 * - Layout 72mm útil (papel 80mm com margem)
 * - Fonte monospace
 * - Sem cores, sem ícones, sem nada que gaste tinta/desbote
 * - Auto-dispara window.print() ao terminar de carregar
 * - Fecha a janela depois de imprimir (ou cancelar)
 *
 * Compatível com qualquer impressora padrão Windows configurada
 * pra papel 80mm (Bematech MP-4200, Epson TM-T20, Elgin i9, Daruma DR800, etc).
 */

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { parseShippingAddress, formatPhone } from '@/lib/format-address';
import { classifyShipping } from '@/lib/shipping-method';

interface PickItem {
  id?: string;
  sku: string;
  productName?: string | null;
  variant?: string | null;
  quantity: number;
}
interface PickDetail {
  id: string;
  status: string;
  trackingCode: string | null;
  carrier: string | null;
  createdAt: string;
  isTransfer?: boolean;
  transferToStoreCode?: string | null;
  customerSnapshot?: {
    name?: string | null;
    cpf?: string | null;
    email?: string | null;
    phone?: string | null;
    shippingAddress?: string | null;
    shippingCep?: string | null;
  } | null;
  store: { id: string; code: string; name: string };
  order: {
    id: string;
    wcOrderId: number | null;
    wcOrderNumber: string | null;
    customerName: string | null;
    customerPhone: string | null;
    customerCpf?: string | null;
    customerEmail?: string | null;
    shippingCep: string | null;
    shippingAddress: string | null;
    shippingMethod?: string | null;
    isPickup?: boolean;
    totalAmount: number | null;
    wcDateCreated?: string | null;
    items: PickItem[];
  };
}

// Envolve em Suspense porque usa useSearchParams (exigido pelo Next 14 no build estático)
export default function ImprimirCupomPage() {
  return (
    <Suspense fallback={<div className="p-4 font-mono text-xs">Carregando…</div>}>
      <ImprimirCupomPageInner />
    </Suspense>
  );
}

function ImprimirCupomPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const autoprint = searchParams?.get('autoprint') === '1';
  const [pick, setPick] = useState<PickDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fotos dos produtos buscadas no WooCommerce — usadas no impresso pra
  // facilitar separação. Map<sku, url|null>. undefined = ainda carregando.
  const [photos, setPhotos] = useState<Record<string, string | null>>({});
  const [photosReady, setPhotosReady] = useState(false);

  useEffect(() => {
    api<PickDetail>(`/pick-orders/${id}`)
      .then((data) => setPick(data))
      .catch((e) => setError(e.message));
  }, [id]);

  // Carrega fotos de TODOS os itens em paralelo. Marca photosReady=true
  // quando terminar (mesmo que algumas tenham falhado). O auto-print só
  // dispara depois disso pra garantir que as fotos saiam no impresso.
  useEffect(() => {
    if (!pick) return;
    const skus = Array.from(new Set(pick.order.items.map((it) => it.sku).filter(Boolean)));
    if (skus.length === 0) {
      setPhotosReady(true);
      return;
    }
    let cancelled = false;
    (async () => {
      // 1) Busca URLs da API
      const results = await Promise.all(
        skus.map(async (sku) => {
          try {
            const r = await api<{ url: string | null }>(`/pdv/product-image?sku=${encodeURIComponent(sku)}`);
            return [sku, r.url] as const;
          } catch {
            return [sku, null] as const;
          }
        }),
      );
      if (cancelled) return;
      const map: Record<string, string | null> = {};
      for (const [sku, url] of results) map[sku] = url;
      setPhotos(map);

      // 2) Pré-carrega as imagens via Image() — garante que estão no cache
      // do browser ANTES do print. Sem isso, o window.print() disparava com
      // <img> ainda sem byte algum e saía em branco no impresso.
      const urls = results.map(([, u]) => u).filter((u): u is string => !!u);
      if (urls.length === 0) {
        setPhotosReady(true);
        return;
      }
      await Promise.all(
        urls.map(
          (u) =>
            new Promise<void>((resolve) => {
              const im = new Image();
              im.onload = () => resolve();
              im.onerror = () => resolve(); // segue mesmo se falhar
              im.src = u;
              setTimeout(() => resolve(), 6000); // fail-safe
            }),
        ),
      );
      setTimeout(() => { if (!cancelled) setPhotosReady(true); }, 400);
    })();
    return () => { cancelled = true; };
  }, [pick]);

  // Quando os dados carregam, dispara a impressão.
  //
  // MODO 1 (remoto via Electron hidden window): autoprint=1 + electronAPI.notifyPrintReady
  //   → só SINALIZA que os dados carregaram. O main process (silent-print-url)
  //     chama webContents.print() direto na hidden window e fecha depois.
  //     NÃO chamamos silentPrintHTML aqui porque renderizar numa 2ª hidden window
  //     com data:URL perde CSS/fonts do Next.
  //
  // MODO 2 (popup browser ou impressão local): window.print() abre o diálogo
  //   normal do sistema operacional.
  useEffect(() => {
    if (!pick || !photosReady) return; // espera fotos carregarem
    const t = setTimeout(async () => {
      const electron = (window as any).electronAPI;
      if (autoprint && electron?.notifyPrintReady) {
        try {
          electron.notifyPrintReady();
          // Main process vai imprimir a própria webContents e destruir a hidden window.
        } catch (e) {
          console.warn('notifyPrintReady falhou, caindo pra window.print():', e);
          window.print();
        }
      } else {
        // Fora do Electron (popup browser ou impressão local) → diálogo do SO
        window.print();
      }
    }, 250);
    return () => clearTimeout(t);
  }, [pick, photosReady, autoprint]);

  // Após print (ou cancelamento), fecha a janela
  useEffect(() => {
    function handleAfterPrint() {
      // Fecha somente se foi aberto via window.open (popup) OU se for autoprint (hidden win)
      setTimeout(() => {
        if (window.opener || autoprint) {
          try { window.close(); } catch {}
        }
      }, 300);
    }
    window.addEventListener('afterprint', handleAfterPrint);
    return () => window.removeEventListener('afterprint', handleAfterPrint);
  }, [autoprint]);

  if (error) {
    return (
      <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
        Erro ao carregar pedido: {error}
      </div>
    );
  }
  if (!pick) {
    return <div style={{ padding: 16 }}>Carregando...</div>;
  }

  // Em transferência, os dados reais do CLIENTE estão no snapshot do pick-order
  // (a Order local tem a loja de retirada como "cliente" pra fins de emissão de NF).
  // Fora de transferência, usa direto os campos do Order.
  const snap = pick.customerSnapshot ?? null;
  const isTransfer = pick.isTransfer === true;
  const customerName  = isTransfer ? (snap?.name  ?? pick.order.customerName)  : pick.order.customerName;
  const customerPhone = isTransfer ? (snap?.phone ?? pick.order.customerPhone) : pick.order.customerPhone;
  const customerCpf   = isTransfer ? (snap?.cpf   ?? pick.order.customerCpf ?? null)   : (pick.order.customerCpf ?? null);
  const customerEmail = isTransfer ? (snap?.email ?? pick.order.customerEmail ?? null) : (pick.order.customerEmail ?? null);
  const shippingAddress = isTransfer ? (snap?.shippingAddress ?? pick.order.shippingAddress) : pick.order.shippingAddress;
  const shippingCep = isTransfer ? (snap?.shippingCep ?? pick.order.shippingCep) : pick.order.shippingCep;

  const addr = parseShippingAddress(shippingAddress);
  const orderNum = pick.order.wcOrderNumber ?? pick.order.wcOrderId ?? '—';
  const dataPedido = pick.order.wcDateCreated
    ? new Date(pick.order.wcDateCreated).toLocaleString('pt-BR')
    : new Date(pick.createdAt).toLocaleString('pt-BR');
  const dataImpressao = new Date().toLocaleString('pt-BR');

  // Passa UF pra resolver PROMOCIONAL → SEDEX (SP) ou PAC (outros estados)
  const shippingBadge = classifyShipping(pick.order.shippingMethod ?? '', addr?.state ?? null);

  return (
    <>
      {/* CSS específico — 80mm térmica */}
      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 3mm 2mm;
        }
        @media print {
          html,
          body {
            width: 76mm;
            background: #fff;
            color: #000;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .no-print {
            display: none !important;
          }
          /* Força fotos saírem no print. Sem isso o Chrome pode esconder
             imagens de origens externas. */
          .item-photo {
            display: block !important;
            visibility: visible !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
        body {
          font-family: 'Courier New', Courier, monospace;
          font-size: 11px;
          line-height: 1.35;
          color: #000;
          background: #f3f4f6;
          margin: 0;
        }
        .cupom {
          width: 72mm;
          margin: 0 auto;
          background: #fff;
          padding: 4mm 3mm;
          box-sizing: border-box;
        }
        @media screen {
          .cupom {
            margin: 16px auto;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
          }
        }
        .center { text-align: center; }
        .right { text-align: right; }
        .bold { font-weight: bold; }
        .big {
          font-size: 16px;
          font-weight: bold;
        }
        .huge {
          font-size: 22px;
          font-weight: bold;
        }
        .sep {
          border: none;
          border-top: 1px dashed #000;
          margin: 4px 0;
        }
        .row {
          display: flex;
          justify-content: space-between;
          gap: 4px;
        }
        .label {
          text-transform: uppercase;
          font-size: 9px;
          letter-spacing: 0.5px;
        }
        .item {
          margin: 4px 0;
          padding-bottom: 3px;
          border-bottom: 1px dotted #999;
        }
        .item:last-child {
          border-bottom: none;
        }
        .qty {
          font-size: 14px;
          font-weight: bold;
        }
        .sku {
          font-size: 9px;
          color: #444;
        }
        .item-row-with-img {
          display: flex;
          gap: 6px;
          align-items: flex-start;
        }
        .item-photo {
          width: 56px;
          height: 56px;
          object-fit: cover;
          border: 1px solid #000;
          flex-shrink: 0;
          filter: grayscale(100%) contrast(1.6) brightness(1.05);
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .item-photo-placeholder {
          width: 56px;
          height: 56px;
          border: 1px dashed #888;
          flex-shrink: 0;
          font-size: 8px;
          color: #888;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 2px;
        }
        .item-body {
          flex: 1;
          min-width: 0;
        }
        .checkbox {
          display: inline-block;
          width: 11px;
          height: 11px;
          border: 1.5px solid #000;
          margin-right: 4px;
          vertical-align: middle;
        }
        .toolbar {
          position: fixed;
          top: 8px;
          right: 8px;
          display: flex;
          gap: 6px;
        }
        .toolbar button {
          font-family: sans-serif;
          font-size: 12px;
          padding: 6px 12px;
          border: 1px solid #ccc;
          background: #fff;
          cursor: pointer;
          border-radius: 4px;
        }
      `}</style>

      {/* Botões de fallback (não imprimem) */}
      <div className="toolbar no-print">
        <button onClick={() => window.print()}>🖨 Imprimir</button>
        <button onClick={() => window.close()}>Fechar</button>
      </div>

      <div className="cupom">
        {/* Cabeçalho */}
        <div className="center" style={{ marginBottom: 4 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/lurds-logo.png"
            alt="Lurd's Plus Size"
            style={{ height: 36, width: 'auto', filter: 'grayscale(100%) contrast(1.4)' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="center bold">LURD'S PLUS SIZE · SEPARAÇÃO</div>
        <div className="center">{pick.store.name} ({pick.store.code})</div>
        <div className="center" style={{ fontSize: 9 }}>
          Impresso em {dataImpressao}
        </div>

        <hr className="sep" />

        {/* Pedido */}
        <div className="center label">PEDIDO</div>
        <div className="center huge">#{orderNum}</div>
        <div className="center" style={{ fontSize: 9 }}>
          Criado em {dataPedido}
        </div>

        {/* FORMA DE ENVIO — destaque grande logo após o número do pedido, pra
             conferente bater o olho antes de separar (SEDEX/PAC/RETIRADA). */}
        {shippingBadge.kind !== 'other' && (
          <>
            <hr className="sep" />
            <div className="center label">Forma de Envio</div>
            <div className="center big">{shippingBadge.label}</div>
            {pick.order.shippingMethod &&
              pick.order.shippingMethod.toUpperCase() !== shippingBadge.label && (
                <div className="center" style={{ fontSize: 9 }}>
                  {pick.order.shippingMethod}
                </div>
              )}
          </>
        )}

        {isTransfer && pick.transferToStoreCode && (
          <>
            <hr className="sep" />
            <div className="center bold" style={{ fontSize: 12 }}>
              🚚 TRANSFERIR PRA LOJA {pick.transferToStoreCode}
            </div>
            <div className="center" style={{ fontSize: 9 }}>
              Cliente vai retirar lá. Não é venda direta.
            </div>
          </>
        )}

        <hr className="sep" />

        {/* Cliente — dados completos pra emissão de NF, follow-up ou conferência */}
        <div className="label">Cliente</div>
        <div className="bold">{customerName ?? '—'}</div>
        {customerCpf && <div>CPF: {customerCpf}</div>}
        {customerPhone && <div>Tel: {formatPhone(customerPhone)}</div>}
        {customerEmail && (
          <div style={{ wordBreak: 'break-all' }}>Email: {customerEmail}</div>
        )}

        <hr className="sep" />

        {/* Endereço */}
        <div className="label">Endereço de Entrega</div>
        {addr?.recipientName && <div>{addr.recipientName}</div>}
        {addr?.streetLine && <div>{addr.streetLine}</div>}
        {addr?.complement && <div>Compl: {addr.complement}</div>}
        {addr?.neighborhood && <div>Bairro: {addr.neighborhood}</div>}
        {addr?.cityState && <div>{addr.cityState}</div>}
        {(addr?.cep || shippingCep) && (
          <div className="bold">CEP: {addr?.cep ?? shippingCep}</div>
        )}
        {!addr?.streetLine && addr?.oneLiner && (
          <div style={{ wordBreak: 'break-word' }}>{addr.oneLiner}</div>
        )}

        <hr className="sep" />

        {/* Itens */}
        <div className="label">
          Itens ({pick.order.items.length}) — separar:
        </div>
        {pick.order.items.map((it, idx) => {
          const photoUrl = photos[it.sku];
          return (
            <div key={it.id ?? `${it.sku}-${idx}`} className="item">
              <div className="item-row-with-img">
                {photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photoUrl}
                    alt={it.sku}
                    className="item-photo"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="item-photo-placeholder">sem foto</div>
                )}
                <div className="item-body">
                  <div>
                    <span className="checkbox" />
                    <span className="qty">{it.quantity}x</span>
                  </div>
                  <div className="bold">{it.productName ?? '—'}</div>
                  {it.variant && <div>{it.variant}</div>}
                  <div className="sku">SKU: {it.sku}</div>
                </div>
              </div>
            </div>
          );
        })}

        <hr className="sep" />

        {/* Total */}
        {pick.order.totalAmount != null && (
          <div className="row bold big">
            <div>TOTAL:</div>
            <div>R$ {Number(pick.order.totalAmount).toFixed(2).replace('.', ',')}</div>
          </div>
        )}

        <hr className="sep" />

        {/* Conferência */}
        <div className="label">Conferência</div>
        <div style={{ marginTop: 6 }}>
          Separado por: ______________________
        </div>
        <div style={{ marginTop: 8 }}>
          Conferido por: _____________________
        </div>
        <div style={{ marginTop: 8 }}>
          Data/Hora: ________________________
        </div>

        <hr className="sep" />

        {/* Rastreio se já enviado */}
        {pick.trackingCode && (
          <>
            <div className="label">Rastreio</div>
            <div className="bold">{pick.trackingCode}</div>
            {pick.carrier && <div>{pick.carrier}</div>}
            <hr className="sep" />
          </>
        )}

        <div className="center" style={{ fontSize: 9, marginTop: 6 }}>
          LURDS ORDER ONE · Pick #{pick.id.slice(0, 8)}
        </div>
      </div>
    </>
  );
}
