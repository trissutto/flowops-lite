import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { FornecedoresController } from './fornecedores.controller';
import { FornecedoresService } from './fornecedores.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [FornecedoresController],
  providers: [FornecedoresService],
  exports: [FornecedoresService],
})
export class FornecedoresModule {}
