'use client';

/**
 * FaceCapture — componente de captura facial otimizado.
 *
 * Otimizações de performance:
 *  - inputSize=224 no TinyFaceDetector (default 416 é 3,5× mais lento)
 *  - Video 320×240 (4× menos pixels que 640×480) — face-api roda no source size
 *  - Warm-up: 1 detecção dummy logo após carregar modelos (cria caches TF.js)
 *  - WebGL backend forçado (CPU é ordem de magnitude mais lento)
 *  - getUserMedia pede explicitamente resolução baixa
 *
 * API:
 *  - captureDescriptor(): detecta 1 rosto + extrai descriptor (128 floats)
 *  - detectOnly(): só detecta presença de rosto (mais rápido — sem descriptor)
 *  - captureSnapshot(): JPEG base64
 *  - stop(): para a câmera
 */

import {
  useEffect, useRef, useState, forwardRef, useImperativeHandle,
} from 'react';
import { Camera, Loader2, AlertTriangle } from 'lucide-react';

const FACE_API_CDN = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
// Pesos hospedados LOCALMENTE no Vercel (/public/face-models/).
// Antes vinha do CDN GitHub — agora vem do mesmo domínio:
//   ✓ 1ª visita: download direto do Vercel CDN
//   ✓ 2ª visita: Service Worker serve do cache → INSTANTÂNEO
const MODELS_URL = '/face-models';

// Resolução do <video> e dos buffers de processamento.
// 320×240 é suficiente pra reconhecimento + 4× mais rápido que 640×480.
const VIDEO_W = 320;
const VIDEO_H = 240;

// 2 inputSizes: rápido pra triagem (frame vazio), preciso pra match.
// 96  = ultra rápido (~20-40ms), só pra dizer "tem rosto sim ou não".
// 192 = OK (~150-250ms), usado quando vai extrair descriptor.
// (Antes era 128/224 — caímos pra 96/192 pra hardware fraco.)
const DETECTOR_INPUT_SIZE_FAST = 96;
const DETECTOR_INPUT_SIZE_FULL = 192;
const DETECTOR_SCORE_THRESHOLD = 0.5;

declare global {
  interface Window {
    faceapi: any;
  }
}

let scriptLoadingPromise: Promise<void> | null = null;
let modelsLoadingPromise: Promise<void> | null = null;
let warmedUp = false;

function loadFaceApiScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.faceapi) return Promise.resolve();
  if (scriptLoadingPromise) return scriptLoadingPromise;
  scriptLoadingPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = FACE_API_CDN;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Falha ao carregar face-api.js'));
    document.head.appendChild(s);
  });
  return scriptLoadingPromise;
}

async function loadModels(): Promise<void> {
  if (modelsLoadingPromise) return modelsLoadingPromise;
  modelsLoadingPromise = (async () => {
    const f = window.faceapi;
    if (!f) throw new Error('face-api.js não está carregado');

    // Força WebGL (CPU é dezenas de vezes mais lento)
    try {
      if (f.tf && typeof f.tf.setBackend === 'function') {
        await f.tf.setBackend('webgl');
        await f.tf.ready();
        const backend = f.tf.getBackend();
        // eslint-disable-next-line no-console
        console.log(`[FaceCapture] TF.js backend ativo: ${backend}`);
        if (backend !== 'webgl') {
          // eslint-disable-next-line no-console
          console.warn(`[FaceCapture] ⚠️ WebGL não disponível — usando "${backend}" (lento). Verifique chrome://gpu`);
        }
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[FaceCapture] falha setBackend: ${e?.message || e}`);
    }

    await Promise.all([
      f.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
      f.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
      f.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
    ]);
  })();
  return modelsLoadingPromise;
}

/**
 * Warm-up: roda 1 detecção em um canvas dummy.
 * O primeiro inference compila kernels WebGL (~1-2s). Sem warm-up, o
 * primeiro frame REAL paga esse custo e parece "travado".
 */
async function warmUp(): Promise<void> {
  if (warmedUp) return;
  try {
    const f = window.faceapi;
    if (!f) return;
    const canvas = document.createElement('canvas');
    canvas.width = DETECTOR_INPUT_SIZE_FULL;
    canvas.height = DETECTOR_INPUT_SIZE_FULL;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#888';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Warm-up das DUAS escalas (fast + full)
    const optsFast = new f.TinyFaceDetectorOptions({
      inputSize: DETECTOR_INPUT_SIZE_FAST,
      scoreThreshold: DETECTOR_SCORE_THRESHOLD,
    });
    const optsFull = new f.TinyFaceDetectorOptions({
      inputSize: DETECTOR_INPUT_SIZE_FULL,
      scoreThreshold: DETECTOR_SCORE_THRESHOLD,
    });
    await f.detectSingleFace(canvas, optsFast);
    await f.detectSingleFace(canvas, optsFull).withFaceLandmarks().withFaceDescriptor();
    warmedUp = true;
  } catch (e) {
    // ignora — primeiro frame real vai pagar o custo, paciência
  }
}

export type FaceCaptureHandle = {
  /** Detecta rosto + extrai descriptor 128-d. Retorna null se sem rosto. */
  captureDescriptor: () => Promise<number[] | null>;
  /** Só detecta presença de rosto (rápido, sem extrair descriptor). */
  detectOnly: () => Promise<boolean>;
  /** Snapshot JPEG base64. */
  captureSnapshot: () => string | null;
  stop: () => void;
  getVideo: () => HTMLVideoElement | null;
};

type Props = {
  onReady?: (faceapi: any) => void;
  onError?: (err: string) => void;
  mirrored?: boolean;
  autoStart?: boolean;
  showStatus?: boolean;
};

const FaceCapture = forwardRef<FaceCaptureHandle, Props>(function FaceCapture(
  { onReady, onError, mirrored = true, autoStart = true, showStatus = true },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [statusMsg, setStatusMsg] = useState('Carregando engine facial...');

  useEffect(() => {
    if (!autoStart) return;
    let cancelled = false;

    (async () => {
      try {
        // 1) Dispara getUserMedia IMEDIATAMENTE em paralelo com tudo.
        // Câmera USB demora 1-3s pra inicializar — não faz sentido esperar
        // os modelos carregarem antes de chamar getUserMedia.
        setStatusMsg('Inicializando câmera + modelos em paralelo...');
        const cameraPromise = navigator.mediaDevices
          .getUserMedia({
            video: {
              width: { ideal: VIDEO_W },
              height: { ideal: VIDEO_H },
              facingMode: 'user',
              frameRate: { ideal: 15 },
            },
            audio: false,
          })
          .catch((e) => {
            throw new Error(`Câmera: ${e?.message || e}`);
          });

        // 2) Em paralelo: carrega face-api script + modelos + warm-up.
        const enginePromise = (async () => {
          await loadFaceApiScript();
          if (cancelled) return;
          await loadModels();
          if (cancelled) return;
          await warmUp();
        })();

        // 3) Aguarda ambos
        const [stream] = await Promise.all([cameraPromise, enginePromise]);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus('ready');
        setStatusMsg('Pronto');
        onReady?.(window.faceapi);
      } catch (e: any) {
        if (cancelled) return;
        const msg = e?.message || String(e);
        setStatus('error');
        setStatusMsg(msg);
        onError?.(msg);
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useImperativeHandle(ref, () => ({
    async captureDescriptor() {
      if (!videoRef.current || !window.faceapi) return null;
      const f = window.faceapi;
      const opts = new f.TinyFaceDetectorOptions({
        inputSize: DETECTOR_INPUT_SIZE_FULL,
        scoreThreshold: DETECTOR_SCORE_THRESHOLD,
      });
      const result = await f
        .detectSingleFace(videoRef.current, opts)
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!result?.descriptor) return null;
      return Array.from(result.descriptor as Float32Array);
    },
    async detectOnly() {
      // ULTRA RÁPIDO: só usa inputSize=128 + sem landmarks + sem descriptor.
      // Tempo típico: 30-80ms (vs 200-400ms do captureDescriptor).
      if (!videoRef.current || !window.faceapi) return false;
      const f = window.faceapi;
      const opts = new f.TinyFaceDetectorOptions({
        inputSize: DETECTOR_INPUT_SIZE_FAST,
        scoreThreshold: DETECTOR_SCORE_THRESHOLD,
      });
      const result = await f.detectSingleFace(videoRef.current, opts);
      return !!result;
    },
    captureSnapshot() {
      if (!videoRef.current) return null;
      const v = videoRef.current;
      const c = document.createElement('canvas');
      c.width = v.videoWidth || VIDEO_W;
      c.height = v.videoHeight || VIDEO_H;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      if (mirrored) {
        ctx.translate(c.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    },
    stop() {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    getVideo() {
      return videoRef.current;
    },
  }));

  return (
    <div className="relative w-full max-w-md mx-auto">
      <div className="aspect-[4/3] bg-slate-900 rounded-xl overflow-hidden relative">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover ${mirrored ? 'scale-x-[-1]' : ''}`}
        />
        {status !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 text-white p-4 text-center">
            {status === 'loading' ? (
              <Loader2 className="w-10 h-10 animate-spin mb-3" />
            ) : (
              <AlertTriangle className="w-10 h-10 text-amber-400 mb-3" />
            )}
            <p className="font-bold mb-1">
              {status === 'loading' ? 'Preparando câmera' : 'Erro'}
            </p>
            <p className="text-xs text-white/70">{statusMsg}</p>
          </div>
        )}
        {status === 'ready' && (
          <div className="absolute top-2 right-2 bg-emerald-500/90 text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1">
            <Camera className="w-3 h-3" />
            AO VIVO
          </div>
        )}
      </div>
      {showStatus && status === 'ready' && (
        <p className="text-xs text-slate-500 text-center mt-2">
          Câmera ativa · reconhecimento facial local (não sai do PC)
        </p>
      )}
    </div>
  );
});

export default FaceCapture;
