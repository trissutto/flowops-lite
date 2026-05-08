import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagarmeService } from './pagarme.service';
import { PagarmeController } from './pagarme.controller';
import { CrediariosModule } from '../crediarios/crediarios.module';

@Module({
  imports: [PrismaModule, HttpModule, forwardRef(() => CrediariosModule)],
  controllers: [PagarmeController],
  providers: [PagarmeService],
  exports: [PagarmeService],
})
export class PagarmeModule {}
