import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PropertiesService } from './properties.service';
import { PropertiesController } from './properties.controller';
import { PropertiesCommercialController } from './properties-commercial.controller';
import { PropertiesCommercialService } from './properties-commercial.service';
import { PropertiesMediaStorageService } from './properties-media-storage.service';
import { PropertiesPublicationService } from './properties-publication.service';
import { PropertiesPublicationWorker } from './properties-publication.worker';

@Module({
  imports: [PrismaModule],
  controllers: [PropertiesController, PropertiesCommercialController],
  providers: [
    PropertiesService,
    PropertiesCommercialService,
    PropertiesMediaStorageService,
    PropertiesPublicationService,
    PropertiesPublicationWorker,
  ],
  exports: [PropertiesService, PropertiesCommercialService, PropertiesPublicationService],
})
export class PropertiesModule {}
