'use client';

/**
 * FaceCapture — componente reutilizável de captura facial.
 *
 * Carrega face-api.js via CDN (~7MB modelos) e fornece:
 *  - getVideoElement(): expõe o <video> pra detecção contínua
 *  - captureDescriptor(): captura 1 frame, detecta face, retorna descriptor (128 floats)
 *  - captureSnapshot(): snapshot JPEG base64 (pra audit)
 *  - stop(): para a câmera
 *
 * Props:
 *  - onReady(modelsLoaded, faceapi): callback após carregar modelos
 *  - onError(err): falha
 *  - mirrored?: bool (default true — selfie-mirror)
 *  - autoStart?: bool (default true)
 *
 * Modelos CDN: cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights/
 * Pesos: tiny_face_detector + face_landmark_68 + face_recognition
 */

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { Camera, Loader2, AlertTriangle } from 'lucide-react';

const FACE_API_CDN = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
// Modelos hospedados LOCALMENTE em /public/face-models/ (jun/2026).
// Antes vinha de CDN jsdelivr (jsdelivr.net/gh/...) — eliminamos dependencia
// externa pra evitar lentidao quando jsdelivr esta degradado ou bloqueado.
// Vercel serve /public direto, latencia minima.
const MODELS_URL = '/face-models';

declare global {
  interface Window {
    faceapi: any;
  }
}

let scriptLoadingPromise: Promise<void> | null = null;
let modelsLoadingPromise: Promise<void> | null = null;

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
    await Promise.all([
      f.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
      f.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
      f.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
    ]);
  })();
  return modelsLoadingPromise;
}

export type FaceCaptureHandle = {
  captureDescriptor: () => Promise<number[] | null>;
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
  const [statusMsg, setStatusMsg] = useState('Carregando modelo de reconhecimento...');

  useEffect(() => {
    if (!autoStart) return;
    let cancelled = false;

    (async () => {
      try {
        setStatusMsg('Baixando engine facial (~7MB, 1ª vez)...');
        await loadFaceApiScript();
        if (cancelled) return;

        setStatusMsg('Carregando pesos do modelo...');
        await loadModels();
        if (cancelled) return;

        setStatusMsg('Solicitando acesso à câmera...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        });
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
      // Otimizado pra PDV (jun/2026): inputSize=320 (3x mais rapido que default 416)
      // + scoreThreshold=0.4 (aceita rostos com qualidade media — luz variavel).
      const detectorOpts = new f.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.4,
      });
      const result = await f
        .detectSingleFace(videoRef.current, detectorOpts)
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!result?.descriptor) return null;
      return Array.from(result.descriptor as Float32Array);
    },
    captureSnapshot() {
      if (!videoRef.current) return null;
      const v = videoRef.current;
      const c = document.createElement('canvas');
      c.width = v.videoWidth || 640;
      c.height = v.videoHeight || 480;
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
