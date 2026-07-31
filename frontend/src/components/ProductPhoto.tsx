'use client';
import { overlayClose } from '@/lib/overlayClose';

/**
 * <ProductPhoto> — exibe foto do produto (por REF, opcionalmente por COR).
 *
 * Uso simples (somente exibição):
 *   <ProductPhoto ref="7031" cor="PRETO" size={64} />
 *
 * Uso com upload (admin):
 *   <ProductPhoto ref="7031" cor="PRETO" size={120} editable />
 *
 * Quando editable=true, mostra botão "📷 Adicionar foto" se não tem,
 * ou hover overlay com "Trocar foto" / "Remover" se já tem.
 */

import { useEffect, useRef, useState } from 'react';
import { Camera, Trash2, Loader2, ImageOff } from 'lucide-react';
import { api } from '@/lib/api';

type Photo = {
  id: string;
  ref: string;
  cor: string | null;
  url: string;
};

type Props = {
  refSku?: string;          // REF do produto (renomeado de "ref" — palavra reservada do React)
  cor?: string;
  size?: number;            // px
  editable?: boolean;
  className?: string;
  onChange?: (photo: Photo | null) => void;
};

// Cache simples em memória pra evitar refetch da mesma foto
const photoCache = new Map<string, Photo | null>();
const subscribers = new Map<string, Set<(p: Photo | null) => void>>();

function cacheKey(ref: string, cor?: string): string {
  return `${ref}|${cor || ''}`;
}

function notifySubscribers(key: string, photo: Photo | null) {
  subscribers.get(key)?.forEach((cb) => cb(photo));
}

export default function ProductPhoto({
  refSku,
  cor,
  size = 64,
  editable = false,
  className = '',
  onChange,
}: Props) {
  const refUp = (refSku || '').trim().toUpperCase();
  const corUp = (cor || '').trim().toUpperCase() || undefined;
  const key = cacheKey(refUp, corUp);

  const [photo, setPhoto] = useState<Photo | null>(photoCache.get(key) ?? null);
  const [loading, setLoading] = useState(!photoCache.has(key));
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!refUp) {
      setLoading(false);
      return;
    }
    // Inscreve nesta chave pra receber updates de outros componentes
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    const cb = (p: Photo | null) => setPhoto(p);
    subscribers.get(key)!.add(cb);

    if (photoCache.has(key)) {
      setPhoto(photoCache.get(key) ?? null);
      setLoading(false);
    } else {
      setLoading(true);
      const params = new URLSearchParams({ ref: refUp });
      if (corUp) params.set('cor', corUp);
      api<Photo | null>(`/product-photos?${params}`)
        .then((p) => {
          photoCache.set(key, p);
          setPhoto(p);
        })
        .catch(() => {
          photoCache.set(key, null);
          setPhoto(null);
        })
        .finally(() => setLoading(false));
    }

    return () => {
      subscribers.get(key)?.delete(cb);
    };
  }, [refUp, corUp, key]);

  const handleFile = async (file: File) => {
    if (!refUp) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('ref', refUp);
      if (corUp) form.append('cor', corUp);
      const r = await api<Photo>(`/product-photos/upload`, {
        method: 'POST',
        body: form as any,
        headers: {} as any, // remove Content-Type pra browser setar multipart boundary
      });
      photoCache.set(key, r);
      notifySubscribers(key, r);
      onChange?.(r);
    } catch (e: any) {
      alert('Erro ao enviar foto: ' + (e?.message || ''));
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    if (!photo) return;
    if (!confirm('Remover foto?')) return;
    setUploading(true);
    try {
      await api(`/product-photos/${photo.id}`, { method: 'DELETE' });
      photoCache.set(key, null);
      notifySubscribers(key, null);
      onChange?.(null);
    } catch (e: any) {
      alert('Erro: ' + (e?.message || ''));
    } finally {
      setUploading(false);
    }
  };

  const dimStyle = { width: size, height: size };

  if (!refUp) {
    return (
      <div
        style={dimStyle}
        className={`bg-slate-100 rounded flex items-center justify-center ${className}`}
      >
        <ImageOff className="w-4 h-4 text-slate-300" />
      </div>
    );
  }

  if (loading) {
    return (
      <div
        style={dimStyle}
        className={`bg-slate-50 rounded flex items-center justify-center ${className}`}
      >
        <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
      </div>
    );
  }

  // Sem foto + não editável → placeholder simples
  if (!photo && !editable) {
    return (
      <div
        style={dimStyle}
        className={`bg-slate-100 rounded flex items-center justify-center ${className}`}
      >
        <ImageOff className="w-4 h-4 text-slate-300" />
      </div>
    );
  }

  // Sem foto + editável → botão de upload
  if (!photo && editable) {
    return (
      <>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={dimStyle}
          className={`bg-slate-50 border-2 border-dashed border-slate-300 rounded flex flex-col items-center justify-center hover:border-violet-400 hover:bg-violet-50 transition disabled:opacity-40 ${className}`}
        >
          {uploading ? (
            <Loader2 className="w-5 h-5 animate-spin text-violet-600" />
          ) : (
            <>
              <Camera className="w-5 h-5 text-slate-400" />
              <span className="text-[9px] text-slate-500 mt-0.5">Foto</span>
            </>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </>
    );
  }

  // Tem foto
  return (
    <>
      <div className={`relative group ${className}`} style={dimStyle}>
        <img
          src={photo!.url}
          alt={`${refUp} ${corUp || ''}`}
          className="w-full h-full object-cover rounded cursor-pointer"
          onClick={() => setLightbox(true)}
        />
        {editable && (
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition rounded flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              disabled={uploading}
              title="Trocar foto"
              className="p-1.5 bg-white rounded text-violet-700 hover:bg-violet-50"
            >
              <Camera className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleRemove();
              }}
              disabled={uploading}
              title="Remover foto"
              className="p-1.5 bg-white rounded text-rose-600 hover:bg-rose-50"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 bg-black/40 rounded flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-white" />
          </div>
        )}
        {editable && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        )}
      </div>

      {/* Lightbox */}
      {lightbox && photo && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 cursor-zoom-out"
          {...overlayClose(() => setLightbox(false))}
        >
          <img
            src={photo.url}
            alt=""
            className="max-w-full max-h-full object-contain rounded"
          />
        </div>
      )}
    </>
  );
}
