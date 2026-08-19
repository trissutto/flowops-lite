import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CustomerJwtGuard } from '../customers-app/customer-jwt.guard';
import { AvaliacoesService } from './avaliacoes.service';
import { AvaliacoesFotosService } from './avaliacoes-fotos.service';

/**
 * CENTRO DE AVALIAÇÃO da cliente — /customers/app/avaliacoes.
 *
 * Mesmo guard do resto da conta (JWT scope customer). Nenhuma rota aqui
 * aceita `accountId` no corpo: quem a cliente é sai do token, sempre.
 */
@Controller('customers/app/avaliacoes')
@UseGuards(CustomerJwtGuard)
export class AvaliacoesController {
  constructor(
    private readonly svc: AvaliacoesService,
    private readonly fotos: AvaliacoesFotosService,
  ) {}

  /** GET — a tela inteira: pendentes, avaliadas, saldo e as regras de pontos. */
  @Get()
  async centro(@Req() req: any) {
    return this.svc.centro(req.customer.id);
  }

  /** GET /pontos — saldo + extrato (o placar da tela). */
  @Get('pontos')
  async pontos(@Req() req: any) {
    return this.svc.pontos(req.customer.id);
  }

  /** POST — envia (ou corrige) a avaliação de uma peça comprada. */
  @Post()
  async criar(@Req() req: any, @Body() body: any) {
    return this.svc.criar(req.customer.id, body || {});
  }

  /** POST /resgatar — { pontos } vira um cupom nominal, só do CPF dela. */
  @Post('resgatar')
  async resgatar(@Req() req: any, @Body() body: any) {
    return this.svc.resgatar(req.customer.id, Number(body?.pontos) || 0);
  }

  /**
   * POST /foto — sobe UMA foto e devolve a URL.
   *
   * O formulário sobe cada foto no momento em que a cliente escolhe, e só
   * manda as URLs no envio final: assim a foto pesada não viaja de novo se
   * ela errar uma estrela, e o campo de texto nunca perde o que foi digitado.
   */
  @Post('foto')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  async foto(@Req() req: any, @UploadedFile() file: any) {
    return this.fotos.upload(req.customer.id, file);
  }
}
