import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/security';
import { describeStorageError, getObjectBytes, storageKeyPublicPart } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string; mediaId: string }> },
) {
  let publicIdForLog: string | undefined;
  try {
    const { publicId, mediaId } = await params;
    publicIdForLog = publicId;
    await enforceRateLimit(request, `media:${publicId}`, 180);
    const media = await prisma.publicMedia.findFirst({
      where: {
        id: mediaId,
        property: { publicId, active: true },
      },
    });
    if (!media?.storageKey) return new NextResponse('Não encontrado.', { status: 404, headers: noStoreHeaders() });
    // Falha do bucket é ERRO (500) e vai pro log, não "não encontrado":
    // em 19/11/2026 todas as fotos do portal sumiram como 404 por semanas
    // porque este catch engolia a falha do S3 sem registrar nada.
    let bytes: Awaited<ReturnType<typeof getObjectBytes>>;
    try {
      bytes = await getObjectBytes(media.storageKey);
    } catch (error: any) {
      // publicId é o link secreto da ficha: não vai pro log, nem pela chave
      // do objeto nem pela mensagem do SDK (describeStorageError limpa).
      console.error('[media] falha ao ler do bucket', {
        mediaId,
        storageKey: storageKeyPublicPart(media.storageKey),
        ...describeStorageError(error, publicId),
      });
      return new NextResponse('Foto indisponível no momento.', { status: 500, headers: noStoreHeaders() });
    }
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        ...noStoreHeaders(),
        'Content-Type': media.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `inline; filename="${safeFileName(media.fileName)}"`,
      },
    });
  } catch (error: any) {
    const limited = /Muitas solicitações/i.test(String(error?.message || ''));
    if (!limited) {
      console.error('[media] falha antes do bucket', describeStorageError(error, publicIdForLog));
    }
    return new NextResponse(limited ? 'Muitas solicitações.' : 'Foto indisponível no momento.', {
      status: limited ? 429 : 500,
      headers: noStoreHeaders(),
    });
  }
}

function safeFileName(name: string) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function noStoreHeaders() {
  return { 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
}
