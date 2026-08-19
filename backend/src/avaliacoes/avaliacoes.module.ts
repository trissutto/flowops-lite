import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersAppModule } from '../customers-app/customers-app.module';
import { AvaliacoesService } from './avaliacoes.service';
import { AvaliacoesConfigService } from './avaliacoes-config.service';
import { AvaliacoesFotosService } from './avaliacoes-fotos.service';
import { AvaliacoesController } from './avaliacoes.controller';
import { AvaliacoesPublicController } from './avaliacoes-public.controller';
import { AvaliacoesAdminController } from './avaliacoes-admin.controller';

// CustomersAppModule entra pelo CustomerJwtGuard (e pelo JwtModule que ele
// exporta) — mesma dependência do SizeFeedbackModule. Nada aqui importa o
// serviço da conta: quem precisa contar avaliação pendente é o
// ContaResumoModule, e é ele que depende dos dois.
@Module({
  imports: [PrismaModule, CustomersAppModule],
  controllers: [AvaliacoesController, AvaliacoesPublicController, AvaliacoesAdminController],
  providers: [AvaliacoesService, AvaliacoesConfigService, AvaliacoesFotosService],
  exports: [AvaliacoesService, AvaliacoesConfigService, AvaliacoesFotosService],
})
export class AvaliacoesModule {}
