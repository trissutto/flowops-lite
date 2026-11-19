import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { MediaSource } from './types';

let clientCache: S3Client | null = null;

// Nome oficial é MEDIA_S3_<X>. Os dois prefixos antigos (PUBLIC_MEDIA_S3_ e
// PUBLIC_MEDIA_R2_) continuam lidos só por compatibilidade: a Vercel CLI
// recusa gravar variável "PUBLIC_*" como Secret (acha que é pública no
// navegador), então a credencial do bucket só pode ser trocada pelo nome novo.
//
// O conjunto inteiro vem de UM prefixo só: o primeiro que tiver o par de
// chaves. Misturar (chave nova com endpoint/bucket de um prefixo velho)
// mandaria a credencial pra um storage que não é o dela — por isso não há
// fallback campo a campo.
const PREFIXOS = ['MEDIA_S3_', 'PUBLIC_MEDIA_S3_', 'PUBLIC_MEDIA_R2_'] as const;

function prefixoAtivo() {
  const p = PREFIXOS.find((pre) => process.env[`${pre}ACCESS_KEY_ID`] && process.env[`${pre}SECRET_ACCESS_KEY`]);
  if (!p) throw new Error('Armazenamento público não configurado (MEDIA_S3_ACCESS_KEY_ID / MEDIA_S3_SECRET_ACCESS_KEY).');
  return p;
}

function env(sufixo: string) {
  return process.env[`${prefixoAtivo()}${sufixo}`] || undefined;
}

function client() {
  if (clientCache) return clientCache;
  const accountId = env('ACCOUNT_ID');
  const endpoint = env('ENDPOINT')
    || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const accessKeyId = env('ACCESS_KEY_ID');
  const secretAccessKey = env('SECRET_ACCESS_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error('Armazenamento público não configurado.');
  const region = env('REGION') || 'auto';
  const forcePathStyle = env('FORCE_PATH_STYLE') === '1';
  // As chaves são Secret na Vercel (ninguém lê o valor depois de salvar).
  // Este log é o único retrato do que o portal está usando — sem segredo:
  // só host, bucket, estilo de URL, o começo da access key e de QUAL prefixo
  // de variável o conjunto veio (pra flagrar credencial velha ainda em uso).
  console.info('[storage] cliente S3', {
    endpointHost: safeHost(endpoint),
    bucket: env('BUCKET_NAME') || null,
    region,
    forcePathStyle,
    accessKeyIdPrefix: accessKeyId.slice(0, 4),
    prefixo: prefixoAtivo(),
  });
  clientCache = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });
  return clientCache;
}

/**
 * Resumo de um erro do S3 que pode ir pro log sem vazar segredo: nada de URL
 * assinada, parâmetros X-Amz, access key, nem o publicId (link secreto da
 * ficha), que aparece tanto na chave do objeto quanto na mensagem do SDK.
 */
export function describeStorageError(error: any, publicId?: string) {
  let message = String(error?.message || error || '');
  if (publicId) message = message.split(publicId).join('<ficha>');
  message = message
    .replace(/https?:\/\/[^\s"']+/g, '<url>')
    .replace(/([?&])(X-Amz-[A-Za-z-]+|Signature|Credential|Security-Token)=[^&\s"']*/gi, '$1$2=<oculto>')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '<akid>')
    .replace(/\btid_[A-Za-z0-9_-]+/g, '<akid>')
    .replace(/properties\/[^/\s"']+/g, 'properties/<ficha>');
  return {
    name: error?.name ?? null,
    code: error?.Code || error?.code || error?.$metadata?.httpStatusCode || null,
    message: message.slice(0, 300),
  };
}

/** Parte da chave do objeto que não carrega o publicId (`v2/<mediaId>-arquivo.jpg`). */
export function storageKeyPublicPart(storageKey: string) {
  return storageKey.split('/').slice(2).join('/');
}

function safeHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return 'inválido';
  }
}

function bucket() {
  const name = env('BUCKET_NAME');
  if (!name) throw new Error('MEDIA_S3_BUCKET_NAME não configurado.');
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
