'use client';

/**
 * /minha-loja/ponto — Bater ponto eletrônico.
 *
 * Fluxo (11/08/26 — regra do dono: escolher o NOME antes de ligar a câmera):
 *  1. Carrega descriptors das vendedoras da loja e lista os NOMES
 *  2. Funcionária toca no próprio nome → só então a câmera monta/liga
 *  3. Loop detecta o rosto e SÓ aceita se for da pessoa escolhida — o
 *     matching continua 1:N com ratio test anti-sósia, então rosto de
 *     outra funcionária é recusado com aviso na tela
 *  4. Backend resolve qual tipo bater (auto): 1ª do dia = entrada,
 *     depois saída almoço → volta almoço → saída
 *  5. Bateu (ou erro/60s parado) → volta pra lista e a câmera desliga
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
// Confirmação exclusiva antes de liberar a seleção para a próxima pessoa.
const SUCCESS_DISPLAY_MS = 2_000;
// Compat com codigo que ainda referencia MATCH_THRESHOLD (diagnostico)
const MATCH_THRESHOLD = MATCH_CONFIRM_THRESHOLD;
// Escolheu o nome e não bateu em 60s → volta pra lista (câmera desliga).
const SELECT_TIMEOUT_MS = 60_000;

const TIPO_LABELS: Record<string, { texto: string; cor: string; emoji: string }> = {
  entrada:      { texto: 'Entrada Registrada',           cor: 'bg-emerald-500', emoji: '🟢' },
  saida_almoco: { texto: 'Saída para almoço Registrada', cor: 'bg-amber-500',   emoji: '🍽️' },
  volta_almoco: { texto: 'Volta do almoço Registrada',   cor: 'bg-amber-600',   emoji: '☕' },
  saida:        { texto: 'Saída Registrada',             cor: 'bg-rose-500',    emoji: '🔴' },
};

function mensagemConfirmacao(tipo: string, nome: string): string {
  const primeiroNome = nome.trim().split(/\s+/)[0] || nome;
  switch (tipo) {
    case 'entrada':
      return `Bom dia, ${primeiroNome}. Entrada registrada.`;
    case 'saida_almoco':
      return `Saída de almoço registrada, ${primeiroNome}.`;
    case 'volta_almoco':
      return `Retorno do almoço registrado, ${primeiroNome}.`;
    case 'saida':
      return `Saída registrada, ${primeiroNome}.`;
    default:
      return `Ponto registrado, ${primeiroNome}.`;
  }
}

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
  // Nome escolhido ANTES da captura (dono 11/08): a câmera só monta depois
  // da escolha e o match só vale pra essa pessoa.
  const [selected, setSelected] = useState<SellerDescriptors | null>(null);
  const selectedRef = useRef<SellerDescriptors | null>(null);
  // Rosto reconhecido ≠ nome escolhido → aviso na tela (ref evita setState
  // repetido a cada frame do loop).
  const [wrongFace, setWrongFace] = useState<string | null>(null);
  const wrongFaceRef = useRef<string | null>(null);
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
  useEffect(() => {
    selectedRef.current = selected;
    if (!selected) {
      // Voltou pra lista: FaceCapture desmonta (câmera desliga) → ready
      // precisa voltar pro estado inicial senão o loop re-liga sem câmera.
      setReady(false);
      voteRef.current = null;
      wrongFaceRef.current = null;
      setWrongFace(null);
    }
  }, [selected]);

  // Totem não pode ficar preso numa escolha: 60s sem bater → volta pra lista.
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => setSelected(null), SELECT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [selected]);

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
      // Bateu → câmera desliga; a lista só reaparece após a confirmação.
      setSelected(null);
      // Cooldown: evita re-bater o mesmo seller logo em seguida
      cooldownRef.current.add(match.seller.id);
      setTimeout(() => {
        cooldownRef.current.delete(match.seller.id);
      }, COOLDOWN_AFTER_REGISTER_MS);

      // Libera a seleção da próxima colaboradora após a confirmação.
      setTimeout(() => setLastSuccess(null), SUCCESS_DISPLAY_MS);
    } catch (e: any) {
      const msg = e?.message || 'Falha ao registrar';
      // Caso especial: já bateu os 4 do dia
      if (
        msg.toLowerCase().includes('já bateu') ||
        msg.toLowerCase().includes('4 pontos')
      ) {
        setAlreadyDone({ name: match.seller.name });
        setSelected(null);
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
        setSelected(null);
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
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    // Sem nome escolhido não há captura: a câmera nem está montada.
    if (!ready || !hasSellers || !selectedId) {
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
          if (wrongFaceRef.current) { wrongFaceRef.current = null; setWrongFace(null); }
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

        // Rosto confere com o nome escolhido → derruba o aviso de "outra pessoa"
        if (best.seller.id === selectedRef.current?.id && wrongFaceRef.current) {
          wrongFaceRef.current = null;
          setWrongFace(null);
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
        } else if (selectedRef.current && best.seller.id !== selectedRef.current.id) {
          // Nome escolhido manda: rosto (confiável) de OUTRA funcionária não
          // bate o ponto de quem foi selecionada.
          rejected = `rosto de ${best.seller.name}, esperado ${selectedRef.current.name}`;
          voteRef.current = null;
          if (wrongFaceRef.current !== best.seller.name) {
            wrongFaceRef.current = best.seller.name;
            setWrongFace(best.seller.name);
          }
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
  }, [ready, hasSellers, selectedId]);

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
        {lastSuccess && tipoInfo && !alreadyDone ? (
          /* Confirmação exclusiva: só depois de 2s a lista volta a aparecer. */
          <div className={`${tipoInfo.cor} text-white rounded-xl p-8 text-center shadow-lg animate-in fade-in zoom-in`}>
            <CheckCircle2 className="w-16 h-16 mx-auto mb-4" />
            <p className="text-2xl sm:text-3xl font-bold">
              {mensagemConfirmacao(lastSuccess.tipo, lastSuccess.name)}
            </p>
            <p className="text-base opacity-80 mt-3">
              {lastSuccess.at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        ) : !selected ? (
          /* ── PASSO 1: escolher o nome (câmera DESLIGADA até aqui) ── */
          !loadingDescriptors && sellers.length > 0 && (
            <div className="bg-slate-800 rounded-xl p-4">
              <p className="text-white font-bold text-lg text-center">Quem vai bater o ponto?</p>
              <p className="text-white/50 text-xs text-center mt-0.5 mb-3">
                Toque no seu nome — a câmera liga depois da escolha
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[...sellers]
                  .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
                  .map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelected(s)}
                      className="bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-white rounded-xl p-4 flex items-center gap-3 text-left"
                    >
                      <div className="w-10 h-10 shrink-0 rounded-full bg-[#D4AF37] text-slate-900 font-bold flex items-center justify-center text-lg">
                        {s.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold truncate">{s.name}</div>
                        <div className="text-xs text-white/50">{s.cargo}</div>
                      </div>
                    </button>
                  ))}
              </div>
            </div>
          )
        ) : (
          /* ── PASSO 2: câmera ligada SÓ pra pessoa escolhida ── */
          <>
            <div className="bg-slate-800 rounded-xl p-3 flex items-center gap-3">
              <div className="w-10 h-10 shrink-0 rounded-full bg-[#D4AF37] text-slate-900 font-bold flex items-center justify-center text-lg">
                {selected.name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0 text-white">
                <div className="text-[11px] text-white/50 uppercase">Batendo ponto de</div>
                <div className="font-bold truncate">{selected.name}</div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-xs font-bold text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg px-3 py-2"
              >
                Trocar nome
              </button>
            </div>

            <FaceCapture
              ref={captureRef}
              onReady={() => setReady(true)}
              onError={(err) => setErrorMsg(err)}
              showStatus={false}
            />

            {wrongFace && (
              <div className="bg-amber-100 border-2 border-amber-300 text-amber-900 rounded-xl p-3 text-center">
                <AlertTriangle className="w-5 h-5 mx-auto mb-1" />
                <p className="font-bold text-sm">
                  Esse rosto não parece ser de {selected.name.split(' ')[0]}.
                </p>
                <p className="text-xs mt-0.5">
                  Se você é {wrongFace.split(' ')[0]}, toque em "Trocar nome" e escolha o seu.
                </p>
              </div>
            )}
          </>
        )}

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

        {/* Vazio — sem `ready` na condição: a câmera só monta após escolher
            um nome, então com 0 cadastradas o ready nunca ficaria true */}
        {!loadingDescriptors && sellers.length === 0 && (
          <div className="bg-amber-100 border-2 border-amber-300 text-amber-800 rounded-xl p-4 text-center">
            <p className="font-bold">Nenhuma funcionária cadastrada com biometria</p>
            <p className="text-sm mt-1">Acesse Retaguarda - RH - Face Enroll</p>
          </div>
        )}
      </div>
    </div>
  );
}
