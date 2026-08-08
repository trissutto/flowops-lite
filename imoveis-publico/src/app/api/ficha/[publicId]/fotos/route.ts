import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { PassThrough, Readable } from 'stream';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/security';
import { getObjectNodeStream } from '@/lib/storage';
import { PublicPropertySnapshot } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const { publicId } = await params;
    await enforceRateLimit(request, `zip:${publicId}`, 5);
    const property = await prisma.publicProperty.findFirst({
      where: { publicId, active: true },
      include: { media: { where: { kind: 'photo', storageKey: { not: null } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!property) return new NextResponse('Ficha indisponível.', { status: 404, headers: noStoreHeaders() });
    const snapshot = property.snapshot as unknown as PublicPropertySnapshot;
    const output = new PassThrough();
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(output);
    for (let index = 0; index < property.media.length; index++) {
      const media = property.media[index];
      if (!media.storageKey) continue;
      const { stream } = await getObjectNodeStream(media.storageKey);
      const extension = extensionFor(media.mimeType);
      archive.append(stream, { name: `${String(index + 1).padStart(2, '0')}-${safeFileName(media.fileName, extension)}` });
    }
    void archive.finalize();
    return new NextResponse(Readable.toWeb(output) as ReadableStream, {
      headers: {
        ...noStoreHeaders(),
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="fotos-${safeBaseName(snapshot.name)}.zip"`,
      },
    });
  } catch (error: any) {
    const limited = /Muitas solicitações/i.test(String(error?.message || ''));
    return new NextResponse(limited ? 'Muitas solicitações.' : 'Não foi possível gerar o pacote de fotos.', {
      status: limited ? 429 : 500,
      headers: noStoreHeaders(),
    });
  }
}

function extensionFor(mimeType?: string | null) {
  if (mimeType === 'image/png') return '.png';
  return '.jpg';
}

function safeFileName(value: string, extension: string) {
  const base = value.replace(/\.[^.]+$/, '');
  return `${safeBaseName(base)}${extension}`;
}

function safeBaseName(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'imovel';
}

function noStoreHeaders() { return { 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow, noarchive' }; }
