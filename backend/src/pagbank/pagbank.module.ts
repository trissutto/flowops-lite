import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagbankService } from './pagbank.service';
import { PagbankController } from './pagbank.controller';

@Module({
  imports: [PrismaModule, HttpModule],
  controllers: [PagbankController],
  providers: [PagbankService],
  exports: [PagbankService],
})
export class PagbankModule {}
