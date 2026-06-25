import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { AuthModule } from '../auth/auth.module';
import { ProductRegistrationController } from './product-registration.controller';
import { ProductRegistrationService } from './product-registration.service';

@Module({
  imports: [PrismaModule, ErpModule, AuthModule],
  controllers: [ProductRegistrationController],
  providers: [ProductRegistrationService],
  exports: [ProductRegistrationService],
})
export class ProductRegistrationModule {}
