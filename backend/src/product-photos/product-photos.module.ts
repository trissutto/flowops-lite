import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductPhotosController } from './product-photos.controller';
import { ProductPhotosService } from './product-photos.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProductPhotosController],
  providers: [ProductPhotosService],
  exports: [ProductPhotosService],
})
export class ProductPhotosModule {}
