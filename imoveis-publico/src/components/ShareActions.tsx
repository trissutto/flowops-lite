'use client';

import { useState } from 'react';
import { Check, Clipboard, Download, Images } from 'lucide-react';

export function ShareActions({ publicId, summary }: { publicId: string; summary: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const link = window.location.href;
    await navigator.clipboard.writeText(`${summary}\n\nFicha completa: ${link}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="share-actions">
      <a className="button primary" href={`/api/ficha/${encodeURIComponent(publicId)}/pdf`}><Download size={18} />Baixar ficha em PDF</a>
      <a className="button secondary" href={`/api/ficha/${encodeURIComponent(publicId)}/fotos`}><Images size={18} />Baixar todas as fotos</a>
      <button className="button secondary" onClick={copy}>{copied ? <Check size={18} /> : <Clipboard size={18} />}{copied ? 'Resumo copiado' : 'Copiar para WhatsApp'}</button>
    </div>
  );
}
