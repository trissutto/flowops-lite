import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { WpDbModule } from '../wp-db/wp-db.module';
import { ProductPhotosController } from './product-photos.controller';
import { PixelController } from './pixel.controller';
import { ProductPhotosService } from './product-photos.service';
import { CorIaService } from './cor-ia.service';
import { WcFotosImportService } from './wc-fotos-import.service';
import { BolinhaAutoService } from './bolinha-auto.service';
import { AutoPublicarService } from './auto-publicar.service';

@Module({
  imports: [PrismaModule, HttpModule, ConfigModule, WpDbModule],
  controllers: [ProductPhotosController, PixelController],
  providers: [ProductPhotosService, CorIaService, WcFotosImportService, BolinhaAutoService, AutoPublicarService],
  exports: [ProductPhotosService, CorIaService, WcFotosImportService, BolinhaAutoService, AutoPublicarService],
})
export class ProductPhotosModule {}
