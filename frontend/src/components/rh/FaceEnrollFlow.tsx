'use client';

/**
 * FaceEnrollFlow — captura 3 ângulos do rosto (face-api.js, on-device) e
 * cadastra pra reconhecimento no ponto (POST /ponto/face/enroll/:sellerId).
 *
 * Usado em DOIS lugares (mesmo componente):
 *   - Matriz: /retaguarda/rh/face-enroll/[sellerId]
 *   - Loja:   /minha-loja/rosto/[sellerId]   (gerente enrolla as da loja dela)
 * `backHref`/`doneHref` = pra onde voltar/ir depois. sellerId vem da rota.
 * Só cadastra descriptors (128 nums) + 1 snapshot de audit — nunca a foto crua.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Camera, Loader2, CheckCircle2, AlertTriangle, RotateCcw } from 'lucide-react';
import FaceCapture, { FaceCaptureHandle } from '@/components/rh/FaceCapture';
import { api } from '@/lib/api';

const ANGULOS = [
  { key: 'frente', label: 'Olhe pra frente', tip: 'Centralize o rosto, olhos no meio da câmera' },
  { key: 'esquerda', label: 'Vire levemente pra esquerda', tip: '~30° pro lado esquerdo' },
  { key: 'direita', label: 'Vire levemente pra direita', tip: '~30° pro lado direito' },
];

export default function FaceEnrollFlow({ backHref, doneHref }: { backHref: string; doneHref: string }) {
  const params = useParams();
  const router = useRouter();
  const sellerId = params?.sellerId as string;

  const captureRef = useRef<FaceCaptureHandle>(null);
  const [seller, setSeller] = useState<any>(null);
  const [step, setStep] = useState(0);
  const [descriptors, setDescriptors] = useState<number[][]>([]);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // AUTO-CAPTURA (rápida no celular): sem botão — detecta o rosto e tira sozinho.
  const [auto, setAuto] = useState(true);
  const [running, setRunning] = useState(false);
  const [procurando, setProcurando] = useState(false);
  const busyRef = useRef(false);
  const stableRef = useRef(0);

  useEffect(() => {
    if (!sellerId) return;
    api<any>(`/sellers/${sellerId}/detail`).then((s) => setSeller(s)).catch(() => {});
  }, [sellerId]);

  // Loop da auto-captura: a cada ~350ms confere se tem rosto (detectOnly, rápido).
  // Estável por ~2 leituras → captura o descriptor e avança o ângulo, com vibração.
  // Pausa ~1s entre ângulos pra a pessoa virar. Modelo/ câmera prontos = `ready`.
  useEffect(() => {
    if (!auto || !running || step >= 3 || !ready) { setProcurando(false); return; }
    let alive = true;
    const tick = async () => {
      if (!alive || busyRef.current || !captureRef.current) return;
      const tem = await captureRef.current.detectOnly().catch(() => false);
      if (!alive) return;
      setProcurando(!tem);
      if (!tem) { stableRef.current = 0; return; }
      stableRef.current += 1;
      if (stableRef.current < 2) return;
      busyRef.current = true;
      try {
        const desc = await captureRef.current.captureDescriptor();
        if (desc && alive) {
          if (step === 0) { const snap = captureRef.current.captureSnapshot(); if (snap) setSnapshot(snap); }
          setDescriptors((prev) => [...prev, desc]);
          setStep((s) => s + 1);
          try { (navigator as any).vibrate?.(80); } catch {}
          stableRef.current = 0;
          await new Promise((r) => setTimeout(r, 1000)); // deixa a pessoa virar
        }
      } finally { busyRef.current = false; }
    };
    const id = setInterval(tick, 350);
    return () => { alive = false; clearInterval(id); };
  }, [auto, running, step, ready]);

  async function capturar() {
    setError(null);
    if (!captureRef.current) return;
    setCapturing(true);
    try {
      const desc = await captureRef.current.captureDescriptor();
      if (!desc) { setError('Nenhum rosto detectado. Aproxime-se da câmera e tente novamente.'); return; }
      if (step === 0) { const snap = captureRef.current.captureSnapshot(); if (snap) setSnapshot(snap); }
      setDescriptors((prev) => [...prev, desc]);
      setStep((s) => s + 1);
    } catch (e: any) { setError(e?.message || 'Erro na captura'); }
    finally { setCapturing(false); }
  }

  function reiniciar() { setDescriptors([]); setSnapshot(null); setStep(0); setError(null); }

  async function salvar() {
    if (descriptors.length < 3) { setError('Capture os 3 ângulos antes de salvar.'); return; }
    setSaving(true); setError(null);
    try {
      await api(`/ponto/face/enroll/${sellerId}`, { method: 'POST', body: JSON.stringify({ descriptors, snapshot }) });
      captureRef.current?.stop();
      alert(`✓ Rosto de ${seller?.name} cadastrado!`);
      router.push(doneHref);
    } catch (e: any) { setError(e?.message || 'Falha ao salvar'); }
    finally { setSaving(false); }
  }

  const completo = step >= 3;
  const angulo = ANGULOS[Math.min(step, 2)];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white shadow sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href={backHref} className="p-2 hover:bg-white/10 rounded"><ArrowLeft className="w-5 h-5" /></Link>
          <div>
            <h1 className="text-lg font-bold">Cadastro Facial</h1>
            <p className="text-xs text-white/80">{seller?.name || '...'}</p>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <FaceCapture ref={captureRef} onReady={() => setReady(true)} onError={(err) => setError(err)} />

        <div className="flex items-center justify-center gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`w-3 h-3 rounded-full ${i < descriptors.length ? 'bg-emerald-500' : i === step ? 'bg-amber-400 animate-pulse' : 'bg-slate-300'}`} />
          ))}
        </div>

        {!completo ? (
          <div className="bg-white border border-slate-200 rounded-xl p-4 text-center">
            <p className="text-xs font-bold uppercase text-emerald-700 mb-1">Captura {step + 1} de 3</p>
            <h2 className="text-lg font-bold text-slate-800 mb-1">{angulo.label}</h2>
            <p className="text-sm text-slate-600 mb-3">{angulo.tip}</p>

            {auto ? (
              !running ? (
                <>
                  <button onClick={() => setRunning(true)} disabled={!ready}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold py-3.5 rounded-lg flex items-center justify-center gap-2 text-lg">
                    <Camera className="w-5 h-5" /> {ready ? 'Começar' : 'Ligando câmera…'}
                  </button>
                  <p className="text-xs text-slate-400 mt-2">
                    É automático: segure o celular na frente do rosto e siga as instruções — ele tira sozinho. 💜
                  </p>
                </>
              ) : (
                <div className="w-full bg-emerald-50 border border-emerald-200 text-emerald-800 font-bold py-3.5 rounded-lg flex items-center justify-center gap-2 text-base">
                  {procurando ? (<><Loader2 className="w-5 h-5 animate-spin" /> Procurando seu rosto…</>) : (<>📸 Segura assim…</>)}
                </div>
              )
            ) : (
              <button onClick={capturar} disabled={!ready || capturing}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2">
                {capturing ? (<><Loader2 className="w-5 h-5 animate-spin" /> Capturando...</>) : (<><Camera className="w-5 h-5" /> Capturar</>)}
              </button>
            )}

            <button type="button" onClick={() => { setAuto((a) => !a); setRunning(false); }}
              className="mt-3 text-xs text-slate-400 hover:text-slate-600 underline underline-offset-2">
              {auto ? 'Preferir tirar no botão (manual)' : 'Voltar pro automático'}
            </button>
          </div>
        ) : (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto mb-2" />
            <h2 className="text-lg font-bold text-emerald-800">3 capturas prontas</h2>
            <p className="text-sm text-emerald-700 mb-4">Confira e salve. Depois disso, {seller?.name?.split(' ')[0]} pode bater ponto.</p>
            <div className="flex gap-2">
              <button onClick={reiniciar} disabled={saving} className="flex-1 py-2.5 border border-slate-300 rounded-lg font-bold text-slate-700 hover:bg-slate-50 flex items-center justify-center gap-2">
                <RotateCcw className="w-4 h-4" /> Refazer
              </button>
              <button onClick={salvar} disabled={saving} className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg font-bold flex items-center justify-center gap-2">
                {saving ? (<><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</>) : (<><CheckCircle2 className="w-4 h-4" /> Salvar cadastro</>)}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <p className="font-bold mb-1">🔒 Privacidade</p>
          <p>O reconhecimento roda 100% no aparelho (face-api.js). Salvamos só números matemáticos (128 floats), nunca a foto da câmera. Uma foto de referência fica só pra audit.</p>
        </div>
      </div>
    </div>
  );
}
