import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WhatsappCampaignService } from './whatsapp-campaign.service';

/**
 * CAMPANHA DE WHATSAPP — retaguarda (`/retaguarda/whatsapp-campanhas`).
 * Tudo atrás do JWT: disparo é ação de operadora logada.
 */
@Controller('whatsapp-campanhas')
@UseGuards(JwtAuthGuard)
export class WhatsappCampaignController {
  constructor(private readonly service: WhatsappCampaignService) {}

  /** A tela chama no load: Evolution está ligado/conectado? */
  @Get('status')
  status() {
    return this.service.status();
  }

  /** Quantas pessoas caem no público escolhido (antes de criar a campanha). */
  @Get('segmento/previa')
  previewSegmento(@Query() q: any) {
    return this.service.previewSegmento({
      de: q.de || null,
      ate: q.ate || null,
      apenasMulheres: q.apenasMulheres === 'true' || q.apenasMulheres === '1',
      limite: Number(q.limite) || 50,
    });
  }

  /** Prévia: manda 1 mensagem pro número informado (teste do dono). */
  @Post('previa')
  previa(@Body() b: { fone: string; mensagem: string; imagemUrl?: string | null }) {
    return this.service.previa(b.fone, b.mensagem, b.imagemUrl);
  }

  /** Cria a campanha (e já inicia se `iniciar=true`). */
  @Post()
  criar(@Body() b: any) {
    return this.service.criarCampanha(b);
  }

  @Get()
  listar() {
    return this.service.listar();
  }

  @Get(':id')
  detalhe(@Param('id') id: string) {
    return this.service.detalhe(id);
  }

  /** acao = iniciar | pausar | retomar | cancelar */
  @Post(':id/:acao')
  acao(@Param('id') id: string, @Param('acao') acao: string) {
    return this.service.acao(id, acao);
  }
}
