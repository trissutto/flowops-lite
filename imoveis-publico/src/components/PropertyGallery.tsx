'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Expand, X } from 'lucide-react';

export type GalleryPhoto = { id: string; url: string; caption: string };

export function PropertyGallery({ photos, title }: { photos: GalleryPhoto[]; title: string }) {
  const [index, setIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  if (!photos.length) return <div className="gallery-empty">Fotos indisponíveis</div>;
  const active = photos[index];
  const change = (direction: number) => setIndex((current) => (current + direction + photos.length) % photos.length);

  return (
    <>
      <div className="gallery">
        <button className="gallery-main" onClick={() => setLightbox(true)} aria-label="Ampliar foto">
          <img src={active.url} alt={active.caption || `${title} — foto ${index + 1}`} />
          <span className="gallery-count">{index + 1} / {photos.length}</span>
          <span className="gallery-expand"><Expand size={18} /> Ampliar</span>
        </button>
        {photos.length > 1 && (
          <>
            <button className="gallery-arrow gallery-prev" onClick={() => change(-1)} aria-label="Foto anterior"><ChevronLeft /></button>
            <button className="gallery-arrow gallery-next" onClick={() => change(1)} aria-label="Próxima foto"><ChevronRight /></button>
            <div className="gallery-thumbs">
              {photos.map((photo, photoIndex) => (
                <button key={photo.id} onClick={() => setIndex(photoIndex)} className={photoIndex === index ? 'active' : ''} aria-label={`Abrir foto ${photoIndex + 1}`}>
                  <img src={photo.url} alt="" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {lightbox && (
        <div className="lightbox" role="dialog" aria-modal="true" onClick={(event) => event.target === event.currentTarget && setLightbox(false)}>
          <button className="lightbox-close" onClick={() => setLightbox(false)} aria-label="Fechar"><X /></button>
          <button className="lightbox-arrow left" onClick={() => change(-1)} aria-label="Foto anterior"><ChevronLeft /></button>
          <img src={active.url} alt={active.caption || title} />
          <button className="lightbox-arrow right" onClick={() => change(1)} aria-label="Próxima foto"><ChevronRight /></button>
          {active.caption && <div className="lightbox-caption">{active.caption}</div>}
        </div>
      )}
    </>
  );
}
