import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { copyMediaSource, deleteStorageKeys } from '@/lib/storage';
import { parseAndValidatePayload, verifySignedRequest } from '@/lib/security';
import { MediaSource, SyncPayload } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  let idempotencyKey = '';
  try {
    ({ idempotencyKey } = await verifySignedRequest(request, rawBody));
    const existing = await prisma.publicationOperation.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'succeeded') {
      return NextResponse.json(existing.response || { ok: true, repeated: true }, noStore());
    }
    if (existing?.status === 'processing' && existing.updatedAt.getTime() > Date.now() - 5 * 60 * 1000) {
      return NextResponse.json({ error: 'Operação ainda em processamento.' }, { status: 409, ...noStore() });
    }

    const payload = parseAndValidatePayload(rawBody);
    await prisma.publicationOperation.upsert({
      where: { idempotencyKey },
      create: { idempotencyKey, action: payload.action, status: 'processing' },
      update: { action: payload.action, status: 'processing', error: null },
    });

    const result = payload.action === 'revoke'
      ? await revoke(payload)
      : await upsertSnapshot(payload);
    await prisma.publicationOperation.update({
      where: { idempotencyKey },
      data: { status: 'succeeded', response: result, error: null },
    });
    return NextResponse.json(result, noStore());
  } catch (error: any) {
    const message = String(error?.message || error || 'Falha na publicação.').slice(0, 1500);
    if (idempotencyKey) {
      await prisma.publicationOperation.updateMany({
        where: { idempotencyKey },
        data: { status: 'failed', error: message },
      }).catch(() => undefined);
    }
    const authenticationError = /assinatura|nonce|requisição vencida|idempotência/i.test(message);
    return NextResponse.json(
      { error: authenticationError ? 'Publicação não autorizada.' : message },
      { status: authenticationError ? 401 : 400, ...noStore() },
    );
  }
}

async function upsertSnapshot(payload: SyncPayload) {
  const snapshot = payload.snapshot!;
  const mediaSources = payload.mediaSources || [];
  const current = payload.action === 'rotate'
    ? await prisma.publicProperty.findUnique({ where: { publicId: String(payload.oldPublicId) }, include: { media: true } })
    : await prisma.publicProperty.findUnique({ where: { publicId: payload.publicId }, include: { media: true } });

  if (current && current.version >= payload.version) {
    return { ok: true, stale: true, version: current.version };
  }
  if (payload.action === 'rotate' && !current) throw new Error('Ficha anterior não encontrada para trocar o link.');
  if (payload.action === 'rotate') {
    const collision = await prisma.publicProperty.findUnique({ where: { publicId: payload.publicId } });
    if (collision && collision.id !== current!.id) throw new Error('Novo identificador já está em uso.');
  }

  validateMediaContract(snapshot.media, mediaSources);
  const copied: Array<MediaSource & {
    storageKey: string | null;
    externalUrl: string | null;
    copiedMimeType: string | null;
    copiedFileSize: number | null;
  }> = [];
  try {
    for (let index = 0; index < mediaSources.length; index += 4) {
      const batch = mediaSources.slice(index, index + 4);
      const results = await Promise.all(batch.map(async (source) => ({
        source,
        copied: await copyMediaSource(source, payload.publicId, payload.version),
      })));
      copied.push(...results.map(({ source, copied: stored }) => ({
        ...source,
        storageKey: stored.storageKey,
        externalUrl: stored.externalUrl,
        copiedMimeType: stored.mimeType,
        copiedFileSize: stored.fileSize,
      })));
    }

    const now = new Date();
    const persisted = await prisma.$transaction(async (tx) => {
      if (current) {
        const fresh = await tx.publicProperty.findUnique({ where: { id: current.id } });
        if (fresh && fresh.version >= payload.version) return { property: fresh, applied: false };
        await tx.publicMedia.deleteMany({ where: { propertyId: current.id } });
        const updated = await tx.publicProperty.update({
          where: { id: current.id },
          data: {
            publicId: payload.publicId,
            active: true,
            version: payload.version,
            payloadHash: payload.payloadHash || null,
            snapshot: snapshot as any,
            publishedAt: now,
          },
        });
        if (copied.length) await tx.publicMedia.createMany({ data: copied.map((media) => mediaRow(updated.id, media)) });
        return { property: updated, applied: true };
      }
      const created = await tx.publicProperty.create({
        data: {
          publicId: payload.publicId,
          active: true,
          version: payload.version,
          payloadHash: payload.payloadHash || null,
          snapshot: snapshot as any,
          publishedAt: now,
          media: { createMany: { data: copied.map((media) => mediaRowWithoutProperty(media)) } },
        },
      });
      return { property: created, applied: true };
    });
    if (!persisted.applied) {
      await deleteStorageKeys(copied.map((media) => media.storageKey));
      return { ok: true, stale: true, version: persisted.property.version };
    }
    await deleteStorageKeys(current?.media.map((media) => media.storageKey) || []);
    return { ok: true, publicId: persisted.property.publicId, version: persisted.property.version };
  } catch (error) {
    await deleteStorageKeys(copied.map((media) => media.storageKey));
    throw error;
  }
}

async function revoke(payload: SyncPayload) {
  const current = await prisma.publicProperty.findUnique({
    where: { publicId: payload.publicId },
    include: { media: true },
  });
  if (!current) return { ok: true, alreadyMissing: true, version: payload.version };
  if (current.version >= payload.version && !current.active) {
    return { ok: true, stale: true, version: current.version };
  }
  if (current.version > payload.version) return { ok: true, stale: true, version: current.version };
  await prisma.$transaction([
    prisma.publicMedia.deleteMany({ where: { propertyId: current.id } }),
    prisma.publicProperty.update({
      where: { id: current.id },
      data: { active: false, version: payload.version },
    }),
  ]);
  await deleteStorageKeys(current.media.map((media) => media.storageKey));
  return { ok: true, revoked: true, version: payload.version };
}

function validateMediaContract(descriptors: Array<{ id: string }>, sources: MediaSource[]) {
  const descriptorIds = descriptors.map((media) => media.id).sort();
  const sourceIds = sources.map((media) => media.id).sort();
  if (new Set(sourceIds).size !== sourceIds.length || JSON.stringify(descriptorIds) !== JSON.stringify(sourceIds)) {
    throw new Error('Mídias do snapshot e da transferência não correspondem.');
  }
}

function mediaRow(propertyId: string, media: any) {
  return { propertyId, ...mediaRowWithoutProperty(media) };
}

function mediaRowWithoutProperty(media: any) {
  return {
    id: media.id,
    kind: media.kind,
    fileName: media.fileName,
    storageKey: media.storageKey,
    externalUrl: media.externalUrl,
    mimeType: media.copiedMimeType || media.mimeType,
    fileSize: media.copiedFileSize || media.fileSize,
    caption: media.caption,
    sortOrder: media.sortOrder,
    isCover: media.isCover,
  };
}

function noStore() {
  return { headers: { 'Cache-Control': 'no-store' } };
}
