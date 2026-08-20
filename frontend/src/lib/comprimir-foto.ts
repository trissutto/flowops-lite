/**
 * Comprime a foto NO NAVEGADOR antes do upload.
 *
 * Por que existe: o upload de foto de produto ia pro R2 do jeito que saiu do
 * celular — foto de câmera moderna passa fácil dos 10MB do multer e o backend
 * responde 413 "File too large" (caso real da tela Produto Master, 20/08).
 * E mesmo quando coube, era um arquivo de 8MB indo pro site como capa.
 *
 * Regra: imagem acima do teto (dimensão ou bytes) é redesenhada em canvas com
 * lado maior ≤ 2000px e re-exportada JPEG q0.85 — mais que suficiente pra
 * vitrine/PDP. Arquivo pequeno passa INTACTO (não reprocessa à toa, preserva
 * PNG com transparência). Qualquer falha (formato exótico, canvas bloqueado)
 * devolve o arquivo ORIGINAL: comprimir é otimização, nunca pode impedir o
 * upload que hoje funciona.
 */

const LADO_MAX = 2000;        // px — lado maior após o resize
const BYTES_SEM_TOCAR = 1.5 * 1024 * 1024; // ≤1,5MB e cabendo em 2000px: passa direto
const QUALIDADE_JPEG = 0.85;

export async function comprimirFotoProduto(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  // GIF (animação) e SVG não sobrevivem a canvas — vão como estão.
  if (/gif|svg/i.test(file.type)) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const precisaResize = Math.max(width, height) > LADO_MAX;
    if (!precisaResize && file.size <= BYTES_SEM_TOCAR) {
      bitmap.close();
      return file;
    }

    const escala = precisaResize ? LADO_MAX / Math.max(width, height) : 1;
    const w = Math.round(width * escala);
    const h = Math.round(height * escala);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return file; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALIDADE_JPEG),
    );
    // Se o canvas falhou — ou a "compressão" saiu MAIOR que o original — original.
    if (!blob || blob.size >= file.size) return file;

    const nome = file.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
    return new File([blob], nome, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
