import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StoneController } from './stone.controller';
import { StoneService } from './stone.service';

@Module({
  imports: [PrismaModule],
  controllers: [StoneController],
  providers: [StoneService],
  exports: [StoneService],
})
export class StoneModule {}
