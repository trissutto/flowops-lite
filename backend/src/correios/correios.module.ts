import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CorreiosAuthService } from './correios-auth.service';
import { CorreiosService } from './correios.service';
import { CorreiosController } from './correios.controller';

/**
 * Integração com a API dos Correios (CWS — "Meu Correios"), que substitui o
 * SIGEP Web legado. Frete (preço+prazo) + pré-postagem (código de rastreio).
 * Credenciais via env CORREIOS_* (ver correios-auth.service.ts).
 */
@Module({
  imports: [AuthModule],
  controllers: [CorreiosController],
  providers: [CorreiosAuthService, CorreiosService],
  exports: [CorreiosService],
})
export class CorreiosModule {}
