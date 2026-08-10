import { getImageProps } from 'next/image';
import type { Media } from '@/types';

/** Preloads do LCP separados por viewport para nunca baixar as duas artes. */
export function HeroImagePreload({ image, imageMobile }: { image?: Media; imageMobile?: Media }) {
  // Sem arte mobile o próprio <Image priority> do Hero já emite o preload.
  // Este componente existe para o caso <picture>, que o Next não descobre.
  if (!image || !imageMobile) return null;

  const desktop = getImageProps({ src: image.src, alt: '', width: 2400, height: 1350, sizes: '100vw' });
  const mobile = getImageProps({ src: imageMobile.src, alt: '', width: 1080, height: 1350, sizes: '100vw' });

  return (
    <>
      <link
        rel="preload"
        as="image"
        media="(max-width: 1023px)"
        imageSrcSet={mobile.props.srcSet}
        imageSizes={mobile.props.sizes}
        fetchPriority="high"
      />
      <link
        rel="preload"
        as="image"
        media="(min-width: 1024px)"
        imageSrcSet={desktop.props.srcSet}
        imageSizes={desktop.props.sizes}
        fetchPriority="high"
      />
    </>
  );
}
