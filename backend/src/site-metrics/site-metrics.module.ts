import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SiteMetricsController, SiteMetricsPublicController } from './site-metrics.controller';
import { SiteMetricsService } from './site-metrics.service';

/**
 * MÉTRICA DOS BOTÕES DA LOJA — dado nosso, não do Google.
 *
 * Nasceu em 13/08/2026. A página /lojas do site novo tinha "Como chegar",
 * WhatsApp, Instagram e telefone em 14 unidades, e NENHUM deles disparava
 * evento — nem pro GA4. O botão que mais aproxima cliente de loja física era o
 * único sem medida.
 *
 * Podia ter sido só GA4, mas o dono escolheu gravar aqui: o dado fica no nosso
 * Postgres, a tela mora na retaguarda junto com o resto, e não depende de cota
 * de API nem da amostragem do Google. Mesma lógica de "o Flow é a fonte da
 * verdade" que já vale pro estoque.
 *
 * O evento continua indo pro GA4 em paralelo — este módulo não substitui o
 * tracking do site, só garante uma cópia que é nossa.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SiteMetricsPublicController, SiteMetricsController],
  providers: [SiteMetricsService],
})
export class SiteMetricsModule {}
