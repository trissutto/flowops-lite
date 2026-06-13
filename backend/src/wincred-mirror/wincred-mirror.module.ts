import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WincredMirrorService } from './wincred-mirror.service';
import { WincredMirrorController } from './wincred-mirror.controller';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [WincredMirrorController],
  providers: [WincredMirrorService],
  exports: [WincredMirrorService],
})
export class WincredMirrorModule {}
