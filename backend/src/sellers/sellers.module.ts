import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { PushModule } from '../push/push.module';
import { SellersController } from './sellers.controller';
import { SellersService } from './sellers.service';
import { SellerDocumentsService } from './seller-documents.service';
import { SellersCronService } from './sellers-cron.service';

@Module({
  imports: [AuthModule, PrismaModule, ErpModule, PushModule],
  controllers: [SellersController],
  providers: [SellersService, SellerDocumentsService, SellersCronService],
  exports: [SellersService],
})
export class SellersModule {}
