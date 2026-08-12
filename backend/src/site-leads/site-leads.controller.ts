import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { LeadInput, SiteLeadsService } from './site-leads.service';

/**
 * PÚBLICO — o popup do cupom na vitrine. Sem token, como o resto de
 * /public/loja: é formulário aberto na internet.
 */
@Controller('public/loja/lead')
export class SiteLeadsPublicController {
  constructor(private readonly svc: SiteLeadsService) {}

  @Post()
  registrar(@Body() body: LeadInput) {
    /**
     * ARMADILHA DE ROBÔ: o formulário tem um campo "sobrenome" escondido por
     * CSS. Gente não vê e não preenche; robô que varre o HTML preenche tudo.
     * Respondemos OK e jogamos fora — dizer "recusado" ensinaria o robô a
     * tentar de novo sem o campo.
     */
    if (String(body?.sobrenome ?? '').trim()) {
      return { ok: true, cupom: null };
    }
    return this.svc.registrar(body || {});
  }
}

/**
 * RETAGUARDA — /retaguarda/leads. Só quem tem token: é lista de contato de
 * gente real (nome, celular e e-mail), não conteúdo de vitrine.
 */
@Controller('site-leads')
@UseGuards(JwtAuthGuard)
export class SiteLeadsController {
  constructor(private readonly svc: SiteLeadsService) {}

  @Get()
  listar(@Query() q: any) {
    return this.svc.listar({
      de: q.de,
      ate: q.ate,
      busca: q.busca,
      limite: q.limite ? Number(q.limite) : undefined,
    });
  }
}
