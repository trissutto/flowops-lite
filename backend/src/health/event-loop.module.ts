import { Global, Module } from '@nestjs/common';
import { EventLoopService } from './event-loop.service';

/**
 * GLOBAL de propósito: o vigia do event loop precisa ser injetável em
 * qualquer serviço suspeito (catálogo, WhatsApp, pool do WordPress) sem que
 * cada módulo tenha de importar o de saúde — o que criaria dependência
 * circular com quem o módulo de saúde já lê.
 *
 * Nada aqui depende de banco ou de rede: é um `setInterval` e dois
 * contadores. Pode subir antes de tudo.
 */
@Global()
@Module({
  providers: [EventLoopService],
  exports: [EventLoopService],
})
export class EventLoopModule {}
