'use client';

/**
 * /minha-loja/ponto — Bater ponto eletrônico (modo AUTOMÁTICO).
 *
 * Fluxo:
 *  1. Carrega face-api.js + descriptors das vendedoras da loja
 *  2. Camera ativa em loop: a cada 1.2s detecta rosto e compara
 *  3. Match (dist < 0.5) → backend resolve qual tipo bater (auto):
 *       - 1ª do dia: entrada
 *       - 2ª: saída almoço
 *       - 3ª: volta almoço
 *       - 4ª: saída
 *  4. Tela mostra "✓ Olá Thiago, Entrada Registrada"
 *  5. Cooldown 60s por vendedora pra não bater igual em sequência
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Camera, CheckCircle2, History, Loader2, AlertTriangle, PartyPopper,
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

// Nivel 1+2 (jun/2026): otimizado pra velocidade e robustez no PDV.
const MATCH_THRESHOLD = 0.55; // antes 0.5 (muito restritivo, gerava falso negativo)
const RATIO_THRESHOLD = 0.85; // best/secondBest — rejeita se ambiguo (2 vendedoras parecidas)
const DETECT_INTERVAL_MS = 500; // antes 1200ms — quase tempo real
const COOLDOWN_AFTER_REGISTER_MS = 60_000; // 60s sem matchar o mesmo seller

const TIPO_LABELS: Record<string, { texto: string; cor: string; emoji: string }> = {
  entrada:      { texto: 'Entrada Registrada',           cor: 'bg-emerald-500', emoji: '🟢' },
  saida_almoco: { texto: 'Saída para almoço Registrada', cor: 'bg-amber-500',   emoji: '🍽️' },
  volta_almoco: { texto: 'Volta do almoço Registrada',   cor: 'bg-amber-600',   emoji: '☕' },
  saida:        { texto: 'Saída Registrada',             cor: 'bg-rose-500',    emoji: '🔴' },
};

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Calcula o CENTROIDE (média) dos N descriptors de uma vendedora.
 *  Mais robusto a variacao de angulo/luz do que comparar com cada um separado. */
function centroid(descriptors: number[][]): number[] {
  if (!descriptors.length) return [];
  const dim = descriptors[0].length;
  const out = new Array(dim).fill(0);
  for (const d of descriptors) {
    for (let i = 0; i < dim; i++) out[i] += d[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= descriptors.length;
  return out;
}

/** Match com centroide + ratio test (Lowe's ratio).
 *  Calcula distancia DO descriptor capturado ate o centroide de CADA vendedora.
 *  Aceita o melhor SE: distancia < threshold E best/secondBest < ratio. */
function findBestMatch(
  descriptor: number[],
  sellers: SellerDescriptors[],
): { seller: SellerDescriptors; distance: number; ambiguous: boolean; second?: { seller: SellerDescriptors; distance: number } | null } | null {
  const matches: Array<{ seller: SellerDescriptors; distance: number }> = [];
  for (const s of sellers) {
    if (!s.descriptors?.length) continue;
    // Centroide (cached no proprio objeto pra nao recalcular a cada frame)
    if (!(s as any)._centroid) (s as any)._centroid = centroid(s.descriptors);
    const dist = euclidean(descriptor, (s as any)._centroid);
    matches.push({ seller: s, distance: dist });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.distance - b.distance);
  const best = matches[0];
  const second = matches[1] || null;
  // Ratio test: se a 2a melhor distancia é proxima da 1a, é ambiguo
  const ambiguous = !!(second && best.distance / second.distance > RATIO_THRESHOLD);
  return { ...best, ambiguous, second };
}

export default function PontoPage() {
  const captureRef = useRef<FaceCaptureHandle>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownRef = useRef<Set<string>>(new Set());

  const [me, setMe] = useState<Me | null>(null);
  const [sellers, setSellers] = useState<SellerDescriptors[]>([]);
  const [registering, setRegistering] = useState(false);
  const [lastSuccess, setLastSuccess] = useState<{
    name: string;
    tipo: string;
    at: Date;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState<{ name: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadingDescriptors, setLoadingDescriptors] = useState(true);
  // PAINEL DIAGNOSTICO (jun/2026) — pra debugar lentidao/divergencia
  const [diag, setDiag] = useState<{
    ms: number;
    detected: boolean;
    bestName: string | null;
    bestDist: number | null;
    secondName: string | null;
    secondDist: number | null;
    ambiguous: boolean;
    rejected: string | null; // motivo se nao bateu
  }>({ ms: 0, detected: false, bestName: null, bestDist: null, secondName: null, secondDist: null, ambiguous: false, rejected: null });

  useEffect(() => {
    api<Me>('/auth/me')
      .then((m) => setMe(m))
      .catch((e) => setErrorMsg(e?.message || 'Falha ao carregar usuário'));
  }, []);

  useEffect(() => {
    if (!me?.storeId) return;
    setLoadingDescriptors(true);
    api<SellerDescriptors[]>(`/ponto/face/descriptors/${me.storeId}`)
      .then((arr) => setSellers(arr || []))
      .catch((e) => setErrorMsg(e?.message || 'Falha ao carregar descriptors'))
      .finally(() => setLoadingDescriptors(false));
  }, [me?.storeId]);

  async function baterAuto(match: { seller: SellerDescriptors; distance: number }) {
    if (!me?.storeId) return;
    setRegistering(true);
    setErrorMsg(null);
    try {
      const snapshot = captureRef.current?.captureSnapshot() || undefined;
      const confidence = 1 - match.distance;
      const r = await api<{ ok: boolean; tipo: string }>('/ponto/registrar', {
        method: 'POST',
        body: JSON.stringify({
          sellerId: match.seller.id,
          storeId: me.storeId,
          tipo: 'auto',
          source: 'face_pdv',
          faceConfidence: confidence,
          snapshot,
        }),
      });
      setLastSuccess({
        name: match.seller.name,
        tipo: r.tipo,
        at: new Date(),
      });
      // Cooldown: evita re-bater o mesmo seller logo em seguida
      cooldownRef.current.add(match.seller.id);
      setTimeout(() => {
        cooldownRef.current.delete(match.seller.id);
      }, COOLDOWN_AFTER_REGISTER_MS);

      // Volta ao "aguardando" depois de 5s
      setTimeout(() => setLastSuccess(null), 5000);
    } catch (e: any) {
      const msg = e?.message || 'Falha ao registrar';
      // Caso especial: já bateu os 4 do dia
      if (
        msg.toLowerCase().includes('já bateu') ||
        msg.toLowerCase().includes('4 pontos')
      ) {
        setAlreadyDone({ name: match.seller.name });
        cooldownRef.current.add(match.seller.id);
        setTimeout(() => {
          cooldownRef.current.delete(match.seller.id);
        }, 5 * 60_000); // 5 min cooldown
        setTimeout(() => setAlreadyDone(null), 6000);
      } else {
        setErrorMsg(`${match.seller.name.split(' ')[0]}: ${msg}`);
        cooldownRef.current.add(match.seller.id);
        setTimeout(() => {
          cooldownRef.current.delete(match.seller.id);
        }, 15_000);
        setTimeout(() => setErrorMsg(null), 5000);
      }
    } finally {
      setRegistering(false);
    }
  }

  // Loop de detecção
  useEffect(() => {
    if (!ready || sellers.length === 0 || registering || lastSuccess || alreadyDone) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(async () => {
      if (!captureRef.current || registering) return;
      const t0 = performance.now();
      try {
        const desc = await captureRef.current.captureDescriptor();
        const t1 = performance.now();
        if (!desc) {
          setDiag({ ms: Math.round(t1 - t0), detected: false, bestName: null, bestDist: null, secondName: null, secondDist: null, ambiguous: false, rejected: 'sem_rosto' });
          return;
        }
        const best = findBestMatch(desc, sellers);
        if (!best) {
          setDiag({ ms: Math.round(t1 - t0), detected: true, bestName: null, bestDist: null, secondName: null, secondDist: null, ambiguous: false, rejected: 'sem_match' });
          return;
        }
        // Atualiza painel de diagnostico
        let rejected: string | null = null;
        if (best.distance >= MATCH_THRESHOLD) rejected = `distancia ${best.distance.toFixed(3)} >= ${MATCH_THRESHOLD}`;
        else if (best.ambiguous) rejected = `ambiguo (best/second=${(best.distance / (best.second?.distance || 1)).toFixed(2)})`;
        else if (cooldownRef.current.has(best.seller.id)) rejected = 'cooldown';
        setDiag({
          ms: Math.round(t1 - t0),
          detected: true,
          bestName: best.seller.name,
          bestDist: best.distance,
          secondName: best.second?.seller.name || null,
          secondDist: best.second?.distance ?? null,
          ambiguous: best.ambiguous,
          rejected,
        });
        if (!rejected) await baterAuto(best);
      } catch (e) {
        // ignora frame
      }
    }, DETECT_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sellers, registering, lastSuccess, alreadyDone]);

  const tipoInfo = lastSuccess ? TIPO_LABELS[lastSuccess.tipo] : null;

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

        {/* PAINEL DIAGNOSTICO — mostra status de cada frame.
            Pra esconder: adicionar ?debug=0 na URL. */}
        {ready && typeof window !== 'undefined' && !window.location.search.includes('debug=0') && (
          <div className="bg-slate-900 text-white rounded-xl p-3 text-[11px] font-mono space-y-1 shadow">
            <div className="flex items-center justify-between border-b border-slate-700 pb-1 mb-1">
              <span className="text-emerald-400 font-bold">⚡ DIAG</span>
              <span className="opacity-60">{diag.ms}ms · {sellers.length} vend cadastradas</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <div>Rosto detectado:</div>
              <div className={diag.detected ? 'text-emerald-400' : 'text-rose-400'}>
                {diag.detected ? 'SIM' : 'NÃO'}
              </div>
              <div>Melhor match:</div>
              <div className={diag.bestDist !== null && diag.bestDist < MATCH_THRESHOLD ? 'text-emerald-400' : 'text-amber-400'}>
                {diag.bestName || '—'} {diag.bestDist !== null && `(${diag.bestDist.toFixed(3)})`}
              </div>
              <div>2ª melhor:</div>
              <div className="text-slate-400">
                {diag.secondName || '—'} {diag.secondDist !== null && `(${diag.secondDist.toFixed(3)})`}
              </div>
              <div>Threshold:</div>
              <div className="text-slate-400">{MATCH_THRESHOLD} · ratio {RATIO_THRESHOLD}</div>
              <div>Ambíguo:</div>
              <div className={diag.ambiguous ? 'text-rose-400' : 'text-emerald-400'}>
                {diag.ambiguous ? 'SIM (rejeitando)' : 'não'}
              </div>
              <div>Status:</div>
              <div className={diag.rejected ? 'text-rose-400' : 'text-emerald-400 font-bold'}>
                {diag.rejected || 'OK → registrando'}
              </div>
            </div>
          </div>
        )}

        {/* Já bateu os 4 do dia */}
        {alreadyDone && (
          <div className="bg-indigo-600 text-white rounded-xl p-6 text-center shadow-lg animate-in fade-in zoom-in">
            <PartyPopper className="w-14 h-14 mx-auto mb-3" />
            <p className="text-3xl font-bold">
              Olá, {alreadyDone.name.split(' ')[0]}
            </p>
            <p className="text-xl font-bold mt-2 opacity-95">
              Você já bateu todos os pontos hoje! 🎉
            </p>
            <p className="text-sm opacity-80 mt-3 italic">
              Boa noite e até amanhã ✨
            </p>
          </div>
        )}

        {/* Sucesso */}
        {lastSuccess && tipoInfo && !alreadyDone && (
          <div className={`${tipoInfo.cor} text-white rounded-xl p-6 text-center shadow-lg animate-in fade-in zoom-in`}>
            <CheckCircle2 className="w-14 h-14 mx-auto mb-3" />
            <p className="text-3xl font-bold">
              Olá, {lastSuccess.name.split(' ')[0]}
            </p>
            <p className="text-xl font-bold mt-2 opacity-95">
              {tipoInfo.emoji} {tipoInfo.texto}
            </p>
            <p className="text-sm opacity-80 mt-2">
              {lastSuccess.at.toLocaleTimeString('pt-BR')}
            </p>
            <p className="text-xs opacity-70 mt-3 italic">
              Pode sair da câmera, ponto registrado ✓
            </p>
          </div>
        )}

        {/* Registrando */}
        {registering && !lastSuccess && !alreadyDone && (
          <div className="bg-emerald-600 text-white rounded-xl p-5 text-center shadow-lg">
            <Loader2 className="w-10 h-10 mx-auto animate-spin mb-2" />
            <p className="text-lg font-bold">Registrando...</p>
          </div>
        )}

        {/* Aguardando */}
        {!registering && !lastSuccess && !alreadyDone && ready && sellers.length > 0 && (
          <div className="bg-slate-800 border border-slate-700 text-white rounded-xl p-6 text-center">
            <Camera className="w-12 h-12 mx-auto mb-2 text-emerald-400 animate-pulse" />
            <p className="font-bold text-xl">Posicione o rosto na câmera</p>
            <p className="text-sm text-white/60 mt-1">
              Reconhecimento automático em segundos
            </p>
          </div>
        )}

        {/* Sem cadastradas */}
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
