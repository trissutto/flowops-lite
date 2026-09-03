import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { RealignmentController } from './realignment.controller';
import { RealignmentService } from './realignment.service';
import { RealignmentShipmentService } from './shipment.service';
import { RealignmentAutoService } from './realignment-auto.service';
import { TriagemService } from './triage.service';
import { ShipmentPdfService } from './shipment-pdf.service';
import { RealignmentReportController } from './realignment-report.controller';
import { RealignmentReportService } from './realignment-report.service';
import { RealignmentPricingService } from './realignment-pricing.service';
import { RemessaEnvioService } from './remessa-envio.service';
import { PromessaEstoqueService } from './promessa-estoque.service';
import { PendenciaExpiryCron } from './pendencia-expiry.cron';
import { CorreiosModule } from '../correios/correios.module';
import { MaisEnviosModule } from '../mais-envios/mais-envios.module';
import { NfeModule } from '../nfe/nfe.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';

/**
 * Nota: dependia de WhatsappModule (disparo de WhatsApp consolidado) até o
 * pivot #168..#172 — agora o alerta chega pela filial via socket, então a
 * integração WhatsApp foi removida e o módulo passa a depender do
 * WebsocketModule pra emitir `realignment:new` e `realignment:sent`.
 */
@Module({
  // CorreiosModule/MaisEnviosModule/NfeModule → envio físico da remessa
  // (etiqueta SEDEX + chave da NF-e 5152 + DANFE no PDF único)
  // WpDbModule saiu daqui (09/2026): a foto da peça vem do `product_photos`
  // (R2) desde que o host do WordPress morreu — nenhum provider deste módulo
  // injeta o WpDbService.
  imports: [AuthModule, PrismaModule, ErpModule, WebsocketModule, CorreiosModule, MaisEnviosModule, NfeModule, WincredMirrorModule],
  controllers: [RealignmentController, RealignmentReportController],
  providers: [
    RealignmentService,
    RealignmentShipmentService,
    RealignmentAutoService,
    TriagemService,
    ShipmentPdfService,
    RealignmentReportService,
    RealignmentPricingService,
    RemessaEnvioService,
    // Trava "peça já prometida" + expiração de pendência velha (24/08)
    PromessaEstoqueService,
    PendenciaExpiryCron,
  ],
  exports: [
    RealignmentService,
    RealignmentShipmentService,
    RealignmentAutoService,
    TriagemService,
    ShipmentPdfService,
    RealignmentReportService,
    RealignmentPricingService,
    // JuntadaService (pick-orders) gera etiqueta/NF da caixa de juntada por aqui
    RemessaEnvioService,
    PromessaEstoqueService,
  ],
})
export class RealignmentModule {}
