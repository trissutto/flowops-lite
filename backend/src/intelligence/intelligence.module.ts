import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { IntelligenceService } from './intelligence.service';
import { IntelligenceController } from './intelligence.controller';

@Module({
  imports: [PrismaModule, ErpModule, WincredMirrorModule, CommissionsModule],
  controllers: [IntelligenceController],
  providers: [IntelligenceService],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
