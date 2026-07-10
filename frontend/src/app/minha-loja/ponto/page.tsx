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

// Anti-falso-positivo + VELOCIDADE (jun/2026 v4):
// Estratégia nova — aceite instantâneo quando o rosto é distinto e perto;
// na zona cinza (0.44–0.52), confirma por VOTAÇÃO multi-frame (NÃO por clique
// manual, que travava a estação). O ratio test (best vs 2º) continua barrando
// sósias — é o que pega o caso Thiago→Elisa (dist=0.474, mas pouco distinto).
const MATCH_AUTO_THRESHOLD = 0.44;    // < 0.44 + distinto = registra na hora
const MATCH_CONFIRM_THRESHOLD = 0.52; // teto absoluto: acima disso NUNCA aceita
const RATIO_THRESHOLD = 0.75;         // best tem que ser bem melhor que o 2º
// Zona 0.44–0.52: aceita automático após N frames seguidos na MESMA pessoa,
// cada um passando o ratio test. ~2 frames ≈ 0,4–0,8s, sem clique manual.
const VOTE_FRAMES = 2;
// 2-STAGE detection (jun/2026 v2): tick muito curto + stage 1 rapido.
// Quando vazio, vira loop a ~100ms. Reconhece pessoa quase instantaneo.
const DETECT_INTERVAL_MS = 50;
// Cooldown da mesma pessoa apos bater. 8s = sai da camera, da espaco proxima.
const COOLDOWN_AFTER_REGISTER_MS = 8_000;
// Tempo que o card "Ola X" fica visivel. Loop continua durante esse tempo —
// se OUTRA pessoa aparecer, derruba o card e bate na hora.
const SUCCESS_DISPLAY_MS = 1_200;
// Compat com codigo que ainda referencia MATCH_THRESHOLD (diagnostico)
const MATCH_THRESHOLD = MATCH_CONFIRM_THRESHOLD;

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
  /** Flag: loop de detecção ativo? Usado pra parar o self-scheduling. */
  const loopActiveRef = useRef<boolean>(false);
  const cooldownRef = useRef<Set<string>>(new Set());
  // Refs espelhando estado pro loop NÃO remontar a cada batida (perf):
  // o tick lê sempre o valor atual via ref, sem entrar nas deps do useEffect.
  const sellersRef = useRef<SellerDescriptors[]>([]);
  const lastSuccessRef = useRef<{ name: string } | null>(null);
  // Votação multi-frame da zona cinza: acumula frames seguidos na mesma pessoa.
  const voteRef = useRef<{ sellerId: string; count: number } | null>(null);

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
    const cacheKey = `ponto_desc_${me.storeId}`;
    // 1) Cache local: mostra na hora (revisita = instantâneo). Revalida em bg.
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const arr = JSON.parse(cached) as SellerDescriptors[];
        if (Array.isArray(arr) && arr.length) {
          setSellers(arr);
          setLoadingDescriptors(false);
        }
      }
    } catch {}
    // 2) Sempre revalida no servidor e atualiza o cache (pega novos enrolls).
    api<SellerDescriptors[]>(`/ponto/face/descriptors/${me.storeId}`)
      .then((arr) => {
        const list = arr || [];
        setSellers(list);
        try { localStorage.setItem(cacheKey, JSON.stringify(list)); } catch {}
      })
      .catch((e) => setErrorMsg(e?.message || 'Falha ao carregar descriptors'))
      .finally(() => setLoadingDescriptors(false));
  }, [me?.storeId]);

  // Espelha estado em refs pro loop de detecção (evita remontar o loop).
  useEffect(() => { sellersRef.current = sellers; }, [sellers]);
  useEffect(() => {
    lastSuccessRef.current = lastSuccess ? { name: lastSuccess.name } : null;
  }, [lastSuccess]);

  // GEOFENCE: mantém a última localização conhecida do aparelho pra mandar na
  // batida. O backend valida contra o raio da loja (se a loja tiver geofence
  // ligado). watchPosition atualiza sozinho — a 1ª leitura pode levar segundos.
  const coordsRef = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => { coordsRef.current = { lat: p.coords.latitude, lng: p.coords.longitude }; },
      () => { /* negado/indisponível — coordsRef fica null; backend decide */ },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  async function baterAuto(match: { seller: SellerDescriptors; distance: number }) {
    if (!me?.storeId) return;
    // Cooldown SÍNCRONO já na entrada: o loop continua detectando a PRÓXIMA
    // pessoa enquanto este POST roda, sem re-bater esta aqui. Zera o voto.
    cooldownRef.current.add(match.seller.id);
    voteRef.current = null;
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
          lat: coordsRef.current?.lat,
          lng: coordsRef.current?.lng,
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
      setTimeout(() => setLastSuccess(null), SUCCESS_DISPLAY_MS);
    } catch (e: any) {
      const msg = e?.message || 'Falha ao registrar';
      // Caso especial: já bateu os 4 do dia
      if (
        msg.toLowerCase().includes('já bateu') ||
        msg.toLowerCase().includes('4 pontos')
      ) {
        setAlreadyDone({ name: match.seller.name });
        cooldownRef.current.add(match.seller.id);
        // Cooldown 90s pra mesma vendedora — ela já bateu, vai pra casa.
        // Antes era 5min. Reduzido pq vendedora pode esquecer e voltar.
        setTimeout(() => {
          cooldownRef.current.delete(match.seller.id);
        }, 90_000);
        // Card "ja bateu" some em 2s (antes 6s). Suficiente pra ler.
        setTimeout(() => setAlreadyDone(null), 2000);
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

  // Loop de detecção — SELF-SCHEDULING (sem overlap).
  // PERF v4: o loop NÃO depende mais de sellers/registering/lastSuccess/confirm
  // (lê tudo via ref) — assim ele NÃO remonta a cada batida. Só (re)inicia
  // quando a câmera fica pronta e os descriptors carregam.
  const hasSellers = sellers.length > 0;
  useEffect(() => {
    if (!ready || !hasSellers) {
      loopActiveRef.current = false;
      return;
    }

    loopActiveRef.current = true;
    let cancelled = false;

    async function tick() {
      if (cancelled || !loopActiveRef.current) return;
      if (!captureRef.current) {
        if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
        return;
      }
      // NÃO pausa em `registering`: o cooldown síncrono (em baterAuto) já evita
      // re-bater a mesma pessoa, então o loop segue detectando a PRÓXIMA.
      const t0 = performance.now();
      try {
        // ── STAGE 1: detecção rápida (~30-80ms) — só "tem rosto?" ──
        const hasFace = await captureRef.current.detectOnly();
        if (cancelled) return;
        if (!hasFace) {
          voteRef.current = null; // rosto saiu → zera votação
          const t1 = performance.now();
          setDiag({ ms: Math.round(t1 - t0), detected: false, bestName: null, bestDist: null, secondName: null, secondDist: null, ambiguous: false, rejected: 'sem_rosto' });
          if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
          return;
        }

        // ── STAGE 2: descriptor completo (~200-400ms) ──
        const desc = await captureRef.current.captureDescriptor();
        if (cancelled) return;
        const t1 = performance.now();
        if (!desc) {
          setDiag({ ms: Math.round(t1 - t0), detected: false, bestName: null, bestDist: null, secondName: null, secondDist: null, ambiguous: false, rejected: 'sem_rosto' });
          if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
          return;
        }
        const best = findBestMatch(desc, sellersRef.current);
        if (!best) {
          voteRef.current = null;
          setDiag({ ms: Math.round(t1 - t0), detected: true, bestName: null, bestDist: null, secondName: null, secondDist: null, ambiguous: false, rejected: 'sem_match' });
          if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
          return;
        }

        // ── DECISÃO: aceita na hora, vota, ou rejeita ──
        let rejected: string | null = null;
        let accept = false;
        if (best.distance >= MATCH_CONFIRM_THRESHOLD) {
          rejected = `dist ${best.distance.toFixed(3)} alta (max ${MATCH_CONFIRM_THRESHOLD})`;
          voteRef.current = null;
        } else if (best.ambiguous) {
          rejected = `ambiguo: ${best.seller.name} (${best.distance.toFixed(3)}) vs ${best.second?.seller.name} (${best.second?.distance.toFixed(3)})`;
          voteRef.current = null;
        } else if (cooldownRef.current.has(best.seller.id)) {
          rejected = 'cooldown';
        } else if (best.distance < MATCH_AUTO_THRESHOLD) {
          // Distinto e perto → aceita IMEDIATO.
          accept = true;
          voteRef.current = null;
        } else {
          // Zona cinza (0.44–0.52), distinto, sem cooldown → VOTAÇÃO multi-frame.
          const v = voteRef.current;
          if (v && v.sellerId === best.seller.id) v.count += 1;
          else voteRef.current = { sellerId: best.seller.id, count: 1 };
          const count = voteRef.current!.count;
          if (count >= VOTE_FRAMES) {
            accept = true;
            voteRef.current = null;
          } else {
            rejected = `votando ${count}/${VOTE_FRAMES}`;
          }
        }

        setDiag({
          ms: Math.round(t1 - t0),
          detected: true,
          bestName: best.seller.name,
          bestDist: best.distance,
          secondName: best.second?.seller.name || null,
          secondDist: best.second?.distance ?? null,
          ambiguous: best.ambiguous,
          rejected: accept ? null : rejected,
        });

        if (accept) {
          // Se outra pessoa estava no card de sucesso, troca na hora (UX fluida).
          const ls = lastSuccessRef.current;
          if (ls && ls.name !== best.seller.name) setLastSuccess(null);
          // NÃO dá await: baterAuto já marcou cooldown síncrono — o loop segue
          // pra detectar a próxima pessoa enquanto o POST roda em paralelo.
          baterAuto(best);
        }
        if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
      } catch (e) {
        if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
      }
    }

    // Pequeno delay inicial pra UI montar antes do primeiro tick
    const startTimer = setTimeout(tick, 100);

    return () => {
      cancelled = true;
      loopActiveRef.current = false;
      clearTimeout(startTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hasSellers]);

  const tipoInfo = lastSuccess ? TIPO_LABELS[lastSuccess.tipo] : null;
  // Calculado fora do JSX pra evitar parser confundir o operador < com tag JSX
  const bestIsOk = diag.bestDist !== null && diag.bestDist < MATCH_THRESHOLD;

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
              <div className={bestIsOk ? 'text-emerald-400' : 'text-amber-400'}>
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
              {lastSuccess.at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        )}

        {/* Erro */}
        {errorMsg && (
          <div className="bg-rose-100 border-2 border-rose-300 text-rose-800 rounded-xl p-4 text-center">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2" />
            <p className="font-bold">{errorMsg}</p>
          </div>
        )}

        {/* Loading descriptors */}
        {loadingDescriptors && (
          <div className="text-center text-white/60 text-sm">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
            Carregando funcionárias...
          </div>
        )}

        {/* Vazio */}
        {!loadingDescriptors && sellers.length === 0 && ready && (
          <div className="bg-amber-100 border-2 border-amber-300 text-amber-800 rounded-xl p-4 text-center">
            <p className="font-bold">Nenhuma funcionária cadastrada com biometria</p>
            <p className="text-sm mt-1">Acesse Retaguarda - RH - Face Enroll</p>
          </div>
        )}
      </div>
    </div>
  );
}
