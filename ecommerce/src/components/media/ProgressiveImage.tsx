'use client';

import Image, { type ImageProps } from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { observeProgressiveImage } from './progressive-image-observer';

type ProgressiveImageProps = ImageProps & { rootMargin?: string };

/** Não expõe `src` ao navegador até a vitrine se aproximar da tela. */
export function ProgressiveImage({
  rootMargin = '300px 0px',
  priority = false,
  alt,
  ...imageProps
}: ProgressiveImageProps) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(priority);

  useEffect(() => {
    if (visible || priority) return;
    const element = sentinelRef.current;
    if (!element) return;

    return observeProgressiveImage(element, () => setVisible(true), rootMargin);
  }, [priority, rootMargin, visible]);

  return (
    <span ref={sentinelRef} className="absolute inset-0">
      {visible && <Image {...imageProps} alt={alt} priority={priority} />}
    </span>
  );
}
