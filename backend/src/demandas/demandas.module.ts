import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DemandasController } from './demandas.controller';

@Module({
  imports: [PrismaModule],
  controllers: [DemandasController],
})
export class DemandasModule {}
