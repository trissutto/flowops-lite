import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OperadorPinService, OperadorUpsert } from './operador-pin.service';

/**
 * /rh/operadores — cadastro de FUNÇÃO + PIN de liberação por operadora (por CPF).
 *
 * Escopo: gerente (user role=store) vê/cadastra só as da SUA loja; matriz vê todas.
 * Segurança: qualquer usuário logado da retaguarda/loja acessa a tela, mas a
 * listagem é filtrada pela loja do JWT (não dá pra ver as de outra loja).
 * NUNCA retorna PIN/hash — só status (tem PIN ou não).
 */
@Controller('rh/operadores')
@UseGuards(JwtAuthGuard)
export class OperadorPinController {
  constructor(private readonly svc: OperadorPinService) {}

  @Get()
  list(@Req() req: any) {
    return this.svc.list({ role: req?.user?.role, storeCode: req?.user?.storeCode });
  }

  @Post()
  upsert(@Req() req: any, @Body() body: OperadorUpsert) {
    // Loja NÃO concede MASTER/SUPREMA — esses níveis são da matriz.
    if (req?.user?.role === 'store' && (body?.nivel === 'MASTER' || body?.nivel === 'SUPREMA')) {
      throw new ForbiddenException('Nível MASTER/SUPREMA só a matriz concede.');
    }
    // Loja força o storeCode do JWT (não deixa cadastrar em nome de outra loja).
    const storeCode =
      req?.user?.role === 'store' && req?.user?.storeCode
        ? req.user.storeCode
        : body?.storeCode;
    return this.svc.upsert({ ...body, storeCode });
  }

  @Post(':cpf/pin')
  setPin(@Param('cpf') cpf: string, @Body() body: { pin: string }) {
    return this.svc.setPin(cpf, String(body?.pin || ''));
  }

  @Post(':cpf/ativo')
  setAtivo(@Param('cpf') cpf: string, @Body() body: { ativo: boolean }) {
    return this.svc.setAtivo(cpf, !!body?.ativo);
  }
}
