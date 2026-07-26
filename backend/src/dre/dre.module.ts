import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DreController } from './dre.controller';
import { DreService } from './dre.service';

@Module({
  imports: [PrismaModule],
  controllers: [DreController],
  providers: [DreService],
  exports: [DreService],
})
export class DreModule {}
