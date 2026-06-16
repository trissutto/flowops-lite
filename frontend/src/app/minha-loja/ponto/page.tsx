'use client';

/**
 * /minha-loja/ponto — Bater ponto eletrônico no PDV (face recognition).
 *
 * Fluxo:
 *  1. Carrega face-api.js + descriptors das vendedoras da loja
 *  2. Camera ativa em loop: a cada 1.2s, detecta rosto e compara
 *  3. Se distância < THRESHOLD (0.5) com algum descriptor → exibe nome + 4 botões
 *  4. Vendedora confirma tipo → POST /ponto/registrar → toast "ok, bateu"
 *  5. Volta pro modo "aguardando"
 *
 * Threshold 0.5 = ~80% de confiança (padrão face-api.js é 0.6).
 * Quanto MENOR a distância, MAIS parecido. 0 = idêntico, 1 = nada a ver.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Camera, CheckCircle2, LogIn, LogOut, Coffee, Utensils,
  Loader2, AlertTriangle, History, RotateCcw,
} from 'lucide-react';
import Link from 'next/link';
import FaceCapture, { FaceCaptureHandle } from '@/components/rh/FaceCapture';
import { api } from '@/lib/api';

type SellerDescriptors = {
  id: string;
  name: string;
  cargo: string;
  descriptors: number[][];
};

type Me = { id: string; storeId: string; storeName: string };

const MATCH_THRESHOLD = 0.5; // distância euclidiana — menor = mais parecido
const DETECT_INTERVAL_MS = 1200;

const TIPOS = [
  {
    key: 'entrada',
    label: 'ENTRADA',
    icon: LogIn,
    color: 'bg-emerald-500 hover:bg-emerald-600',
    light: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  {
    key: 'saida_almoco',
    label: 'SAÍDA ALMOÇO',
    icon: Utensils,
    color: 'bg-amber-500 hover:bg-amber-600',
    light: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  {
    key: 'volta_almoco',
    label: 'VOLTA ALMOÇO',
    icon: Coffee,
    color: 'bg-amber-600 hover:bg-amber-700',
    light: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  {
    key: 'saida',
    label: 'SAÍDA',
    icon: LogOut,
    color: 'bg-rose-500 hover:bg-rose-600',
    light: 'bg-rose-50 text-rose-700 border-rose-200',
  },
];

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function findBestMatch(
  descriptor: number[],
  sellers: SellerDescriptors[],
): { seller: SellerDescriptors; distance: number } | null {
  let best: { seller: SellerDescriptors; distance: number } | null = null;
  for (const s of sellers) {
    for (const d of s.descriptors) {
      const dist = euclidean(descriptor, d);
      if (!best || dist < best.distance) {
        best = { seller: s, distance: dist };
      }
    }
  }
  return best;
}

export default function PontoPage() {
  const captureRef = useRef<FaceCaptureHandle>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [me, setMe] = useState<Me | null>(null);
  const [sellers, setSellers] = useState<SellerDescriptors[]>([]);
  const [matched, setMatched] = useState<{ seller: SellerDescriptors; distance: number } | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const [lastSuccess, setLastSuccess] = useState<{ name: string; tipo: string; at: Date } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadingDescriptors, setLoadingDescriptors] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Carrega "me" pra pegar storeId
  useEffect(() => {
    api<Me>('/auth/me')
      .then((m) => setMe(m))
      .catch((e) => setErrorMsg(e?.message || 'Falha ao carregar usuário'));
  }, []);

  // Quando tem storeId, carrega descriptors
  useEffect(() => {
    if (!me?.storeId) return;
    setLoadingDescriptors(true);
    api<SellerDescriptors[]>(`/ponto/face/descriptors/${me.storeId}`)
      .then((arr) => setSellers(arr || []))
      .catch((e) => setErrorMsg(e?.message || 'Falha ao carregar descriptors'))
      .finally(() => setLoadingDescriptors(false));
  }, [me?.storeId]);

  // Loop de detecção
  useEffect(() => {
    if (!ready || sellers.length === 0 || matched || registering) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(async () => {
      if (!captureRef.current || matched || registering) return;
      try {
        const desc = await captureRef.current.captureDescriptor();
        if (!desc) return;
        const best = findBestMatch(desc, sellers);
        if (best && best.distance < MATCH_THRESHOLD) {
          setMatched(best);
        }
      } catch (e) {
        // silently ignore — próximo frame tenta de novo
      }
    }, DETECT_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [ready, sellers, matched, registering]);

  async function bater(tipo: string) {
    if (!matched || !me?.storeId) return;
    setRegistering(tipo);
    setErrorMsg(null);
    try {
      const snapshot = captureRef.current?.captureSnapshot() || undefined;
      const confidence = 1 - matched.distance; // distância → confiança
      await api('/ponto/registrar', {
        method: 'POST',
        body: JSON.stringify({
          sellerId: matched.seller.id,
          storeId: me.storeId,
          tipo,
          source: 'face_pdv',
          faceConfidence: confidence,
          snapshot,
        }),
      });
      setLastSuccess({
        name: matched.seller.name,
        tipo,
        at: new Date(),
      });
      // Volta pra modo aguardando após 4s
      setTimeout(() => {
        setLastSuccess(null);
        setMatched(null);
      }, 4000);
    } catch (e: any) {
      setErrorMsg(e?.message || 'Falha ao registrar');
      setTimeout(() => {
        setMatched(null);
        setErrorMsg(null);
      }, 3500);
    } finally {
      setRegistering(null);
    }
  }

  function cancelar() {
    setMatched(null);
    setErrorMsg(null);
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <header className="bg-slate-800 text-white sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/minha-loja" className="p-2 hover:bg-white/10 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-bold">Ponto Eletrônico</h1>
            <p className="text-xs text-white/60">
              {me?.storeName || '...'} · {sellers.length} cadastradas
            </p>
          </div>
          <Link
            href="/minha-loja/ponto/historico"
            className="text-xs text-white/80 hover:text-white flex items-center gap-1"
          >
            <History className="w-4 h-4" />
            Histórico
          </Link>
        </div>
      </header>

      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <FaceCapture
          ref={captureRef}
          onReady={() => setReady(true)}
          onError={(err) => setErrorMsg(err)}
          showStatus={false}
        />

        {/* Sucesso! */}
        {lastSuccess && (
          <div className="bg-emerald-500 text-white rounded-xl p-5 text-center shadow-lg animate-in fade-in zoom-in">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-2" />
            <p className="text-sm uppercase font-bold opacity-90">
              {TIPOS.find((t) => t.key === lastSuccess.tipo)?.label}
            </p>
            <p className="text-2xl font-bold mt-1">{lastSuccess.name}</p>
            <p className="text-xs opacity-80 mt-1">
              {lastSuccess.at.toLocaleTimeString('pt-BR')}
            </p>
          </div>
        )}

        {/* Match — escolhe tipo */}
        {matched && !lastSuccess && (
          <div className="bg-white border-2 border-emerald-500 rounded-xl p-4 shadow-lg">
            <div className="text-center mb-3">
              <p className="text-xs uppercase font-bold text-emerald-700">
                ✓ Reconhecida ({(100 - matched.distance * 100).toFixed(0)}% confiança)
              </p>
              <h2 className="text-2xl font-bold text-slate-800">
                Oi, {matched.seller.name.split(' ')[0]}!
              </h2>
              <p className="text-xs text-slate-500">{matched.seller.cargo}</p>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-2">
              {TIPOS.map((t) => {
                const Icon = t.icon;
                const isThis = registering === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => bater(t.key)}
                    disabled={!!registering}
                    className={`${t.color} disabled:opacity-50 text-white font-bold py-4 px-3 rounded-lg flex flex-col items-center gap-1 transition`}
                  >
                    {isThis ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : (
                      <Icon className="w-6 h-6" />
                    )}
                    <span className="text-xs">{t.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              onClick={cancelar}
              disabled={!!registering}
              className="w-full text-xs text-slate-500 hover:text-slate-700 mt-1 flex items-center justify-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              Não sou eu / cancelar
            </button>
          </div>
        )}

        {/* Aguardando — instrução */}
        {!matched && !lastSuccess && ready && sellers.length > 0 && (
          <div className="bg-slate-800 border border-slate-700 text-white rounded-xl p-5 text-center">
            <Camera className="w-10 h-10 mx-auto mb-2 text-emerald-400 animate-pulse" />
            <p className="font-bold text-lg">Aguardando reconhecimento...</p>
            <p className="text-sm text-white/60 mt-1">
              Posicione o rosto na câmera
            </p>
          </div>
        )}

        {/* Sem descriptors */}
        {!loadingDescriptors && sellers.length === 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
            <AlertTriangle className="w-8 h-8 text-amber-600 mx-auto mb-2" />
            <p className="font-bold text-amber-800">
              Nenhuma vendedora cadastrada
            </p>
            <p className="text-sm text-amber-700 mt-1">
              Peça pro admin cadastrar o rosto das funcionárias na retaguarda.
            </p>
          </div>
        )}

        {/* Erro */}
        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{errorMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}
