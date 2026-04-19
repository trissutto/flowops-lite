import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ErpModule } from '../erp/erp.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [HttpModule, ErpModule, PrismaModule],
  providers: [ProductsService],
  controllers: [ProductsController],
  exports: [ProductsService],
})
export class ProductsModule {}
