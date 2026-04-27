import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { PdvService } from './pdv.service';
import { PdvController } from './pdv.controller';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [PdvController],
  providers: [PdvService],
  exports: [PdvService],
})
export class PdvModule {}
