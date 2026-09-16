import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConferenciaTicketsService } from './conferencia-tickets.service';

/**
 * /public/conferencia-tickets — sem login, de propósito:
 *  - `envio/:token` é o celular da operadora (QR da abertura do caixa). O
 *    token é aleatório, vale 36h e só deixa MANDAR foto e ver o andamento —
 *    nenhum dado de venda ou de cliente sai por aqui;
 *  - `foto/:id` é a imagem pra `<img>` da retaguarda, com link assinado de 1h.
 */

const JANELA_MS = 10 * 60_000;
const LIMITES = { envio: 240, consulta: 600 } as const;
const batidas = new Map<string, number[]>();

function ipDe(req: any): string {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '');
  return (fwd.split(',')[0] || req?.ip || req?.socket?.remoteAddress || 'desconhecido').trim();
}

function segurar(req: any, tipo: keyof typeof LIMITES) {
  const agora = Date.now();
  const chave = `${tipo}|${ipDe(req)}`;
  const lista = (batidas.get(chave) || []).filter((t) => agora - t < JANELA_MS);
  if (lista.length >= LIMITES[tipo]) {
    batidas.set(chave, lista);
    throw new HttpException('Muitas tentativas. Espere alguns minutos e tente de novo.', HttpStatus.TOO_MANY_REQUESTS);
  }
  lista.push(agora);
  batidas.set(chave, lista);
  if (batidas.size > 5_000) {
    for (const [k, v] of batidas) if (!v.some((t) => agora - t < JANELA_MS)) batidas.delete(k);
  }
}

@Controller('public/conferencia-tickets')
export class ConferenciaTicketsPublicoController {
  constructor(private readonly svc: ConferenciaTicketsService) {}

  @Get('envio/:token')
  async estado(@Req() req: any, @Param('token') token: string) {
    segurar(req, 'consulta');
    const lote = await this.svc.loteDoToken(token);
    return this.svc.estadoDoLote(lote.id);
  }

  @Post('envio/:token/fotos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async enviar(@Req() req: any, @Param('token') token: string, @UploadedFile() file: any) {
    segurar(req, 'envio');
    const lote = await this.svc.loteDoToken(token);
    return this.svc.receberFoto(lote, file, 'celular', 'celular da loja');
  }

  @Post('envio/:token/terminei')
  async terminei(@Req() req: any, @Param('token') token: string) {
    segurar(req, 'envio');
    const lote = await this.svc.loteDoToken(token);
    return this.svc.finalizar(lote.id, 'celular da loja');
  }

  @Get('foto/:id')
  async foto(
    @Req() req: any,
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: any,
  ) {
    segurar(req, 'consulta');
    const { buffer, mime } = await this.svc.imagemAssinada(id, exp, sig);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  }
}
