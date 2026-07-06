import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AccessPolicyService, AccessPolicyUpdate } from './access-policy.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';

/**
 * /admin/access-policy — matriz configura faixas de desconto + senhas por nível.
 * NUNCA retorna a senha em claro — só o status (tem no banco / tem no env).
 */
@Controller('admin/access-policy')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class AccessPolicyController {
  constructor(private readonly svc: AccessPolicyService) {}

  @Get()
  async get() {
    return this.svc.getStatus();
  }

  @Post()
  async set(@Body() body: AccessPolicyUpdate) {
    return this.svc.update(body);
  }
}

/**
 * /pdv/discount-policy — só as FAIXAS (sem senha), pra o PDV decidir qual prompt
 * mostrar. Qualquer usuário logado (loja) pode ler.
 */
@Controller('pdv/discount-policy')
@UseGuards(JwtAuthGuard)
export class DiscountPolicyController {
  constructor(private readonly svc: AccessPolicyService) {}

  @Get()
  async get() {
    return this.svc.getThresholds();
  }
}
