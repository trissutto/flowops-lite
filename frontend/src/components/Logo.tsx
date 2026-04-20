/**
 * Logo Lurd's Plus Size — usado no header da matriz, filial, login, e cupom.
 *
 * Carrega /lurds-logo.png (arquivo que o CEO sobe em frontend/public/).
 * Se o arquivo não existir, mostra texto estilizado como fallback — não quebra
 * a UI. Altura controlada por prop, cor não aplicável (logo tem cor própria).
 */
'use client';

import { useState } from 'react';

interface LogoProps {
  /** Altura em pixels. Default 28. */
  height?: number;
  /** Classe extra (ex: filtro de cor pra dark/light header). */
  className?: string;
  /** Mostrar subtítulo "Plus Size" abaixo (quando já não vem na imagem). */
  withSubtitle?: boolean;
  /** Alt text */
  alt?: string;
}

export default function Logo({
  height = 28,
  className = '',
  withSubtitle = false,
  alt = "Lurd's Plus Size",
}: LogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    // Fallback clean: só texto simples, sem fonte cursiva feia.
    return (
      <span
        style={{ fontSize: height * 0.7 }}
        className={`font-bold tracking-wider ${className}`}
      >
        LURD&apos;S
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/lurds-logo.png"
      alt={alt}
      style={{ height, width: 'auto' }}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
