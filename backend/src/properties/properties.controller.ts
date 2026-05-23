import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PropertiesService } from './properties.service';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * Cliente S3 apontando pro Cloudflare R2 (S3-compatible).
 *
 * Por que R2 em vez de Vercel Blob: o Vercel mudou a API várias vezes
 * (OIDC, Public vs Private store, tokens confidenciais) e quebrou o
 * upload server-side. R2 é S3 padrão, estável, gratuito até 10GB.
 *
 * Variáveis de ambiente necessárias no Railway:
 *   R2_ACCOUNT_ID         — Cloudflare account ID (ex: abc123def...)
 *   R2_ACCESS_KEY_ID      — Access Key gerada na aba R2 API Tokens
 *   R2_SECRET_ACCESS_KEY  — Secret correspondente
 *   R2_BUCKET_NAME        — nome do bucket (ex: lurds-imobiliario)
 *   R2_PUBLIC_URL         — URL pública base. Pode ser:
 *                            a) https://pub-xxxxx.r2.dev   (subdomain default
 *                               do R2, ativado na aba Settings do bucket)
 *                            b) https://files.lurds.com.br (custom domain via CNAME)
 *
 * Inicialização lazy: só cria o client quando precisa, e só se as
 * variáveis estiverem setadas (evita crash no boot do backend).
 */
let r2ClientCache: S3Client | null = null;
function getR2Client(): S3Client {
  if (r2ClientCache) return r2ClientCache;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secret) {
    throw new Error(
      'R2 não configurado. Setar R2_ACCOUNT_ID, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY no Railway.',
    );
  }
  r2ClientCache = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secret,
    },
  });
  return r2ClientCache;
}

/**
 * /properties — módulo IMOBILIÁRIO.
 *
 * Roles permitidas:
 *   - admin (senha suprema)
 *   - imobiliario_admin (CRUD completo + gestão usuários)
 *   - imobiliario_user (CRUD imóveis + docs, sem deletar)
 *   - imobiliario_viewer (só leitura)
 */
@UseGuards(JwtAuthGuard)
@Controller('properties')
export class PropertiesController {
  constructor(private readonly svc: PropertiesService) {}

  // Niveis de acesso
  private requireRead(req: any) {
    const allowed = ['admin', 'imobiliario_admin', 'imobiliario_user', 'imobiliario_viewer'];
    if (!allowed.includes(req?.user?.role)) {
      throw new ForbiddenException('Sem acesso ao módulo imobiliário');
    }
  }
  private requireWrite(req: any) {
    const allowed = ['admin', 'imobiliario_admin', 'imobiliario_user'];
    if (!allowed.includes(req?.user?.role)) {
      throw new ForbiddenException('Sem permissão de escrita no imobiliário');
    }
  }
  private requireDelete(req: any) {
    const allowed = ['admin', 'imobiliario_admin'];
    if (!allowed.includes(req?.user?.role)) {
      throw new ForbiddenException('Apenas admin imobiliário pode excluir/arquivar');
    }
  }
  private userInfo(req: any) {
    return {
      id: req?.user?.id || req?.user?.sub || null,
      name: req?.user?.name || req?.user?.email || null,
    };
  }

  // ── CRUD principal ──
  @Get()
  async list(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('cidade') cidade?: string,
    @Query('bairro') bairro?: string,
    @Query('status') status?: string,
    @Query('arquivados') arquivados?: string,
  ) {
    this.requireRead(req);
    return this.svc.list({
      search: search || null,
      cidade: cidade || null,
      bairro: bairro || null,
      status: status || null,
      incluirArquivados: arquivados === 'true' || arquivados === '1',
    });
  }

  @Get('dashboard')
  async dashboard(@Req() req: any) {
    this.requireRead(req);
    return this.svc.dashboard();
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    this.requireRead(req);
    return this.svc.getById(id);
  }

  @Get(':id/logs')
  async logs(@Req() req: any, @Param('id') id: string, @Query('limit') limit?: string) {
    this.requireRead(req);
    return this.svc.getLogs(id, limit ? Number(limit) : 50);
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.create(body, this.userInfo(req));
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.update(id, body, this.userInfo(req));
  }

  @Post(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    this.requireDelete(req);
    return this.svc.archive(id, this.userInfo(req));
  }

  @Post(':id/unarchive')
  async unarchive(@Req() req: any, @Param('id') id: string) {
    this.requireDelete(req);
    return this.svc.unarchive(id, this.userInfo(req));
  }

  @Post(':id/duplicate')
  async duplicate(@Req() req: any, @Param('id') id: string) {
    this.requireWrite(req);
    return this.svc.duplicate(id, this.userInfo(req));
  }

  // ── Sub-recursos 1:1 ──
  @Patch(':id/water')
  async upsertWater(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.upsertWater(id, body, this.userInfo(req));
  }

  @Patch(':id/energy')
  async upsertEnergy(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.upsertEnergy(id, body, this.userInfo(req));
  }

  @Patch(':id/iptu')
  async upsertIptu(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.upsertIptu(id, body, this.userInfo(req));
  }

  @Patch(':id/deed')
  async upsertDeed(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.upsertDeed(id, body, this.userInfo(req));
  }

  @Patch(':id/scripture')
  async upsertScripture(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.upsertScripture(id, body, this.userInfo(req));
  }

  // ── Taxas (1:N) ──
  @Post(':id/taxes')
  async createTax(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.createTax(id, body, this.userInfo(req));
  }

  @Patch('taxes/:taxId')
  async updateTax(@Req() req: any, @Param('taxId') taxId: string, @Body() body: any) {
    this.requireWrite(req);
    return this.svc.updateTax(taxId, body, this.userInfo(req));
  }

  @Delete('taxes/:taxId')
  async deleteTax(@Req() req: any, @Param('taxId') taxId: string) {
    this.requireWrite(req);
    return this.svc.deleteTax(taxId, this.userInfo(req));
  }

  // ── Anexos gerais ──
  @Post(':id/attachments')
  async addAttachment(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireWrite(req);
    if (!body?.fileUrl || !body?.fileName) {
      throw new BadRequestException('fileUrl e fileName obrigatórios');
    }
    return this.svc.addAttachment(id, body, this.userInfo(req));
  }

  /**
   * POST /properties/:id/upload
   * Upload de arquivo via multipart/form-data → grava no Cloudflare R2 →
   * cria PropertyAttachment ou atualiza seção (water/energy/iptu/etc).
   *
   * Body (form-data):
   *   file: arquivo (PDF, JPG, PNG, WEBP) — máximo 10 MB
   *   category: string opcional (default 'Outros')
   *   scope: 'water' | 'energy' | 'iptu' | 'deed' | 'scripture' (opcional)
   *
   * Variáveis Railway necessárias:
   *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
   *   R2_BUCKET_NAME, R2_PUBLIC_URL
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadFile(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body('category') category?: string,
    @Body('scope') scope?: string,
  ) {
    this.requireWrite(req);
    if (!file) throw new BadRequestException('Arquivo obrigatório');

    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException(
        'R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado. Setar no Railway.',
      );
    }

    // Sanitiza filename (tira acentos + caracteres especiais)
    const safeName = file.originalname
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const objectKey = `imobiliario/${id}/${Date.now()}-${safeName}`;

    // Upload pro R2 via S3 SDK
    let fileUrl: string;
    try {
      const client = getR2Client();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: file.buffer,
          ContentType: file.mimetype,
          // Headers customizados pra preservar nome original (download)
          ContentDisposition: `inline; filename="${file.originalname}"`,
        }),
      );
      // Monta URL pública. R2_PUBLIC_URL deve terminar SEM barra.
      const base = publicUrl.replace(/\/$/, '');
      fileUrl = `${base}/${objectKey}`;
    } catch (e: any) {
      throw new BadRequestException(
        `Falha ao subir pro R2: ${e?.message || e}`,
      );
    }

    // Seção específica (water/energy/iptu/deed/scripture) → atualiza attachmentUrl
    if (scope && ['water', 'energy', 'iptu', 'deed', 'scripture'].includes(scope)) {
      const u = this.userInfo(req);
      const map: Record<string, (id: string, input: any, user: any) => Promise<any>> = {
        water: (id, i, u) => this.svc.upsertWater(id, i, u),
        energy: (id, i, u) => this.svc.upsertEnergy(id, i, u),
        iptu: (id, i, u) => this.svc.upsertIptu(id, i, u),
        deed: (id, i, u) => this.svc.upsertDeed(id, i, u),
        scripture: (id, i, u) => this.svc.upsertScripture(id, i, u),
      };
      await map[scope](id, { attachmentUrl: fileUrl }, u);
      return {
        ok: true,
        url: fileUrl,
        fileName: file.originalname,
        size: file.size,
        scope,
      };
    }

    // Anexo genérico → cria PropertyAttachment
    const att = await this.svc.addAttachment(
      id,
      {
        category: category || 'Outros',
        fileName: file.originalname,
        fileUrl,
        fileSize: file.size,
        mimeType: file.mimetype,
      },
      this.userInfo(req),
    );
    return { ok: true, attachment: att };
  }

  @Delete('attachments/:attachmentId')
  async deleteAttachment(@Req() req: any, @Param('attachmentId') attachmentId: string) {
    this.requireWrite(req);
    return this.svc.deleteAttachment(attachmentId, this.userInfo(req));
  }

}
