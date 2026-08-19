import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CustomersAppModule } from '../customers-app/customers-app.module';
import { CloudflareImagesClient } from '../site-media/cloudflare-images.client';
import { PosVendaService } from './pos-venda.service';
import { PontosService } from './pontos.service';
import { PosVendaController } from './pos-venda.controller';
import { AvaliacoesPublicController, PontosClienteController } from './avaliacoes-public.controller';
import { PosVendaConviteCron } from './pos-venda-convite.cron';

/**
 * PÓS-VENDA — convite de avaliação, moderação e pontos.
 *
 * `CustomersAppModule` entra por causa do `CustomerJwtGuard` (a tela "Meus
 * pontos" é da cliente logada). `CloudflareImagesClient` é provido direto: o
 * `SiteMediaModule` não o exporta e o serviço de lá é todo admin-only — a foto
 * da avaliação tem outra credencial (o token do convite) e outra regra.
 */
@Module({
  imports: [PrismaModule, AuthModule, HttpModule, WhatsappModule, CustomersAppModule],
  controllers: [PosVendaController, AvaliacoesPublicController, PontosClienteController],
  providers: [PosVendaService, PontosService, CloudflareImagesClient, PosVendaConviteCron],
  exports: [PosVendaService, PontosService],
})
export class PosVendaModule {}
