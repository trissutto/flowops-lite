'use client';

/**
 * /minha-loja/ponto-celular — Bater ponto no CELULAR DA LOJA (modo totem).
 *
 * Mesma engine da tela /minha-loja/ponto do PDV (2-stage detection, centroide,
 * ratio test anti-sósia, votação na zona cinza), adaptada pro celular:
 *  - source 'pwa_selfie' → backend valida IP do WiFi da loja + geofence 30m
 *  - Wake Lock: tela não apaga enquanto o totem está aberto
 *  - Layout mobile-first, cartões grandes, relógio gigante
 *  - Painel de diagnóstico ESCONDIDO por padrão (mostra com ?debug=1)
 *
 * O celular fica logado com a conta da LOJA (mesmo login do PDV). A câmera
 * frontal reconhece a funcionária e bate automático: 1ª do dia = entrada,
 * depois saída almoço → volta almoço → saída.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, CheckCircle2, Loader2, AlertTriangle, PartyPopper,
  MapPin, Wifi, Download, Share,
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

// Mesmos thresholds da tela do PDV (ver /minha-loja/ponto — histórico jun/2026 v4)
const MATCH_AUTO_THRESHOLD = 0.44;
const MATCH_CONFIRM_THRESHOLD = 0.52;
const RATIO_THRESHOLD = 0.75;
const VOTE_FRAMES = 2;
const DETECT_INTERVAL_MS = 50;
const COOLDOWN_AFTER_REGISTER_MS = 8_000;
const SUCCESS_DISPLAY_MS = 1_200;

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

function findBestMatch(
  descriptor: number[],
  sellers: SellerDescriptors[],
): { seller: SellerDescriptors; distance: number; ambiguous: boolean; second?: { seller: SellerDescriptors; distance: number } | null } | null {
  const matches: Array<{ seller: SellerDescriptors; distance: number }> = [];
  for (const s of sellers) {
    if (!s.descriptors?.length) continue;
    if (!(s as any)._centroid) (s as any)._centroid = centroid(s.descriptors);
    const dist = euclidean(descriptor, (s as any)._centroid);
    matches.push({ seller: s, distance: dist });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.distance - b.distance);
  const best = matches[0];
  const second = matches[1] || null;
  const ambiguous = !!(second && best.distance / second.distance > RATIO_THRESHOLD);
  return { ...best, ambiguous, second };
}

export default function PontoCelularPage() {
  const captureRef = useRef<FaceCaptureHandle>(null);
  const loopActiveRef = useRef<boolean>(false);
  const cooldownRef = useRef<Set<string>>(new Set());
  const sellersRef = useRef<SellerDescriptors[]>([]);
  const lastSuccessRef = useRef<{ name: string } | null>(null);
  const voteRef = useRef<{ sellerId: string; count: number } | null>(null);

  const [me, setMe] = useState<Me | null>(null);
  const [sellers, setSellers] = useState<SellerDescriptors[]>([]);
  const [lastSuccess, setLastSuccess] = useState<{ name: string; tipo: string; at: Date } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState<{ name: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadingDescriptors, setLoadingDescriptors] = useState(true);
  const [gpsStatus, setGpsStatus] = useState<'pending' | 'ok' | 'denied'>('pending');
  const [clock, setClock] = useState('');
  // Instalação como app (ícone "Ponto" na tela inicial do celular da loja).
  // Android/Chrome dispara beforeinstallprompt → botão de 1 clique.
  // iPhone não tem esse evento → mostra a instrução do Safari.
  // null = ainda não detectou (não mostra nada até saber onde estamos)
  const [installEvt, setInstallEvt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState<boolean | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [debug, setDebug] = useState(false);
  const [diag, setDiag] = useState<{ ms: number; bestName: string | null; bestDist: number | null; rejected: string | null }>(
    { ms: 0, bestName: null, bestDist: null, rejected: null },
  );

  // Relógio grande do totem (só visual — o timestamp da batida é do SERVIDOR)
  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  // ?debug=1 mostra o painel de diagnóstico (no PDV é o contrário — lá o
  // operador precisa dele; aqui a funcionária não)
  useEffect(() => {
    if (typeof window !== 'undefined') setDebug(window.location.search.includes('debug=1'));
  }, []);

  // Detecta se já roda como app instalado; senão, prepara o caminho de instalar
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const standalone =
      window.matchMedia?.('(display-mode: standalone)')?.matches ||
      (navigator as any).standalone === true;
    setIsStandalone(!!standalone);
    setIsIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    // 1) Evento pode ter disparado ANTES do React montar — o layout guarda
    //    em window.__pontoBip (script inline). Pega o que já chegou.
    const grab = () => {
      const e = (window as any).__pontoBip;
      if (e) setInstallEvt(e);
    };
    grab();
    // 2) E escuta os próximos (CustomEvent do layout + o evento nativo)
    const onPrompt = (e: any) => {
      e.preventDefault(); // segura o prompt pro NOSSO botão disparar
      setInstallEvt(e);
    };
    window.addEventListener('ponto:bip', grab);
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => {
      window.removeEventListener('ponto:bip', grab);
      window.removeEventListener('beforeinstallprompt', onPrompt);
    };
  }, []);

  async function instalarApp() {
    if (!installEvt) return;
    try {
      installEvt.prompt();
      const choice = await installEvt.userChoice;
      if (choice?.outcome === 'accepted') {
        setInstallEvt(null);
        try { (window as any).__pontoBip = null; } catch {}
      }
    } catch {}
  }

  // WAKE LOCK: celular-totem não pode apagar a tela. Reaquire ao voltar
  // do background (o browser solta o lock quando a aba perde visibilidade).
  useEffect(() => {
    let lock: any = null;
    let disposed = false;
    async function acquire() {
      try {
        const wl = (navigator as any).wakeLock;
        if (!wl?.request) return;
        lock = await wl.request('screen');
      } catch {
        // sem suporte/permissão — segue sem lock (usuário ajusta o timeout da tela)
      }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible' && !disposed) acquire();
    }
    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      try { lock?.release?.(); } catch {}
    };
  }, []);

  // PERF celular: /auth/me é um round-trip no Railway ANTES de qualquer coisa
  // (a lista de funcionárias precisa do storeId). Cacheia o "me" no aparelho:
  // reabertura mostra a lista NA HORA (do cache) e revalida por trás.
  useEffect(() => {
    try {
      const cached = localStorage.getItem('ponto_me_cache');
      if (cached) {
        const m = JSON.parse(cached) as Me;
        if (m?.storeId) setMe(m);
      }
    } catch {}
    api<Me>('/auth/me')
      .then((m) => {
        setMe(m);
        try { localStorage.setItem('ponto_me_cache', JSON.stringify(m)); } catch {}
      })
      .catch((e) => setErrorMsg(e?.message || 'Falha ao carregar usuário'));
  }, []);

  useEffect(() => {
    if (!me?.storeId) return;
    const cacheKey = `ponto_desc_${me.storeId}`;
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
    api<SellerDescriptors[]>(`/ponto/face/descriptors/${me.storeId}`)
      .then((arr) => {
        const list = arr || [];
        setSellers(list);
        try { localStorage.setItem(cacheKey, JSON.stringify(list)); } catch {}
      })
      .catch((e) => setErrorMsg(e?.message || 'Falha ao carregar descriptors'))
      .finally(() => setLoadingDescriptors(false));
  }, [me?.storeId]);

  useEffect(() => { sellersRef.current = sellers; }, [sellers]);
  useEffect(() => {
    lastSuccessRef.current = lastSuccess ? { name: lastSuccess.name } : null;
  }, [lastSuccess]);

  // GEOFENCE: GPS do celular (bem mais preciso que o do PC do PDV).
  // Backend valida contra o raio da loja; sem coordenada ele BLOQUEIA
  // (loja com geofence ligado), então mostramos o status na tela.
  const coordsRef = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatus('denied');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        coordsRef.current = { lat: p.coords.latitude, lng: p.coords.longitude };
        setGpsStatus('ok');
      },
      () => setGpsStatus('denied'),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  async function baterAuto(match: { seller: SellerDescriptors; distance: number }) {
    if (!me?.storeId) return;
    cooldownRef.current.add(match.seller.id);
    voteRef.current = null;
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
          source: 'pwa_selfie',
          faceConfidence: confidence,
          snapshot,
          lat: coordsRef.current?.lat,
          lng: coordsRef.current?.lng,
        }),
      });
      setLastSuccess({ name: match.seller.name, tipo: r.tipo, at: new Date() });
      cooldownRef.current.add(match.seller.id);
      setTimeout(() => cooldownRef.current.delete(match.seller.id), COOLDOWN_AFTER_REGISTER_MS);
      setTimeout(() => setLastSuccess(null), SUCCESS_DISPLAY_MS);
    } catch (e: any) {
      const msg = e?.message || 'Falha ao registrar';
      if (msg.toLowerCase().includes('já bateu') || msg.toLowerCase().includes('4 pontos')) {
        setAlreadyDone({ name: match.seller.name });
        cooldownRef.current.add(match.seller.id);
        setTimeout(() => cooldownRef.current.delete(match.seller.id), 90_000);
        setTimeout(() => setAlreadyDone(null), 2000);
      } else {
        setErrorMsg(`${match.seller.name.split(' ')[0]}: ${msg}`);
        cooldownRef.current.add(match.seller.id);
        setTimeout(() => cooldownRef.current.delete(match.seller.id), 15_000);
        setTimeout(() => setErrorMsg(null), 6000);
      }
    }
  }

  // Loop de detecção — idêntico ao do PDV (self-scheduling, lê estado via ref)
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
      const t0 = performance.now();
      try {
        const hasFace = await captureRef.current.detectOnly();
        if (cancelled) return;
        if (!hasFace) {
          voteRef.current = null;
          setDiag({ ms: Math.round(performance.now() - t0), bestName: null, bestDist: null, rejected: 'sem_rosto' });
          if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
          return;
        }
        const desc = await captureRef.current.captureDescriptor();
        if (cancelled) return;
        const t1 = performance.now();
        if (!desc) {
          setDiag({ ms: Math.round(t1 - t0), bestName: null, bestDist: null, rejected: 'sem_rosto' });
          if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
          return;
        }
        const best = findBestMatch(desc, sellersRef.current);
        if (!best) {
          voteRef.current = null;
          setDiag({ ms: Math.round(t1 - t0), bestName: null, bestDist: null, rejected: 'sem_match' });
          if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
          return;
        }

        let rejected: string | null = null;
        let accept = false;
        if (best.distance >= MATCH_CONFIRM_THRESHOLD) {
          rejected = `dist ${best.distance.toFixed(3)} alta`;
          voteRef.current = null;
        } else if (best.ambiguous) {
          rejected = 'ambiguo';
          voteRef.current = null;
        } else if (cooldownRef.current.has(best.seller.id)) {
          rejected = 'cooldown';
        } else if (best.distance < MATCH_AUTO_THRESHOLD) {
          accept = true;
          voteRef.current = null;
        } else {
          const v = voteRef.current;
          if (v && v.sellerId === best.seller.id) v.count += 1;
          else voteRef.current = { sellerId: best.seller.id, count: 1 };
          if (voteRef.current!.count >= VOTE_FRAMES) {
            accept = true;
            voteRef.current = null;
          } else {
            rejected = `votando ${voteRef.current!.count}/${VOTE_FRAMES}`;
          }
        }

        setDiag({
          ms: Math.round(t1 - t0),
          bestName: best.seller.name,
          bestDist: best.distance,
          rejected: accept ? null : rejected,
        });

        if (accept) {
          const ls = lastSuccessRef.current;
          if (ls && ls.name !== best.seller.name) setLastSuccess(null);
          baterAuto(best);
        }
        if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
      } catch {
        if (!cancelled) setTimeout(tick, DETECT_INTERVAL_MS);
      }
    }

    const startTimer = setTimeout(tick, 100);
    return () => {
      cancelled = true;
      loopActiveRef.current = false;
      clearTimeout(startTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hasSellers]);

  const tipoInfo = lastSuccess ? TIPO_LABELS[lastSuccess.tipo] : null;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="bg-slate-800 text-white">
        <div className="px-3 py-2 flex items-center gap-2">
          <Link href="/minha-loja" className="p-2 hover:bg-white/10 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold leading-tight">Ponto — Celular da Loja</h1>
            <p className="text-[11px] text-white/60 truncate">
              {me?.storeName || '...'} · {sellers.length} cadastradas
            </p>
          </div>
          {/* Status GPS/WiFi — se o GPS está negado e a loja tem geofence, a
              batida vai ser bloqueada; melhor a funcionária ver o porquê */}
          <div className="flex items-center gap-1.5">
            <MapPin className={`w-4 h-4 ${gpsStatus === 'ok' ? 'text-emerald-400' : gpsStatus === 'denied' ? 'text-rose-400' : 'text-amber-400 animate-pulse'}`} />
            <Wifi className="w-4 h-4 text-white/50" />
          </div>
        </div>
      </header>

      <div className="flex-1 w-full max-w-md mx-auto p-3 space-y-3">
        {/* Relógio do totem */}
        <div className="text-center text-white">
          <p className="text-5xl font-bold font-mono tracking-tight">{clock}</p>
          <p className="text-xs text-white/50 mt-1">
            Olhe pra câmera — o ponto bate sozinho
          </p>
        </div>

        <FaceCapture
          ref={captureRef}
          onReady={() => setReady(true)}
          onError={(err) => setErrorMsg(err)}
          showStatus={false}
        />

        {/* GPS negado — aviso permanente (geofence vai bloquear) */}
        {gpsStatus === 'denied' && (
          <div className="bg-rose-100 border-2 border-rose-300 text-rose-800 rounded-xl p-3 text-center text-sm">
            <AlertTriangle className="w-5 h-5 mx-auto mb-1" />
            <p className="font-bold">Localização desligada</p>
            <p className="text-xs mt-0.5">
              Ative o GPS e permita a localização pro navegador — sem isso o ponto não registra.
            </p>
          </div>
        )}

        {/* Já bateu os 4 do dia */}
        {alreadyDone && (
          <div className="bg-indigo-600 text-white rounded-xl p-6 text-center shadow-lg animate-in fade-in zoom-in">
            <PartyPopper className="w-14 h-14 mx-auto mb-3" />
            <p className="text-3xl font-bold">Olá, {alreadyDone.name.split(' ')[0]}</p>
            <p className="text-lg font-bold mt-2 opacity-95">
              Você já bateu todos os pontos hoje! 🎉
            </p>
          </div>
        )}

        {/* Sucesso */}
        {lastSuccess && tipoInfo && !alreadyDone && (
          <div className={`${tipoInfo.cor} text-white rounded-xl p-6 text-center shadow-lg animate-in fade-in zoom-in`}>
            <CheckCircle2 className="w-14 h-14 mx-auto mb-3" />
            <p className="text-3xl font-bold">Olá, {lastSuccess.name.split(' ')[0]}</p>
            <p className="text-lg font-bold mt-2 opacity-95">
              {tipoInfo.emoji} {tipoInfo.texto}
            </p>
            <p className="text-sm opacity-80 mt-2">
              {lastSuccess.at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        )}

        {/* Erro (inclui bloqueio de WiFi/geofence vindo do backend) */}
        {errorMsg && (
          <div className="bg-rose-100 border-2 border-rose-300 text-rose-800 rounded-xl p-4 text-center">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2" />
            <p className="font-bold text-sm">{errorMsg}</p>
          </div>
        )}

        {loadingDescriptors && (
          <div className="text-center text-white/60 text-sm">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
            Carregando funcionárias...
          </div>
        )}

        {!loadingDescriptors && sellers.length === 0 && ready && (
          <div className="bg-amber-100 border-2 border-amber-300 text-amber-800 rounded-xl p-4 text-center">
            <p className="font-bold">Nenhuma funcionária cadastrada com biometria</p>
            <p className="text-sm mt-1">Cadastre os rostos em Minha Loja → Rosto</p>
          </div>
        )}

        {/* Instalar como app — cria o ícone "Ponto" na tela inicial.
            O botão aparece SEMPRE que o Chrome oferecer instalação (installEvt),
            tanto pela URL no navegador quanto DENTRO do app Order One —
            se o Ponto já estiver instalado, o Chrome para de oferecer e o
            botão some sozinho. */}
        {installEvt && (
          <button
            onClick={instalarApp}
            className="w-full bg-[#D4AF37] hover:bg-[#B8912B] text-slate-900 font-bold rounded-xl p-4 flex items-center justify-center gap-2 text-base"
          >
            <Download className="w-5 h-5" />
            Instalar app do Ponto neste celular
          </button>
        )}
        {/* iPhone (navegador): não existe evento de instalação — instrução manual */}
        {!installEvt && isIos && isStandalone === false && (
          <div className="bg-slate-800 text-white/80 rounded-xl p-4 text-sm text-center">
            <p className="font-bold text-white mb-1 flex items-center justify-center gap-1.5">
              <Share className="w-4 h-4" /> Criar o ícone "Ponto" neste iPhone
            </p>
            <p>
              Toque em <span className="font-bold">Compartilhar</span> (quadrado com seta)
              e depois em <span className="font-bold">Adicionar à Tela de Início</span>.
            </p>
          </div>
        )}
        {/* Dentro de um app instalado (Order One) sem oferta do Chrome:
            manda abrir no navegador, onde a instalação sempre funciona */}
        {!installEvt && !isIos && isStandalone === true && (
          <button
            onClick={() => { try { window.open(window.location.href, '_blank'); } catch {} }}
            className="w-full bg-slate-800 hover:bg-slate-700 text-white/90 font-bold rounded-xl p-4 flex items-center justify-center gap-2 text-sm"
          >
            <Download className="w-5 h-5 text-[#D4AF37]" />
            Criar o ícone "Ponto" — abrir no navegador pra instalar
          </button>
        )}

        {/* Diagnóstico — só com ?debug=1 */}
        {debug && ready && (
          <div className="bg-slate-950 text-white rounded-xl p-3 text-[11px] font-mono space-y-0.5">
            <div>⚡ {diag.ms}ms · {sellers.length} cadastradas</div>
            <div>match: {diag.bestName || '—'} {diag.bestDist !== null && `(${diag.bestDist.toFixed(3)})`}</div>
            <div>status: {diag.rejected || 'OK → registrando'}</div>
            <div>gps: {gpsStatus} {coordsRef.current ? `(${coordsRef.current.lat.toFixed(5)}, ${coordsRef.current.lng.toFixed(5)})` : ''}</div>
          </div>
        )}
      </div>
    </div>
  );
}
