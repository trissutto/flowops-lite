import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) {
    throw new Error('R2_* env não configuradas');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

@Injectable()
export class ProductPhotosService {
  private readonly logger = new Logger(ProductPhotosService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Busca foto por REF (+ COR opcional).
   * Se não achar foto da COR específica, tenta foto genérica da REF.
   */
  async getPhoto(ref: string, cor?: string) {
    const refUp = (ref || '').trim().toUpperCase();
    if (!refUp) return null;
    const corUp = (cor || '').trim().toUpperCase() || null;
    // Tenta COR específica primeiro
    if (corUp) {
      const specific = await (this.prisma as any).productPhoto.findFirst({
        where: { ref: refUp, cor: corUp },
      });
      if (specific) return specific;
    }
    // Fallback: foto genérica (cor = null)
    return (this.prisma as any).productPhoto.findFirst({
      where: { ref: refUp, cor: null },
    });
  }

  /**
   * Busca várias fotos por REF (lista completa de cores).
   */
  async listByRef(ref: string) {
    const refUp = (ref || '').trim().toUpperCase();
    if (!refUp) return [];
    return (this.prisma as any).productPhoto.findMany({
      where: { ref: refUp },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Busca em batch — recebe lista de {ref, cor?} e retorna map.
   * Útil pra telas que listam vários produtos.
   */
  async getBatch(items: Array<{ ref: string; cor?: string }>) {
    const refs = Array.from(new Set(items.map((i) => (i.ref || '').trim().toUpperCase()).filter(Boolean)));
    if (refs.length === 0) return {};
    const photos = await (this.prisma as any).productPhoto.findMany({
      where: { ref: { in: refs } },
    });
    // Indexa por "REF|COR" e por "REF|" (genérica)
    const map: Record<string, string> = {};
    for (const p of photos) {
      const key = `${p.ref}|${p.cor || ''}`;
      map[key] = p.url;
    }
    return map;
  }

  /**
   * Faz upload pro R2 + cria/atualiza registro no DB.
   */
  async upload(input: {
    ref: string;
    cor?: string;
    file: any; // multer file
    userId?: string;
  }) {
    const refUp = (input.ref || '').trim().toUpperCase();
    if (!refUp) throw new BadRequestException('REF obrigatório');
    if (!input.file) throw new BadRequestException('Arquivo obrigatório');
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado.');
    }

    const corUp = (input.cor || '').trim().toUpperCase() || null;
    const safeName = (input.file.originalname || 'foto.jpg')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const corPath = corUp ? corUp.replace(/[^a-zA-Z0-9]/g, '_') : 'GENERICA';
    const objectKey = `produtos/${refUp}/${corPath}/${Date.now()}-${safeName}`;

    try {
      const client = getR2Client();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: input.file.buffer,
          ContentType: input.file.mimetype || 'image/jpeg',
          ContentDisposition: `inline; filename="${input.file.originalname}"`,
        }),
      );
    } catch (e: any) {
      throw new BadRequestException(`Falha ao subir pro R2: ${e?.message || e}`);
    }

    const base = publicUrl.replace(/\/$/, '');
    const fullUrl = `${base}/${objectKey}`;

    // Upsert: se já tem foto pra (ref, cor) substitui (deleta R2 antigo)
    const existing = await (this.prisma as any).productPhoto.findFirst({
      where: { ref: refUp, cor: corUp },
    });

    if (existing) {
      // Apaga R2 antigo (best effort)
      if (existing.objectKey) {
        try {
          await getR2Client().send(
            new DeleteObjectCommand({ Bucket: bucket, Key: existing.objectKey }),
          );
        } catch (e: any) {
          this.logger.warn(`Falha ao deletar R2 antigo: ${e?.message}`);
        }
      }
      return (this.prisma as any).productPhoto.update({
        where: { id: existing.id },
        data: {
          url: fullUrl,
          objectKey,
          uploadedByUserId: input.userId || null,
        },
      });
    }

    return (this.prisma as any).productPhoto.create({
      data: {
        ref: refUp,
        cor: corUp,
        url: fullUrl,
        objectKey,
        uploadedByUserId: input.userId || null,
      },
    });
  }

  /**
   * Remove foto (DB + R2).
   */
  async delete(id: string) {
    const photo = await (this.prisma as any).productPhoto.findUnique({ where: { id } });
    if (!photo) throw new BadRequestException('Foto não encontrada');
    const bucket = process.env.R2_BUCKET_NAME;
    if (bucket && photo.objectKey) {
      try {
        await getR2Client().send(
          new DeleteObjectCommand({ Bucket: bucket, Key: photo.objectKey }),
        );
      } catch (e: any) {
        this.logger.warn(`Falha ao deletar R2: ${e?.message}`);
      }
    }
    await (this.prisma as any).productPhoto.delete({ where: { id } });
    return { ok: true };
  }
}
