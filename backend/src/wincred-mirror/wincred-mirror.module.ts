import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WincredMirrorService } from './wincred-mirror.service';
import { WincredMirrorController } from './wincred-mirror.controller';
import { WincredMirrorCron } from './wincred-mirror.cron';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [WincredMirrorController],
  providers: [WincredMirrorService, WincredMirrorCron],
  exports: [WincredMirrorService],
})
export class WincredMirrorModule {}
