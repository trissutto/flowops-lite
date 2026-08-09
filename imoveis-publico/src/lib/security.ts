import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';
import { prisma } from './prisma';
import { SyncPayload } from './types';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const FORBIDDEN_KEYS = new Set([
  'proprietario',
  'owner',
  'water',
  'energy',
  'deed',
  'scripture',
  'attachments',
  'brokercommissionnotes',
  'internalnegotiationnotes',
  'observacoes',
  'createdbyuserid',
  'uploadedbyuserid',
  'logs',
]);

export async function verifySignedRequest(request: NextRequest, rawBody: string) {
  const secret = process.env.PUBLICATION_SYNC_SECRET || '';
  if (secret.length < 32) throw new Error('PUBLICATION_SYNC_SECRET inválido.');
  const timestamp = request.headers.get('x-flowops-timestamp') || '';
  const nonce = request.headers.get('x-flowops-nonce') || '';
  const signature = request.headers.get('x-flowops-signature') || '';
  const idempotencyKey = request.headers.get('x-idempotency-key') || '';
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber) > 5 * 60 * 1000) {
    throw new Error('Requisição vencida.');
  }
  if (!/^[a-f0-9]{32,128}$/i.test(nonce)) throw new Error('Nonce inválido.');
  if (!/^[a-f0-9]{64}$/i.test(signature)) throw new Error('Assinatura inválida.');
  if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new Error('Idempotência inválida.');

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${rawBody}`)
    .digest('hex');
  if (!safeEqual(expected, signature)) throw new Error('Assinatura inválida.');

  await prisma.publicationNonce.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  }).catch(() => undefined);
  try {
    await prisma.publicationNonce.create({ data: { nonce } });
  } catch {
    throw new Error('Requisição repetida.');
  }
  return { idempotencyKey };
}

export function parseAndValidatePayload(rawBody: string): SyncPayload {
  let payload: SyncPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error('JSON inválido.');
  }
  if (!['upsert', 'rotate', 'revoke'].includes(payload.action)) throw new Error('Ação inválida.');
  if (!PUBLIC_ID_PATTERN.test(String(payload.publicId || ''))) throw new Error('Identificador público inválido.');
  if (!Number.isInteger(payload.version) || payload.version < 1) throw new Error('Versão inválida.');
  if (payload.action === 'rotate' && !PUBLIC_ID_PATTERN.test(String(payload.oldPublicId || ''))) {
    throw new Error('Identificador anterior inválido.');
  }
  if (payload.action !== 'revoke') {
    if (!payload.snapshot || payload.snapshot.schemaVersion !== 1) throw new Error('Snapshot incompatível.');
    if (payload.snapshot.publicId !== payload.publicId || payload.snapshot.version !== payload.version) {
      throw new Error('Snapshot não corresponde à operação.');
    }
    if (!payload.snapshot.name || !payload.snapshot.municipalRegistration || !payload.snapshot.propertyType) {
      throw new Error('Snapshot incompleto.');
    }
    if (!(Number(payload.snapshot.financial?.salePrice) > 0)) throw new Error('Valor de venda inválido.');
    if (!Array.isArray(payload.mediaSources) || payload.mediaSources.length > 100) {
      throw new Error('Lista de mídias inválida.');
    }
    rejectForbiddenKeys(payload.snapshot);
  }
  return payload;
}

export async function enforceRateLimit(request: NextRequest, bucket: string, limit: number) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const window = Math.floor(Date.now() / 60_000);
  const secret = process.env.PUBLICATION_SYNC_SECRET || 'public-rate-limit';
  const key = createHash('sha256').update(`${secret}:${forwarded}:${bucket}:${window}`).digest('hex');
  const expiresAt = new Date((window + 2) * 60_000);
  const entry = await prisma.publicRateLimit.upsert({
    where: { key },
    create: { key, count: 1, expiresAt },
    update: { count: { increment: 1 } },
  });
  if (entry.count > limit) throw new Error('Muitas solicitações. Tente novamente em instantes.');
  if (Math.random() < 0.02) {
    await prisma.publicRateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  }
}

function rejectForbiddenKeys(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`Campo proibido no snapshot: ${key}.`);
    rejectForbiddenKeys(child);
  }
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
