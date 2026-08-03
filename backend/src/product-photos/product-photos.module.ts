import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductPhotosController } from './product-photos.controller';
import { ProductPhotosService } from './product-photos.service';
import { CorIaService } from './cor-ia.service';
import { WcFotosImportService } from './wc-fotos-import.service';

@Module({
  imports: [PrismaModule, HttpModule, ConfigModule],
  controllers: [ProductPhotosController],
  providers: [ProductPhotosService, CorIaService, WcFotosImportService],
  exports: [ProductPhotosService, CorIaService, WcFotosImportService],
})
export class ProductPhotosModule {}
