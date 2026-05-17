import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';

// @TODO_VALIDATE_VS_LOJA — confira esses paths contra o flowops do PC.
// Se algum service estiver com nome/local diferente, ajustar aqui.
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AuthModule } from '../auth/auth.module';

import { LiveController } from './live.controller';
import { MetaWebhookController } from './meta-webhook.controller';
import { InboxController } from './inbox.controller';

import { LiveService } from './live.service';
import { MetaService } from './meta.service';
import { CommentParserService } from './comment-parser.service';
import { ReservationService } from './reservation.service';
import { ReservationExpiryCron } from './reservation-expiry.cron';
import { AiAgentService } from './ai-agent.service';
import { LiveRealtimeGateway } from './live-realtime.gateway';
import { LiveBroadcasterService } from './live-broadcaster.service';
import { InboxService } from './inbox.service';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    ScheduleModule.forRoot(),
    PrismaModule,
    ErpModule,
    WooCommerceModule,
    WhatsappModule,
    AuthModule,
  ],
  controllers: [LiveController, MetaWebhookController, InboxController],
  providers: [
    LiveService,
    MetaService,
    CommentParserService,
    ReservationService,
    ReservationExpiryCron,
    AiAgentService,
    LiveRealtimeGateway,
    LiveBroadcasterService,
    InboxService,
  ],
  exports: [LiveService, ReservationService, MetaService, InboxService],
})
export class LiveModule {}
