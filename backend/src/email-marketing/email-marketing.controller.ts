import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { EmailMarketingService } from './email-marketing.service';

/**
 * DISPARO DE E-MAIL PELO FLOWOPS — retaguarda (`/retaguarda/email-marketing`).
 * Tudo atrás do JWT: campanha é ação de operadora logada.
 */
@Controller('email-marketing')
@UseGuards(JwtAuthGuard)
export class EmailMarketingController {
  constructor(private readonly service: EmailMarketingService) {}

  /** A tela chama no load pra saber se o Mautic está conectado. */
  @Get('status')
  status() {
    return this.service.status();
  }

  /** Segmentos do Mautic pro seletor de público. */
  @Get('segmentos')
  segmentos() {
    return this.service.segmentos();
  }

  /** Pedidos que vieram do e-mail (utm_source=email), contados no nosso banco. */
  @Get('resultados')
  resultados(@Query('de') de?: string, @Query('ate') ate?: string) {
    return this.service.resultados(de, ate);
  }

  /** Prévia no e-mail de teste (nosso SES) — não toca no Mautic. */
  @Post('previa')
  previa(@Body() body: { destino: string; assunto: string; corpo: string; cupom?: string | null; imagemUrl?: string | null; linkDestino?: string | null }) {
    return this.service.enviarPrevia(body);
  }

  /** Dispara (ou agenda) a campanha pro segmento escolhido. */
  @Post('enviar')
  enviar(
    @Body() body: { segmentoId: number; assunto: string; corpo: string; cupom?: string | null; agendarPara?: string | null; imagemUrl?: string | null; linkDestino?: string | null },
  ) {
    return this.service.enviarCampanha(body);
  }
}
