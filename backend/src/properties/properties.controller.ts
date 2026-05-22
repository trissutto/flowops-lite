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
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PropertiesService } from './properties.service';
import { put } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';

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
  constructor(
    private readonly svc: PropertiesService,
    // JwtService usado SÓ pelo /upload-token (validação manual, ver método).
    private readonly jwtSvc: JwtService,
  ) {}

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
   * Upload de arquivo via multipart/form-data → grava no Vercel Blob → cria
   * PropertyAttachment automaticamente. Usado pelo dropzone do frontend.
   *
   * Body (form-data):
   *   file: arquivo (PDF, JPG, PNG, etc) — máximo 10MB
   *   category: string (opcional, default 'Outros')
   *
   * Requer env BLOB_READ_WRITE_TOKEN configurada no Railway.
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

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new BadRequestException(
        'BLOB_READ_WRITE_TOKEN não configurado no servidor. Configure no Railway.',
      );
    }

    // Sanitiza filename (Vercel Blob aceita unicode mas tira espaços/caracteres especiais)
    const safeName = file.originalname
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const blobPath = `imobiliario/${id}/${Date.now()}-${safeName}`;

    let uploaded: any;
    try {
      uploaded = await put(blobPath, file.buffer, {
        access: 'public',
        contentType: file.mimetype,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
    } catch (e: any) {
      throw new BadRequestException(`Falha ao subir pro Vercel Blob: ${e?.message || e}`);
    }

    // Se for upload pra uma SEÇÃO específica (water, energy, iptu, etc), atualiza
    // attachmentUrl da seção em vez de criar PropertyAttachment solto
    if (scope && ['water', 'energy', 'iptu', 'deed', 'scripture'].includes(scope)) {
      const u = this.userInfo(req);
      const map: Record<string, (id: string, input: any, user: any) => Promise<any>> = {
        water: (id, i, u) => this.svc.upsertWater(id, i, u),
        energy: (id, i, u) => this.svc.upsertEnergy(id, i, u),
        iptu: (id, i, u) => this.svc.upsertIptu(id, i, u),
        deed: (id, i, u) => this.svc.upsertDeed(id, i, u),
        scripture: (id, i, u) => this.svc.upsertScripture(id, i, u),
      };
      await map[scope](id, { attachmentUrl: uploaded.url }, u);
      return {
        ok: true,
        url: uploaded.url,
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
        fileUrl: uploaded.url,
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

  /**
   * POST /:id/upload-token
   *
   * Endpoint do FLUXO MODERNO de upload (handleUpload).
   *
   * Por que esse endpoint existe (e não o /upload tradicional):
   *  - O Vercel Blob mudou de modelo: stores configurados como "Private"
   *    (necessário pra documentos sensíveis como contas, contratos, escrituras)
   *    REJEITAM uploads server-side via put() com access: 'public'.
   *  - O padrão oficial pra store privado é usar handleUpload:
   *      1. Frontend pede um "token assinado" pro backend (aqui)
   *      2. Backend valida usuário/permissões e assina uma URL temporária
   *      3. Frontend faz upload DIRETO pro Vercel Blob com essa URL
   *      4. Vercel chama de volta o backend (onUploadCompleted) pra registrar
   *         o blob.url no banco
   *
   * Vantagens vs /upload tradicional:
   *  - Funciona com store privado (nosso caso)
   *  - Upload não passa pelo Railway (mais rápido, menos largura de banda)
   *  - Não temos limite de 4.5 MB do Lambda (Vercel Functions tem; Railway não,
   *    mas igual a gente fica liberado pra arquivos maiores)
   *
   * Atenção: onUploadCompleted RODA EM REQUEST SEPARADA. Não tem acesso ao
   * `req` original — toda info que precisa pra gravar no banco vem do
   * `tokenPayload` que assinamos no onBeforeGenerateToken.
   */
  @Post(':id/upload-token')
  // OVERRIDE do guard do controller: essa rota NÃO usa JwtAuthGuard porque
  // o helper `upload()` do @vercel/blob/client não permite passar header
  // Authorization custom. JWT é validado MANUALMENTE no onBeforeGenerateToken,
  // vindo no clientPayload mandado pelo frontend.
  @UseGuards()
  async uploadToken(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: HandleUploadBody,
  ) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new BadRequestException(
        'BLOB_READ_WRITE_TOKEN não configurado no servidor. Configure no Railway.',
      );
    }

    // ADAPTER: @vercel/blob/client handleUpload espera um Request do Web Standard
    // (com método headers.get(name)), mas o NestJS com Express dá um req com
    // headers como objeto. Sem esse adapter, o handleUpload internamente faz
    // `request.headers.get(...)` e quebra com TypeError → vira "Failed to
    // retrieve the client token" no frontend.
    const adaptedRequest: any = {
      headers: {
        get: (name: string) => {
          const v = req.headers[String(name).toLowerCase()];
          if (Array.isArray(v)) return v[0] || null;
          return (v as string) || null;
        },
      },
      url: req.url,
      method: req.method,
    };

    try {
      const jsonResponse = await handleUpload({
        body,
        request: adaptedRequest as any,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          // Parse do payload mandado pelo frontend (scope, category, authToken)
          let meta: any = {};
          try {
            meta = clientPayload ? JSON.parse(clientPayload) : {};
          } catch {
            meta = {};
          }

          // ── VALIDAÇÃO MANUAL DE JWT ──
          // O frontend manda o JWT dentro do clientPayload porque o helper
          // upload() não suporta header Authorization. Aqui validamos.
          const authToken = meta.authToken;
          if (!authToken) {
            throw new Error('Token de autenticação ausente no clientPayload');
          }
          let decoded: any;
          try {
            decoded = this.jwtSvc.verify(authToken);
          } catch (e: any) {
            throw new Error(`Token inválido ou expirado: ${e?.message || 'verify failed'}`);
          }

          // Confere role (mesma lógica do requireWrite)
          const role = decoded?.role;
          const allowed = ['admin', 'imobiliario_admin', 'imobiliario_user'];
          if (!allowed.includes(role)) {
            throw new Error('Sem permissão de escrita no imobiliário');
          }

          // tokenPayload é o que VOLTA pro backend no onUploadCompleted.
          // Como onUploadCompleted roda em REQUEST SEPARADA (sem req auth),
          // metemos aqui tudo que vamos precisar pra gravar no banco.
          return {
            allowedContentTypes: [
              'application/pdf',
              'image/png',
              'image/jpeg',
              'image/jpg',
              'image/webp',
            ],
            maximumSizeInBytes: 10 * 1024 * 1024, // 10 MB
            addRandomSuffix: false, // já temos timestamp no pathname
            tokenPayload: JSON.stringify({
              propertyId: id,
              userId: decoded?.sub || decoded?.id || null,
              userName: decoded?.email || decoded?.name || null,
              scope: meta.scope || null,
              category: meta.category || 'Outros',
              fileName: meta.fileName || pathname.split('/').pop() || 'arquivo',
            }),
          };
        },
        onUploadCompleted: async ({ blob, tokenPayload }) => {
          // Esse callback é chamado pelo Vercel quando o upload do client
          // termina. Não tem acesso ao req — toda info vem do tokenPayload.
          let meta: any = {};
          try {
            meta = tokenPayload ? JSON.parse(tokenPayload) : {};
          } catch {
            meta = {};
          }
          const propertyId = meta.propertyId;
          const scope = meta.scope;
          const userForLog = { id: meta.userId, name: meta.userName };

          if (
            scope &&
            ['water', 'energy', 'iptu', 'deed', 'scripture'].includes(scope)
          ) {
            const map: Record<string, (id: string, input: any, user: any) => Promise<any>> = {
              water: (id, i, u) => this.svc.upsertWater(id, i, u),
              energy: (id, i, u) => this.svc.upsertEnergy(id, i, u),
              iptu: (id, i, u) => this.svc.upsertIptu(id, i, u),
              deed: (id, i, u) => this.svc.upsertDeed(id, i, u),
              scripture: (id, i, u) => this.svc.upsertScripture(id, i, u),
            };
            await map[scope](propertyId, { attachmentUrl: blob.url }, userForLog);
          } else {
            // Anexo genérico — cria PropertyAttachment
            await this.svc.addAttachment(
              propertyId,
              {
                category: meta.category || 'Outros',
                fileName: meta.fileName || 'arquivo',
                fileUrl: blob.url,
                fileSize: 0, // Vercel não manda size no callback
                mimeType: blob.contentType || 'application/octet-stream',
              },
              userForLog,
            );
          }
        },
      });
      return jsonResponse;
    } catch (e: any) {
      throw new BadRequestException(
        `Falha ao gerar token de upload: ${e?.message || e}`,
      );
    }
  }
}
