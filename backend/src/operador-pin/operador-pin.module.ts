import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OperadorPinService } from './operador-pin.service';
import { OperadorPinController } from './operador-pin.controller';

@Module({
  imports: [PrismaModule],
  controllers: [OperadorPinController],
  providers: [OperadorPinService],
  exports: [OperadorPinService],
})
export class OperadorPinModule {}
