import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConveniosAdminController, ConveniosPdvController } from './convenios.controller';
import { ConveniosService } from './convenios.service';

@Module({
  imports: [PrismaModule],
  controllers: [ConveniosAdminController, ConveniosPdvController],
  providers: [ConveniosService],
  exports: [ConveniosService],
})
export class ConveniosModule {}
