/**
 * /pix-publico — endpoints PÚBLICOS (SEM auth) pra cliente acessar PIX via link.
 *
 * Fluxo:
 *  1. Vendedora gera link pra cliente que vai pagar remoto (não veio na loja)
 *  2. Manda URL https://flowops-lite.vercel.app/pix/[baixaId] pelo WhatsApp
 *  3. Cliente abre, vê QR Code, copia/escaneia, paga
 *  4. Página faz polling de status — mostra "PAGO!" quando confirmar
 *  5. Backend executa baixa Giga automática (já existente)
 *
 * Segurança: o ID da baixa é UUID v4 (não enumeable). Não retorna dados
 * sensíveis (CPF parcial, telefone parcial). PIX em si tem validade
 * configurada (default 24h).
 */

import { BadRequestException, Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { CrediarioBaixaService } from './crediario-baixa.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('pix-publico')
export class CrediarioBaixaPublicController {
  constructor(
    private readonly svc: CrediarioBaixaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /pix-publico/:baixaId
   * Retorna info do PIX pra renderizar a página pública.
   */
  @Get(':baixaId')
  async getPixInfo(@Param('baixaId') baixaId: string) {
    if (!baixaId || baixaId.length < 30) {
      throw new BadRequestException('ID inválido');
    }
    const baixa: any = await (this.prisma as any).crediarioBaixa.findUnique({
      where: { id: baixaId },
      include: { items: { orderBy: { vencimento: 'asc' } } },
    });
    if (!baixa) throw new NotFoundException('Cobrança não encontrada');
    if (baixa.formaPagamento !== 'pix') {
      throw new BadRequestException('Essa baixa não é PIX');
    }

    // Busca QR Code — tenta PagBank PRIMEIRO (default no createPixForCrediario)
    // depois Pagar.me como fallback. Antes (bug jun/2026): so buscava em
    // pagarmePayment, retornava null pra PIX gerado via PagBank, cliente
    // abria o link e nao via QR.
    let qrCodeText: string | null = null;
    let qrCodeImageUrl: string | null = null;
    let expiresAt: Date | null = null;
    // 1) PagBank (preferido)
    try {
      const pb: any = await (this.prisma as any).pagbankPayment.findFirst({
        where: { saleId: baixaId },
        orderBy: { createdAt: 'desc' },
      });
      if (pb) {
        qrCodeText = pb.qrCodeText || null;
        qrCodeImageUrl = pb.qrCodeImageB64
          ? 'data:image/png;base64,' + pb.qrCodeImageB64
          : null;
        expiresAt = pb.expiresAt;
      }
    } catch { /* segue pra fallback */ }
    // 2) Pagar.me (fallback)
    if (!qrCodeText && baixa.pagarmeOrderId) {
      try {
        const pp: any = await (this.prisma as any).pagarmePayment.findUnique({
          where: { pagarmeOrderId: baixa.pagarmeOrderId },
        });
        if (pp) {
          qrCodeText = pp.qrCodeText;
          qrCodeImageUrl = pp.qrCodeImageUrl;
          expiresAt = pp.expiresAt;
        }
      } catch { /* ignora */ }
    }

    // Anonimiza dados sensíveis (mostra parcial)
    const customerName = baixa.customerName
      ? maskName(baixa.customerName)
      : 'Cliente';

    return {
      baixaId: baixa.id,
      status: baixa.status,
      isPaid: baixa.status === 'paid',
      customerName,
      lojaCode: baixa.lojaCode,
      lojaName: baixa.lojaName,
      totalParcelas: baixa.totalParcelas,
      totalPrincipal: baixa.totalPrincipal,
      totalJuros: baixa.totalJuros,
      totalPago: baixa.totalPago,
      paidAt: baixa.paidAt,
      createdAt: baixa.createdAt,
      qrCodeText,
      qrCodeImageUrl,
      expiresAt,
      items: baixa.items.map((it: any) => ({
        numeroPromis: it.numeroPromis,
        parcelaNum: it.parcelaNum,
        totalParcelas: it.totalParcelas,
        vencimento: it.vencimento,
        valorParcela: it.valorParcela,
        jurosCalculado: it.jurosCalculado,
        valorPago: it.valorPago,
      })),
    };
  }

  /** Polling leve — só status + isPaid */
  @Get(':baixaId/status')
  async getStatus(@Param('baixaId') baixaId: string) {
    if (!baixaId || baixaId.length < 30) {
      throw new BadRequestException('ID inválido');
    }
    return this.svc.getBaixaStatus(baixaId);
  }
}

/** Máscara: "MARIA APARECIDA SILVA" → "MARIA A. S." */
function maskName(full: string): string {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const initials = parts.slice(1).map((p) => `${p[0]}.`).join(' ');
  return `${first} ${initials}`;
}
