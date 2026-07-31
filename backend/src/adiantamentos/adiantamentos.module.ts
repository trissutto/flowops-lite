import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdiantamentosService } from './adiantamentos.service';

@Module({
  imports: [PrismaModule],
  providers: [AdiantamentosService],
  exports: [AdiantamentosService],
})
export class AdiantamentosModule {}
