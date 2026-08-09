import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PropertiesService } from './properties.service';
import { PropertiesController } from './properties.controller';
import { PropertiesCommercialController } from './properties-commercial.controller';
import { PropertiesCommercialService } from './properties-commercial.service';
import { PropertiesMediaStorageService } from './properties-media-storage.service';
import { PropertiesPublicationService } from './properties-publication.service';
import { PropertiesPublicationWorker } from './properties-publication.worker';
import { PropertiesConstructionController } from './properties-construction.controller';
import { PropertiesConstructionService } from './properties-construction.service';
import { PropertiesConstructionStorageService } from './properties-construction-storage.service';

@Module({
  imports: [PrismaModule],
  controllers: [PropertiesController, PropertiesCommercialController, PropertiesConstructionController],
  providers: [
    PropertiesService,
    PropertiesCommercialService,
    PropertiesMediaStorageService,
    PropertiesPublicationService,
    PropertiesPublicationWorker,
    PropertiesConstructionService,
    PropertiesConstructionStorageService,
  ],
  exports: [PropertiesService, PropertiesCommercialService, PropertiesPublicationService],
})
export class PropertiesModule {}
