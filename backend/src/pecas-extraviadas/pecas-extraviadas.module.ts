import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PecasExtraviadasService } from './pecas-extraviadas.service';
import { PecasExtraviadasController } from './pecas-extraviadas.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PecasExtraviadasController],
  providers: [PecasExtraviadasService],
  exports: [PecasExtraviadasService],
})
export class PecasExtraviadasModule {}
