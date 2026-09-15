import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PromoConfigService } from './promo-config.service';
import { PromoCampanhaService } from './promo-campanha.service';
import { PromoConfigController } from './promo-config.controller';

/**
 * Promoções automáticas (campanha por termo) — config, exceções e a régua.
 *
 * Módulo FOLHA de propósito: só Prisma. Quem depende dele são o catálogo
 * (mostra o preço), os pedidos e a trava do carrinho (cobram), a troca de peça
 * e o PDV — módulos que não podem passar a se importar por causa disto. Aresta
 * nova no grafo já derrubou o boot em 07/08 (ciclo Pagbank→Pdv→Crediarios→
 * Pagbank); aqui não há como fechar ciclo, porque este módulo não importa
 * nenhum deles.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PromoConfigController],
  providers: [PromoConfigService, PromoCampanhaService],
  exports: [PromoConfigService, PromoCampanhaService],
})
export class PromoConfigModule {}
