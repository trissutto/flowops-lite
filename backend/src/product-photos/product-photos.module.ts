import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductPhotosController } from './product-photos.controller';
import { ProductPhotosService } from './product-photos.service';
import { CorIaService } from './cor-ia.service';

@Module({
  imports: [PrismaModule, HttpModule, ConfigModule],
  controllers: [ProductPhotosController],
  providers: [ProductPhotosService, CorIaService],
  exports: [ProductPhotosService, CorIaService],
})
export class ProductPhotosModule {}
