import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/security';
import { getObjectBytes } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string; mediaId: string }> },
) {
  try {
    const { publicId, mediaId } = await params;
    await enforceRateLimit(request, `media:${publicId}`, 180);
    const media = await prisma.publicMedia.findFirst({
      where: {
        id: mediaId,
        property: { publicId, active: true },
      },
    });
    if (!media?.storageKey) return new NextResponse('Não encontrado.', { status: 404, headers: noStoreHeaders() });
    const bytes = await getObjectBytes(media.storageKey);
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
    return new NextResponse(limited ? 'Muitas solicitações.' : 'Não encontrado.', {
      status: limited ? 429 : 404,
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
