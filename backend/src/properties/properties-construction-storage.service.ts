import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const MAX_SIZE = 10 * 1024 * 1024;

@Injectable()
export class PropertiesConstructionStorageService {
  private clientCache: S3Client | null = null;

  async upload(propertyId: string, projectId: string, file: any) {
    if (!file?.buffer || !file?.originalname) throw new BadRequestException('Arquivo obrigatório.');
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED_TYPES.has(mimeType)) throw new BadRequestException('Use apenas PDF, JPG ou PNG.');
    if (Number(file.size || 0) > MAX_SIZE) throw new BadRequestException('Arquivo maior que 10 MB.');

    const safeName = String(file.originalname)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_')
      .slice(-160);
    const random = Math.random().toString(36).slice(2, 10);
    const objectKey = `imobiliario-obras/${propertyId}/${projectId}/${Date.now()}-${random}-${safeName}`;
    await this.client().send(new PutObjectCommand({
      Bucket: this.bucket(),
      Key: objectKey,
      Body: file.buffer,
      ContentType: mimeType,
      ContentDisposition: `attachment; filename="${safeName}"`,
    }));
    return {
      objectKey,
      fileName: String(file.originalname),
      mimeType,
      fileSize: Number(file.size || 0),
    };
  }

  async download(objectKey: string) {
    return this.client().send(new GetObjectCommand({
      Bucket: this.bucket(),
      Key: objectKey,
    }));
  }

  async remove(objectKey?: string | null) {
    if (!objectKey) return;
    try {
      await this.client().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: objectKey }));
    } catch {
      // Rollback de upload: um objeto órfão pode ser limpo posteriormente.
    }
  }

  private bucket() {
    const bucket = process.env.R2_BUCKET_NAME;
    if (!bucket) throw new BadRequestException('R2_BUCKET_NAME não configurado para documentos de obra.');
    return bucket;
  }

  private client() {
    if (this.clientCache) return this.clientCache;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new BadRequestException('R2 não configurado para documentos de obra.');
    }
    this.clientCache = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    return this.clientCache;
  }
}
