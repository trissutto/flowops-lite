import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { MediaSource } from './types';

let clientCache: S3Client | null = null;

function client() {
  if (clientCache) return clientCache;
  const accountId = process.env.PUBLIC_MEDIA_R2_ACCOUNT_ID;
  const accessKeyId = process.env.PUBLIC_MEDIA_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PUBLIC_MEDIA_R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('Armazenamento público não configurado.');
  clientCache = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return clientCache;
}

function bucket() {
  const name = process.env.PUBLIC_MEDIA_R2_BUCKET_NAME;
  if (!name) throw new Error('PUBLIC_MEDIA_R2_BUCKET_NAME não configurado.');
  return name;
}

export async function copyMediaSource(source: MediaSource, publicId: string, version: number) {
  if (['video', 'virtual_tour'].includes(source.kind)) {
    const url = new URL(source.sourceUrl);
    if (url.protocol !== 'https:') throw new Error('Link externo deve usar HTTPS.');
    return { storageKey: null, externalUrl: url.toString(), mimeType: null, fileSize: null };
  }

  const sourceUrl = new URL(source.sourceUrl);
  const allowedHosts = (process.env.PUBLICATION_MEDIA_SOURCE_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (sourceUrl.protocol !== 'https:' || !allowedHosts.includes(sourceUrl.hostname.toLowerCase())) {
    throw new Error(`Origem de mídia não permitida: ${sourceUrl.hostname}.`);
  }
  const response = await fetch(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Não foi possível copiar ${source.fileName}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) throw new Error(`${source.fileName} ultrapassa 10 MB.`);
  const mimeType = String(response.headers.get('content-type') || source.mimeType || '').split(';')[0].toLowerCase();
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);
  if (!allowedTypes.has(mimeType)) throw new Error(`Tipo de arquivo não permitido: ${mimeType || 'desconhecido'}.`);
  const safeName = source.fileName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-140);
  const storageKey = `properties/${publicId}/v${version}/${source.id}-${safeName}`;
  await client().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: storageKey,
    Body: bytes,
    ContentType: mimeType,
    ContentDisposition: `inline; filename="${safeName}"`,
    CacheControl: 'no-store',
  }));
  return { storageKey, externalUrl: null, mimeType, fileSize: bytes.length };
}

export async function getObject(storageKey: string) {
  return client().send(new GetObjectCommand({ Bucket: bucket(), Key: storageKey }));
}

export async function getObjectBytes(storageKey: string) {
  const result = await getObject(storageKey);
  if (!result.Body) throw new Error('Arquivo não encontrado.');
  return Buffer.from(await result.Body.transformToByteArray());
}

export async function getObjectNodeStream(storageKey: string) {
  const result = await getObject(storageKey);
  if (!result.Body) throw new Error('Arquivo não encontrado.');
  return { stream: result.Body as Readable, contentType: result.ContentType, contentLength: result.ContentLength };
}

export async function deleteStorageKeys(keys: Array<string | null | undefined>) {
  await Promise.allSettled(keys.filter((key): key is string => !!key).map((key) =>
    client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })),
  ));
}
