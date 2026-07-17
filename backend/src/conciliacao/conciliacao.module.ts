import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConciliacaoController } from './conciliacao.controller';
import { ConciliacaoService } from './conciliacao.service';

@Module({
  imports: [PrismaModule],
  controllers: [ConciliacaoController],
  providers: [ConciliacaoService],
  exports: [ConciliacaoService],
})
export class ConciliacaoModule {}
