import { BadRequestException, Injectable } from '@nestjs/common';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);

@Injectable()
export class PropertiesMediaStorageService {
  private clientCache: S3Client | null = null;

  private client(): S3Client {
    if (this.clientCache) return this.clientCache;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new BadRequestException('R2 não configurado para as mídias dos imóveis.');
    }
    this.clientCache = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    return this.clientCache;
  }

  async upload(propertyId: string, file: any) {
    if (!file?.buffer || !file?.originalname) {
      throw new BadRequestException('Arquivo obrigatório.');
    }
    if (!ALLOWED_UPLOAD_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      throw new BadRequestException('Use apenas JPG, PNG ou PDF.');
    }
    if (Number(file.size || 0) > 10 * 1024 * 1024) {
      throw new BadRequestException('Arquivo maior que 10 MB.');
    }

    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado.');
    }

    const safeName = String(file.originalname)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_')
      .slice(-160);
    const sourceKey = `imobiliario-comercial/${propertyId}/${Date.now()}-${safeName}`;

    await this.client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: sourceKey,
      Body: file.buffer,
      ContentType: file.mimetype,
      ContentDisposition: `inline; filename="${safeName}"`,
    }));

    return {
      sourceKey,
      sourceUrl: `${publicUrl.replace(/\/$/, '')}/${sourceKey}`,
      fileName: String(file.originalname),
      mimeType: String(file.mimetype),
      fileSize: Number(file.size || 0),
    };
  }

  async remove(sourceKey?: string | null) {
    const bucket = process.env.R2_BUCKET_NAME;
    if (!sourceKey || !bucket) return;
    try {
      await this.client().send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));
    } catch {
      // A linha do banco já foi removida; objeto órfão pode ser limpo depois.
    }
  }
}
