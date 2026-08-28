import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Comprovante de pagamento da conta (pedido do dono 28/08): anexar o PDF/foto
 * do banco na hora da baixa (modal "Pagar" e "📎 Feito" do A fazer hoje) ou
 * depois, pelo clipe da linha PAGA.
 *
 * Arquivo vai pro Cloudflare R2 (mesmo bucket/envs R2_* do prontuário do RH e
 * do imobiliário), em `contas-pagar/<contaId>/<timestamp>-<nome>`. É 1
 * comprovante por conta: re-upload SUBSTITUI (e apaga o antigo do R2, pra não
 * acumular órfão pago no storage). Toda mexida vira ContaPagarLog 'comprovante'.
 */
@Injectable()
export class ContasPagarComprovanteService {
  private readonly logger = new Logger(ContasPagarComprovanteService.name);
  private r2ClientCache: S3Client | null = null;

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
      credentials: { accessKeyId: accessKey, secretAccessKey: secret },
    });
    return this.r2ClientCache;
  }

  private sanitizeFilename(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
  }

  private async getConta(id: string) {
    const c = await (this.prisma as any).contaPagar.findUnique({ where: { id } });
    if (!c || c.deletedAt) throw new NotFoundException('Conta não encontrada');
    return c;
  }

  private async log(contaId: string, antigo: any, novo: any, usuario?: string) {
    await (this.prisma as any).contaPagarLog.create({
      data: {
        contaId,
        campo: 'comprovante',
        valorAntigo: antigo == null ? null : String(antigo).slice(0, 300),
        valorNovo: novo == null ? null : String(novo).slice(0, 300),
        usuario: usuario || null,
        origem: 'tela',
      },
    });
  }

  private async apagarDoR2(fileUrl: string) {
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl || !fileUrl) return;
    try {
      const base = publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl;
      if (fileUrl.startsWith(`${base}/`)) {
        const objectKey = fileUrl.slice(base.length + 1);
        await this.getR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      }
    } catch (e: any) {
      // Não trava a operação — órfão no R2 é melhor que upload/remoção falhando
      this.logger.warn(`[comprovante] falha removendo do R2: ${e?.message}`);
    }
  }

  /** Upload via multipart 'file'. Vale pra conta ABERTA ou PAGA (anexar depois). */
  async upload(id: string, file: any, usuario?: string) {
    if (!file) throw new BadRequestException('Arquivo obrigatório');
    const mime = String(file.mimetype || '');
    if (mime !== 'application/pdf' && !mime.startsWith('image/')) {
      throw new BadRequestException('Só PDF ou imagem (o PDF do banco ou a foto/print do comprovante)');
    }
    const c = await this.getConta(id);

    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL nao configurado no Railway.');
    }

    const safeName = this.sanitizeFilename(file.originalname || 'comprovante');
    const objectKey = `contas-pagar/${id}/${Date.now()}-${safeName}`;
    try {
      await this.getR2Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: file.buffer,
          ContentType: mime || 'application/octet-stream',
          ContentDisposition: `inline; filename="${safeName}"`,
        }),
      );
    } catch (e: any) {
      throw new BadRequestException(`Falha ao subir o comprovante: ${e?.message || e}`);
    }

    const base = publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl;
    const fileUrl = `${base}/${objectKey}`;
    const nome = String(file.originalname || safeName).slice(0, 200);

    if (c.comprovanteUrl) await this.apagarDoR2(c.comprovanteUrl);
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: {
        comprovanteUrl: fileUrl,
        comprovanteNome: nome,
        comprovanteEm: new Date(),
        comprovantePor: usuario || null,
        updatedBy: usuario || null,
      },
    });
    await this.log(id, c.comprovanteNome || null, nome, usuario);
    this.logger.log(`[comprovante] conta nº${c.numero}: ${safeName} (${file.size || 0} bytes) por ${usuario || '?'}`);
    return { ok: true, comprovanteUrl: upd.comprovanteUrl, comprovanteNome: upd.comprovanteNome };
  }

  async remover(id: string, usuario?: string) {
    const c = await this.getConta(id);
    if (!c.comprovanteUrl) throw new BadRequestException('Esta conta não tem comprovante anexado');
    await this.apagarDoR2(c.comprovanteUrl);
    await (this.prisma as any).contaPagar.update({
      where: { id },
      data: {
        comprovanteUrl: null,
        comprovanteNome: null,
        comprovanteEm: null,
        comprovantePor: null,
        updatedBy: usuario || null,
      },
    });
    await this.log(id, c.comprovanteNome || 'anexo', null, usuario);
    return { ok: true };
  }
}
