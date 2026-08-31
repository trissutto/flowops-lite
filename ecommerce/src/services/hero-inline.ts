import 'server-only';
import sharp from 'sharp';

const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 5000;

/** Gera a variante AVIF mobile que viaja dentro do HTML crítico. */
export async function gerarHeroMobileInline(url?: string | null): Promise<string | undefined> {
  if (!url || !url.startsWith('https://')) return undefined;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: 3600, tags: ['banners', 'hero-inline'] },
    });
    if (!response.ok) return undefined;

    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_SOURCE_BYTES) return undefined;
    const source = Buffer.from(await response.arrayBuffer());
    if (source.byteLength > MAX_SOURCE_BYTES) return undefined;

    const optimized = await sharp(source)
      .resize({ width: 768, withoutEnlargement: true })
      .avif({ quality: 58, effort: 3 })
      .toBuffer();
    return `data:image/avif;base64,${optimized.toString('base64')}`;
  } catch (error) {
    // O caminho normal pelo next/image continua disponível em qualquer falha.
    console.warn(`[hero-inline] variante embutida indisponível: ${String(error)}`);
    return undefined;
  }
}
