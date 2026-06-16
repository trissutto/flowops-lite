import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { PontoService } from './ponto.service';

/**
 * Rotas do ponto eletronico.
 *
 * Cadastro de rosto (admin/operador):
 *   POST   /ponto/face/enroll/:sellerId   { descriptors: number[][], snapshot?: base64 }
 *   DELETE /ponto/face/:sellerId          remove cadastro facial
 *
 * Bater ponto (PDV ou PWA):
 *   GET  /ponto/face/descriptors/:storeId  retorna descriptors da loja (pro matching local)
 *   POST /ponto/registrar                  cria batida (timestamp = servidor)
 *
 * Espelho/relatorios (admin):
 *   GET /ponto/espelho?sellerId=&ano=&mes=
 *   GET /ponto/espelho/loja?storeId=&ano=&mes=
 *   GET /ponto/ultimos/:sellerId?limit=N
 *
 * Correcao manual (admin):
 *   POST /ponto/justificar/:registroId  { justificativa }
 *   POST /ponto/manual                  { sellerId, storeId, tipo, timestamp, justificativa }
 */
@UseGuards(JwtAuthGuard)
@Controller('ponto')
export class PontoController {
  constructor(private readonly svc: PontoService) {}

  private currentUser(req: any): string | null {
    return req?.user?.id || req?.user?.sub || req?.user?.email || null;
  }

  // ── FACE ENROLL ───────────────────────────────────────────────
  @Post('face/enroll/:sellerId')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  enroll(
    @Param('sellerId') sellerId: string,
    @Body() body: { descriptors: number[][]; snapshot?: string },
  ) {
    return this.svc.enrollFace(sellerId, body.descriptors, body.snapshot);
  }

  @Delete('face/:sellerId')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  clearFace(@Param('sellerId') sellerId: string) {
    return this.svc.clearFace(sellerId);
  }

  // ── BATER PONTO ───────────────────────────────────────────────

  /**
   * Retorna descriptors faciais das vendedoras ATIVAS de uma loja.
   * Usado pelo PDV ao montar a tela /pdv/ponto. Sem AdminOnly — qualquer
   * usuario autenticado da loja pode puxar (PDV roda como user store).
   */
  @Get('face/descriptors/:storeId')
  descriptors(@Param('storeId') storeId: string) {
    return this.svc.listDescriptorsForStore(storeId);
  }

  /**
   * Body: { sellerId, storeId, tipo, source, faceConfidence?, snapshot?, lat?, lng? }
   * source: 'face_pdv' | 'pwa_selfie' | 'manual_admin'
   * tipo:   'entrada' | 'saida_almoco' | 'volta_almoco' | 'saida'
   */
  @Post('registrar')
  registrar(
    @Body()
    body: {
      sellerId: string;
      storeId: string;
      tipo: string;
      source?: string;
      faceConfidence?: number;
      snapshot?: string;
      lat?: number;
      lng?: number;
      observacoes?: string;
    },
    @Req() req: any,
  ) {
    if (!body?.sellerId || !body?.storeId || !body?.tipo) {
      throw new BadRequestException('sellerId, storeId e tipo são obrigatórios');
    }
    const ip =
      req?.headers?.['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
      req?.ip ||
      null;
    return this.svc.registrar({
      sellerId: body.sellerId,
      storeId: body.storeId,
      tipo: body.tipo,
      source: body.source || 'face_pdv',
      faceConfidence: body.faceConfidence,
      snapshotBase64: body.snapshot,
      lat: body.lat,
      lng: body.lng,
      ip,
      observacoes: body.observacoes,
    });
  }

  // ── ESPELHO ───────────────────────────────────────────────────

  @Get('espelho')
  espelho(
    @Query('sellerId') sellerId: string,
    @Query('ano') ano?: string,
    @Query('mes') mes?: string,
  ) {
    if (!sellerId) throw new BadRequestException('sellerId obrigatório');
    const now = new Date();
    const a = ano ? Number(ano) : now.getFullYear();
    const m = mes ? Number(mes) : now.getMonth() + 1;
    return this.svc.getEspelhoMensal(sellerId, a, m);
  }

  @Get('espelho/loja')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  espelhoLoja(
    @Query('storeId') storeId: string,
    @Query('ano') ano?: string,
    @Query('mes') mes?: string,
  ) {
    if (!storeId) throw new BadRequestException('storeId obrigatório');
    const now = new Date();
    const a = ano ? Number(ano) : now.getFullYear();
    const m = mes ? Number(mes) : now.getMonth() + 1;
    return this.svc.getEspelhoStore(storeId, a, m);
  }

  @Get('ultimos/:sellerId')
  ultimos(
    @Param('sellerId') sellerId: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listLast(sellerId, limit ? Number(limit) : 20);
  }

  // ── CORRECAO MANUAL ──────────────────────────────────────────

  @Post('justificar/:registroId')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  justificar(
    @Param('registroId') registroId: string,
    @Body() body: { justificativa: string },
    @Req() req: any,
  ) {
    if (!body?.justificativa) {
      throw new BadRequestException('justificativa obrigatória');
    }
    return this.svc.justificar(
      registroId,
      body.justificativa,
      this.currentUser(req) ?? undefined,
    );
  }

  @Post('manual')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  manual(
    @Body()
    body: {
      sellerId: string;
      storeId: string;
      tipo: string;
      timestamp: string;
      justificativa: string;
    },
    @Req() req: any,
  ) {
    if (!body?.sellerId || !body?.storeId || !body?.tipo || !body?.timestamp) {
      throw new BadRequestException(
        'sellerId, storeId, tipo e timestamp são obrigatórios',
      );
    }
    return this.svc.criarManual({
      ...body,
      userId: this.currentUser(req) || undefined,
    });
  }
}
