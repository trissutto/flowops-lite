import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ProductRegistrationController } from './product-registration.controller';
import { ProductRegistrationService } from './product-registration.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [ProductRegistrationController],
  providers: [ProductRegistrationService],
  exports: [ProductRegistrationService],
})
export class ProductRegistrationModule {}
