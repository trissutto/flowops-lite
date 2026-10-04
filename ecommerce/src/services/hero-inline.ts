import 'server-only';

/**
 * ⚠️ O `sharp` NÃO É IMPORTADO NO TOPO — e não é detalhe (04/10/2026).
 *
 * Este arquivo entra no layout público (via `services/banners`). Com
 * `import sharp from 'sharp'` aqui em cima, se o binário nativo não carregar
 * na função da Vercel o módulo inteiro falha ao subir e TODA página
 * renderizada sob demanda responde 500 — ficha do produto, /lojas, /busca —
 * enquanto as pré-renderizadas no build (onde o binário existe) seguem 200.
 *
 * Foi exatamente o que aconteceu ao subir o sharp de 0.34 pra 0.35: 9 minutos
 * com a página de destino dos anúncios fora do ar, e a build local (Windows)
 * servindo tudo normalmente. Reproduzido isolado num deploy de preview: só o
 * sharp 0.35 quebra; o Next novo sozinho passa.
 *
 * Carregado sob demanda e dentro do try, a pior falha possível do sharp custa
 * a variante embutida do hero (o `next/image` assume) — nunca o site.
 * Subir o sharp de versão: SEMPRE conferir a ficha do produto no deploy de
 * PREVIEW antes do merge.
 */

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

    const { default: sharp } = await import('sharp');
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
