import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * FOTO DA AVALIAÇÃO — sobe pro mesmo R2 das fotos de produto, em pasta
 * separada (`avaliacoes/`).
 *
 * Cliente logada é quem manda o arquivo, então nada aqui confia no navegador:
 * tipo conferido na origem, tamanho limitado no interceptor, nome do arquivo
 * descartado (vira timestamp + aleatório). Pasta separada porque foto de
 * cliente NÃO pode ser confundida com foto oficial da peça — a regra da casa
 * é que a vitrine só mostra foto nossa.
 */
@Injectable()
export class AvaliacoesFotosService {
  private readonly logger = new Logger(AvaliacoesFotosService.name);

  /** Os formatos que o navegador manda de câmera/galeria. */
  private static readonly TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

  async upload(accountId: string, file: any): Promise<{ url: string }> {
    if (!file?.buffer) throw new BadRequestException('Arquivo obrigatório');

    const tipo = String(file.mimetype || '').toLowerCase();
    if (!AvaliacoesFotosService.TIPOS.includes(tipo)) {
      throw new BadRequestException('Mande uma foto (JPG, PNG ou WEBP).');
    }

    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    const accountR2 = process.env.R2_ACCOUNT_ID;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!bucket || !publicUrl || !accountR2 || !accessKey || !secretKey) {
      throw new BadRequestException('Envio de foto indisponível no momento.');
    }

    const ext = tipo.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    // Nome do arquivo da cliente é descartado: além de vazar o nome do
    // celular dela, é o vetor clássico de path traversal no bucket.
    const objectKey = `avaliacoes/${accountId}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}.${ext}`;

    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountR2}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: file.buffer,
        ContentType: tipo,
        ContentDisposition: 'inline',
      }),
    );

    const url = `${publicUrl}/${objectKey}`;
    this.logger.log(`[avaliacoes] foto de conta=${accountId.slice(0, 8)} → ${objectKey}`);
    return { url };
  }
}
