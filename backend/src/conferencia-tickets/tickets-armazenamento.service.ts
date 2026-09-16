import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';

/**
 * Onde as fotos dos tickets moram: Cloudflare R2 (mesmo bucket e envs `R2_*`
 * do contas a pagar e do RH).
 *
 * O bucket é público por URL — e o recibo de crediário tem nome, CPF e
 * telefone da cliente. Por isso a chave é aleatória, a URL pública NUNCA é
 * gravada nem entregue à tela, e a foto só abre pelo backend, com link
 * assinado de curta duração (`linkAssinado` / `assinaturaValida`).
 */

export type MimeFoto = 'image/jpeg' | 'image/png' | 'image/webp';

const LADO_MAX = 2400; // o Opus lê até 2576px no lado maior — texto miúdo precisa da resolução
const QUALIDADE = 85;
const VALIDADE_LINK_MS = 60 * 60_000;

@Injectable()
export class TicketsArmazenamentoService {
  private readonly logger = new Logger(TicketsArmazenamentoService.name);
  private cliente: S3Client | null = null;

  private r2(): { client: S3Client; bucket: string } {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME;
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new ServiceUnavailableException('Armazenamento de fotos (R2) não configurado no Railway.');
    }
    if (!this.cliente) {
      this.cliente = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
    }
    return { client: this.cliente, bucket };
  }

  /**
   * Endireita (EXIF), reduz e converte pra JPEG. Foto de celular chega deitada
   * pelo EXIF — a IA leria o ticket de lado. HEIC do iPhone vira JPEG aqui.
   */
  async preparar(buffer: Buffer, mimeRecebido: string): Promise<{ buffer: Buffer; mime: MimeFoto }> {
    if (!buffer?.length) throw new BadRequestException('Foto vazia');
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      const saida: Buffer = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize(LADO_MAX, LADO_MAX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: QUALIDADE, mozjpeg: true })
        .toBuffer();
      return { buffer: saida, mime: 'image/jpeg' };
    } catch (e: any) {
      const mime = String(mimeRecebido || '').toLowerCase();
      if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp') {
        this.logger.warn(`[tickets] sharp falhou (${e?.message}) — seguindo com a foto original`);
        return { buffer, mime: mime as MimeFoto };
      }
      throw new BadRequestException('Não consegui abrir esta foto. Tire de novo com a câmera (JPG).');
    }
  }

  hash(buffer: Buffer): string {
    return createHash('md5').update(buffer).digest('hex');
  }

  async salvar(storeCode: string, dia: string, buffer: Buffer, mime: MimeFoto): Promise<string> {
    const { client, bucket } = this.r2();
    const loja = String(storeCode).replace(/[^0-9A-Za-z_-]/g, '') || 'loja';
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const chave = `conferencia-tickets/${loja}/${dia}/${randomUUID()}.${ext}`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: chave,
        Body: buffer,
        ContentType: mime,
        CacheControl: 'private, max-age=0, no-store',
      }),
    );
    return chave;
  }

  async ler(chave: string): Promise<Buffer> {
    const { client, bucket } = this.r2();
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: chave }));
    const bytes = await r.Body?.transformToByteArray();
    if (!bytes?.length) throw new Error(`foto vazia no armazenamento (${chave})`);
    return Buffer.from(bytes);
  }

  async apagar(chave: string): Promise<void> {
    try {
      const { client, bucket } = this.r2();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: chave }));
    } catch (e: any) {
      this.logger.warn(`[tickets] não apaguei ${chave} do R2: ${e?.message}`);
    }
  }

  // ── link assinado pra <img src> (a tela não manda Authorization em imagem) ──

  private segredo(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new ServiceUnavailableException('JWT_SECRET ausente');
    return `conferencia-tickets:${s}`;
  }

  private assinar(fotoId: string, exp: number): string {
    return createHmac('sha256', this.segredo()).update(`${fotoId}.${exp}`).digest('base64url');
  }

  /** Caminho relativo à API (`/public/...`); a tela prefixa a base da API. */
  linkAssinado(fotoId: string): string {
    const exp = Date.now() + VALIDADE_LINK_MS;
    return `/public/conferencia-tickets/foto/${fotoId}?exp=${exp}&sig=${this.assinar(fotoId, exp)}`;
  }

  assinaturaValida(fotoId: string, exp: string, sig: string): boolean {
    const n = Number(exp);
    if (!Number.isFinite(n) || n < Date.now() || !sig) return false;
    const esperado = Buffer.from(this.assinar(fotoId, n));
    const recebido = Buffer.from(String(sig));
    return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
  }
}
