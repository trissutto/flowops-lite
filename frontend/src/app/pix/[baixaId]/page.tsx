'use client';

/**
 * /pix/[baixaId] — Página PÚBLICA pra cliente pagar PIX via link.
 *
 * Acesso sem login. URL compartilhada via WhatsApp. Mostra:
 *  - Logo Lurd's + nome da loja
 *  - Nome do cliente (parcial pra não vazar)
 *  - QR Code grande
 *  - Botão "Copiar PIX Copia e Cola"
 *  - Lista de parcelas que serão pagas
 *  - Total
 *  - Status atualizado em tempo real (polling 3s)
 *  - Tela "PAGO!" quando confirmado
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, Copy, Check, AlertCircle, CheckCircle2, Clock, ShieldCheck } from 'lucide-react';
import { API_URL } from '@/lib/api';

type PixInfo = {
  baixaId: string;
  status: string;
  isPaid: boolean;
  customerName: string;
  lojaCode: string;
  lojaName: string | null;
  totalParcelas: number;
  totalPrincipal: number;
  totalJuros: number;
  totalPago: number;
  paidAt: string | null;
  createdAt: string;
  qrCodeText: string | null;
  qrCodeImageUrl: string | null;
  expiresAt: string | null;
  items: Array<{
    numeroPromis: string | null;
    parcelaNum: number | null;
    totalParcelas: number | null;
    vencimento: string;
    valorParcela: number;
    jurosCalculado: number;
    valorPago: number;
  }>;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString('pt-BR');
  } catch {
    return iso;
  }
};

export default function PixPublicoPage() {
  const params = useParams();
  const baixaId = params.baixaId as string;
  const [info, setInfo] = useState<PixInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyMsg, setCopyMsg] = useState(false);

  // Carrega info uma vez no mount.
  // IMPORTANTE: backend tem globalPrefix='api' (main.ts), então a URL real
  // é ${API_URL}/api/pix-publico/:baixaId. Sem o /api retorna "Cannot GET".
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_URL}/api/pix-publico/${baixaId}`);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err?.message || `Erro ${r.status}`);
        }
        const data = await r.json();
        setInfo(data);
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [baixaId]);

  // Polling de status (3s) enquanto pending
  useEffect(() => {
    if (!info || info.isPaid) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API_URL}/api/pix-publico/${baixaId}/status`);
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        if (data.isPaid) {
          // Recarrega dados completos
          const r2 = await fetch(`${API_URL}/api/pix-publico/${baixaId}`);
          if (r2.ok) {
            const fresh = await r2.json();
            setInfo(fresh);
          }
        }
      } catch {/* noop */}
    };
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [info, baixaId]);

  async function copyPix() {
    if (!info?.qrCodeText) return;
    try {
      await navigator.clipboard.writeText(info.qrCodeText);
      setCopyMsg(true);
      setTimeout(() => setCopyMsg(false), 2500);
    } catch {/* noop */}
  }

  // ── Estados ────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-50 to-pink-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center">
          <Loader2 className="w-10 h-10 animate-spin mx-auto text-rose-600" />
          <div className="mt-4 text-gray-700 font-bold">Carregando…</div>
        </div>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-50 to-pink-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center">
          <AlertCircle className="w-12 h-12 mx-auto text-rose-600" />
          <div className="mt-3 font-bold text-rose-900">Não foi possível carregar</div>
          <div className="mt-2 text-sm text-gray-600">{error || 'Cobrança não encontrada'}</div>
          <div className="mt-4 text-xs text-gray-500">
            Confere se o link está correto ou contata a loja.
          </div>
        </div>
      </div>
    );
  }

  // PAGO — tela de sucesso
  if (info.isPaid) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-green-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-sm w-full text-center">
          <div className="w-20 h-20 bg-emerald-500 rounded-full mx-auto flex items-center justify-center shadow-lg">
            <CheckCircle2 className="w-12 h-12 text-white" strokeWidth={3} />
          </div>
          <div className="mt-4 text-2xl font-black text-emerald-900">Pagamento confirmado!</div>
          <div className="mt-2 text-sm text-gray-700">
            Recebemos seu PIX de <b className="text-emerald-700">{brl(info.totalPago)}</b>
          </div>
          <div className="mt-4 bg-emerald-50 rounded-lg p-3 text-xs text-emerald-900">
            ✓ {info.totalParcelas} parcela{info.totalParcelas > 1 ? 's' : ''} quitada{info.totalParcelas > 1 ? 's' : ''}<br />
            ✓ Suas promissórias estão liquidadas<br />
            ✓ Você pode passar na loja {info.lojaName} pra retirá-las
          </div>
          {info.paidAt && (
            <div className="mt-3 text-[10px] text-gray-500">
              Confirmado em {new Date(info.paidAt).toLocaleString('pt-BR')}
            </div>
          )}
          <div className="mt-6 text-xs text-gray-400">
            LURD&apos;S Plus Size · Obrigado pela preferência
          </div>
        </div>
      </div>
    );
  }

  // PENDING — tela do PIX pra pagar
  if (!info.qrCodeText) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-50 to-pink-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center">
          <Loader2 className="w-10 h-10 animate-spin mx-auto text-rose-600" />
          <div className="mt-4 text-gray-700 font-bold">Gerando QR Code…</div>
          <div className="mt-2 text-xs text-gray-500">Aguarde alguns segundos</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-pink-50 to-fuchsia-50 p-4 md:p-8">
      <div className="max-w-md mx-auto">
        {/* Cabeçalho */}
        <div className="text-center mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/lurds-logo.png"
            alt="Lurd's Plus Size"
            className="h-16 mx-auto"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <h1 className="mt-2 text-xl font-black text-rose-900">LURD&apos;S Plus Size</h1>
          <div className="text-xs text-gray-600">
            Loja {info.lojaName || info.lojaCode}
          </div>
        </div>

        {/* Card principal */}
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden">
          <div className="bg-gradient-to-br from-rose-500 to-pink-600 text-white p-5 text-center">
            <div className="text-xs uppercase opacity-90 font-bold">Olá, {info.customerName}</div>
            <div className="text-3xl font-black mt-1 tabular-nums">{brl(info.totalPago)}</div>
            <div className="text-xs opacity-90 mt-1">
              {info.totalParcelas} parcela{info.totalParcelas > 1 ? 's' : ''} de crediário
            </div>
          </div>

          <div className="p-5 space-y-4">
            {/* QR Code */}
            <div className="bg-emerald-50 border-2 border-emerald-300 rounded-2xl p-4 flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={info.qrCodeImageUrl || ''}
                alt="QR Code PIX"
                className="max-w-[260px] w-full"
              />
            </div>

            {/* Botão copiar */}
            <button
              onClick={copyPix}
              className="w-full p-4 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-md transition"
            >
              {copyMsg ? (
                <>
                  <Check size={20} /> Copiado! Cole no app do banco
                </>
              ) : (
                <>
                  <Copy size={20} /> Copiar código PIX
                </>
              )}
            </button>

            {/* Status aguardando */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center text-sm text-amber-900">
              <Clock size={18} className="inline mr-1" />
              <b>Aguardando pagamento</b>
              <div className="text-xs mt-1">
                Assim que pagar, esta tela atualiza sozinha.
              </div>
            </div>

            {/* Lista de parcelas */}
            <div>
              <div className="text-xs font-bold uppercase text-gray-700 mb-2">
                Parcelas que serão quitadas:
              </div>
              <div className="bg-gray-50 rounded-lg divide-y divide-gray-200">
                {info.items.map((it, i) => (
                  <div key={i} className="p-3 flex justify-between items-center text-sm">
                    <div>
                      <div className="font-mono font-bold text-gray-800">
                        {it.numeroPromis || `Parc. ${i + 1}`}
                      </div>
                      <div className="text-xs text-gray-500">
                        Venc. {formatDate(it.vencimento)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold tabular-nums">{brl(it.valorPago)}</div>
                      {it.jurosCalculado > 0 && (
                        <div className="text-[10px] text-rose-700">
                          + {brl(it.jurosCalculado)} juros
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Totais */}
            {info.totalJuros > 0 && (
              <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2">
                <div className="flex justify-between">
                  <span>Principal:</span>
                  <span className="tabular-nums">{brl(info.totalPrincipal)}</span>
                </div>
                <div className="flex justify-between text-rose-700">
                  <span>Juros por atraso:</span>
                  <span className="tabular-nums">{brl(info.totalJuros)}</span>
                </div>
                <div className="border-t border-gray-300 pt-1 mt-1 flex justify-between font-bold">
                  <span>Total:</span>
                  <span className="tabular-nums text-emerald-700">{brl(info.totalPago)}</span>
                </div>
              </div>
            )}

            {/* Como pagar */}
            <details className="bg-blue-50 rounded-lg p-3 text-sm">
              <summary className="font-bold text-blue-900 cursor-pointer">
                Como pagar?
              </summary>
              <ol className="mt-2 list-decimal pl-5 space-y-1 text-blue-900 text-xs">
                <li>Abra o app do seu banco</li>
                <li>Procura por <b>PIX</b> → <b>Copia e Cola</b> (ou <b>QR Code</b>)</li>
                <li>Cole o código (botão verde acima) ou escaneia o QR</li>
                <li>Confere o valor e confirma</li>
                <li>Pronto! Esta tela vai atualizar automaticamente</li>
              </ol>
            </details>

            {/* Segurança */}
            <div className="text-center text-[10px] text-gray-500 flex items-center justify-center gap-1">
              <ShieldCheck size={12} />
              Pagamento processado pela Pagar.me
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
