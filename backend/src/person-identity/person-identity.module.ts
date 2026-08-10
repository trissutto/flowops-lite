import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PersonIdentityService } from './person-identity.service';

@Module({
  imports: [PrismaModule],
  providers: [PersonIdentityService],
  exports: [PersonIdentityService],
})
export class PersonIdentityModule {}
