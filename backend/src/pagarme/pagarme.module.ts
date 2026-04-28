import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagarmeService } from './pagarme.service';
import { PagarmeController } from './pagarme.controller';

@Module({
  imports: [PrismaModule, HttpModule],
  controllers: [PagarmeController],
  providers: [PagarmeService],
  exports: [PagarmeService],
})
export class PagarmeModule {}
