import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { EtiquetaConfigService } from './etiqueta-config.service';

/**
 * /etiqueta-config — parametros visuais persistidos da etiqueta de produto.
 * GET   → retorna config salva (ou defaults)
 * POST  → atualiza (merge parcial). Salva no Postgres pra sobreviver a deploys.
 * POST /reset → volta pra defaults.
 */
@Controller('etiqueta-config')
@UseGuards(JwtAuthGuard)
export class EtiquetaConfigController {
  constructor(private readonly svc: EtiquetaConfigService) {}

  @Get()
  read() {
    return this.svc.read();
  }

  @Post()
  write(@Body() body: any) {
    return this.svc.write(body || {});
  }

  @Post('reset')
  reset() {
    return this.svc.reset();
  }
}
