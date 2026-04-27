import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { PdvService } from './pdv.service';
import { PdvController } from './pdv.controller';
import { PixService } from './pix.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [PdvController],
  providers: [PdvService, PixService],
  exports: [PdvService, PixService],
})
export class PdvModule {}
