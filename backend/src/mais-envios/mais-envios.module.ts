import { Module } from '@nestjs/common';
import { MaisEnviosController } from './mais-envios.controller';
import { MaisEnviosService } from './mais-envios.service';
import { MaisEnviosAuthService } from './mais-envios-auth.service';

@Module({
  controllers: [MaisEnviosController],
  providers: [MaisEnviosService, MaisEnviosAuthService],
  exports: [MaisEnviosService],
})
export class MaisEnviosModule {}
