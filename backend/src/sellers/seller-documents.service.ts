import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SellerDocumentsService — Upload de documentos do prontuario da funcionaria
 * pro Cloudflare R2 (mesmo bucket usado pelo imobiliario).
 *
 * Pasta por funcionaria:  rh/<sellerId>/<categoria>/<timestamp>-<filename>
 *
 * Categorias aceitas (precisa bater com o front):
 *   documento_pessoal | contrato | recibo_pagamento | atestado | ferias | outro
 *
 * Variaveis Railway (mesmas do imobiliario):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *   R2_BUCKET_NAME, R2_PUBLIC_URL
 */
@Injectable()
export class SellerDocumentsService {
  private readonly logger = new Logger(SellerDocumentsService.name);
  private r2ClientCache: S3Client | null = null;

  static readonly CATEGORIAS_VALIDAS = [
    'documento_pessoal',
    'contrato',
    'recibo_pagamento',
    'atestado',
    'ferias',
    'outro',
  ];

  constructor(private readonly prisma: PrismaService) {}

  private getR2Client(): S3Client {
    if (this.r2ClientCache) return this.r2ClientCache;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secret = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKey || !secret) {
      throw new BadRequestException(
        'R2 nao configurado. Setar R2_ACCOUNT_ID, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY no Railway.',
      );
    }
    this.r2ClientCache = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secret,
      },
    });
    return this.r2ClientCache;
  }

  private sanitizeFilename(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
  }

  /** Lista documentos da funcionaria agrupados por categoria. */
  async listBySeller(sellerId: string) {
    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: sellerId },
      select: { id: true },
    });
    if (!seller) throw new NotFoundException('Funcionaria nao encontrada');

    const docs = await (this.prisma as any).sellerDocument.findMany({
      where: { sellerId },
      orderBy: [{ categoria: 'asc' }, { uploadedAt: 'desc' }],
    });

    // Agrupa por categoria
    const grouped: Record<string, any[]> = {};
    for (const cat of SellerDocumentsService.CATEGORIAS_VALIDAS) {
      grouped[cat] = [];
    }
    for (const d of docs) {
      const cat = d.categoria || 'outro';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(d);
    }
    return { total: docs.length, grouped };
  }

  /** Upload de um documento. Body via multipart/form-data. */
  async upload(
    sellerId: string,
    file: any,
    input: {
      categoria: string;
      titulo?: string;
      dataReferencia?: string | null;
      observacoes?: string | null;
    },
    uploadedBy?: string | null,
  ) {
    if (!file) throw new BadRequestException('Arquivo obrigatorio');

    const categoria = (input.categoria || 'outro').toLowerCase();
    if (!SellerDocumentsService.CATEGORIAS_VALIDAS.includes(categoria)) {
      throw new BadRequestException(
        `Categoria invalida. Use: ${SellerDocumentsService.CATEGORIAS_VALIDAS.join(', ')}`,
      );
    }

    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: sellerId },
      select: { id: true, name: true },
    });
    if (!seller) throw new NotFoundException('Funcionaria nao encontrada');

    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException(
        'R2_BUCKET_NAME ou R2_PUBLIC_URL nao configurado. Setar no Railway.',
      );
    }

    const safeName = this.sanitizeFilename(file.originalname || 'arquivo');
    const objectKey = `rh/${sellerId}/${categoria}/${Date.now()}-${safeName}`;

    try {
      const client = this.getR2Client();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: file.buffer,
          ContentType: file.mimetype || 'application/octet-stream',
          ContentDisposition: `inline; filename="${file.originalname}"`,
        }),
      );
    } catch (e: any) {
      throw new BadRequestException(`Falha ao subir pro R2: ${e?.message || e}`);
    }

    const base = publicUrl.replace(/\/$/, '');
    const fileUrl = `${base}/${objectKey}`;

    const titulo =
      (input.titulo && input.titulo.trim()) ||
      file.originalname ||
      `Documento ${categoria}`;

    const doc = await (this.prisma as any).sellerDocument.create({
      data: {
        sellerId,
        categoria,
        titulo: titulo.slice(0, 200),
        fileUrl,
        fileSize: file.size || null,
        mimeType: file.mimetype || null,
        dataReferencia: input.dataReferencia ? new Date(input.dataReferencia) : null,
        observacoes: input.observacoes || null,
        uploadedBy: uploadedBy || null,
      },
    });

    this.logger.log(
      `[doc] upload seller=${seller.name} cat=${categoria} file=${safeName} (${file.size} bytes)`,
    );

    return { ok: true, document: doc };
  }

  /** Remove documento do R2 + apaga o registro. */
  async remove(docId: string) {
    const doc = await (this.prisma as any).sellerDocument.findUnique({
      where: { id: docId },
    });
    if (!doc) throw new NotFoundException('Documento nao encontrado');

    // Apaga do R2 se conseguimos extrair a key
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (bucket && publicUrl && doc.fileUrl) {
      try {
        const base = publicUrl.replace(/\/$/, '');
        if (doc.fileUrl.startsWith(base)) {
          const objectKey = doc.fileUrl.slice(base.length + 1); // remove "/" inicial
          const client = this.getR2Client();
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
          );
        }
      } catch (e: any) {
        this.logger.warn(`[doc] falha removendo do R2: ${e?.message}`);
        // Continua mesmo assim — apaga do banco
      }
    }

    await (this.prisma as any).sellerDocument.delete({ where: { id: docId } });
    return { ok: true };
  }
}
