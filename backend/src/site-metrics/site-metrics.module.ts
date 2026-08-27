import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SiteMetricsController, SiteMetricsPublicController } from './site-metrics.controller';
import { SiteMetricsService } from './site-metrics.service';
import { MetaAdsService } from './meta-ads.service';
import { GoogleAdsService } from './google-ads.service';
import { GoogleAdsConversaoService } from './google-ads-conversao.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { EvolutionClient } from '../whatsapp-campaign/evolution.client';

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
  /**
   * `WhatsappService` + `EvolutionClient` entram como PROVIDERS, e não pelo
   * import do WhatsappModule — a mesma receita já usada lá dentro pro próprio
   * EvolutionClient, e pelo mesmo motivo: import de módulo novo foi o que
   * fechou um ciclo e derrubou o backend em 07/08. Os dois são stateless o
   * bastante (leem env e Prisma), então a segunda instância não duplica estado.
   * Servem só ao alarme de silêncio da conversão do Google.
   */
  providers: [
    SiteMetricsService,
    MetaAdsService,
    GoogleAdsService,
    GoogleAdsConversaoService,
    WhatsappService,
    EvolutionClient,
  ],
})
export class SiteMetricsModule {}
