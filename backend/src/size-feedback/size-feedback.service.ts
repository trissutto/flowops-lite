import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Serviço de Review por Tamanho ("Cabe em quem veste 48?").
 *
 * Salva feedback da cliente após D+7 da entrega. Agrega na página de produto
 * pra ajudar outras clientes — diferencial real plus size.
 *
 * Não falsifica dados. Não inventa números. Se não tem feedback ainda,
 * a página mostra "Seja a primeira a contar como serviu".
 */
@Injectable()
export class SizeFeedbackService {
  private readonly logger = new Logger(SizeFeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Salva feedback da cliente.
   * Idempotente: 1 review por (customer, product, variation) — unique constraint.
   * Se cliente já tinha review, atualiza.
   */
  async submitFeedback(input: {
    customerId: string;
    productId: number;
    variationId?: number | null;
    orderId?: number | null;
    sizeBought: string;
    sizeUsually?: string | null;
    feedback: 'fits' | 'tight' | 'loose' | 'returned';
    comment?: string | null;
  }) {
    const valid = ['fits', 'tight', 'loose', 'returned'];
    if (!valid.includes(input.feedback)) {
      throw new BadRequestException(`feedback inválido (use: ${valid.join(', ')})`);
    }
    if (!input.sizeBought) {
      throw new BadRequestException('sizeBought obrigatório');
    }

    const data: any = {
      customerId: input.customerId,
      productId: input.productId,
      variationId: input.variationId ?? null,
      orderId: input.orderId ?? null,
      sizeBought: input.sizeBought,
      sizeUsually: input.sizeUsually ?? null,
      feedback: input.feedback,
      comment: input.comment ?? null,
    };

    const result = await (this.prisma as any).sizeFeedback.upsert({
      where: {
        customerId_productId_variationId: {
          customerId: input.customerId,
          productId: input.productId,
          variationId: input.variationId ?? null,
        },
      },
      create: data,
      update: data,
    });

    this.logger.log(
      `[size-feedback] customer=${input.customerId.slice(0, 8)} product=${input.productId} ` +
      `size=${input.sizeBought} (veste ${input.sizeUsually || '?'}) → ${input.feedback}`,
    );

    return result;
  }

  /**
   * Estatísticas pra mostrar na página de produto.
   * Filtra por tamanho que a cliente normalmente veste.
   *
   * Retorno:
   *   {
   *     total: 32,          // total de reviews
   *     fits: 28,           // serviu
   *     tight: 3,           // apertou
   *     loose: 1,           // folgou
   *     returned: 0,        // devolveu
   *     fitsPct: 87,        // % serviu
   *     recommendation: 'buy_size' | 'go_up' | 'go_down' | 'mixed' | 'no_data',
   *   }
   */
  async getStats(productId: number, sizeUsually?: string) {
    const where: any = { productId };
    if (sizeUsually) where.sizeUsually = sizeUsually;

    const reviews = await (this.prisma as any).sizeFeedback.findMany({
      where,
      select: { feedback: true, sizeBought: true },
    });

    const total = reviews.length;
    if (total === 0) {
      return {
        total: 0,
        fits: 0, tight: 0, loose: 0, returned: 0,
        fitsPct: 0,
        recommendation: 'no_data' as const,
      };
    }

    const counts = { fits: 0, tight: 0, loose: 0, returned: 0 };
    for (const r of reviews) {
      const key = r.feedback as keyof typeof counts;
      if (counts[key] !== undefined) counts[key]++;
    }

    const fitsPct = Math.round((counts.fits / total) * 100);

    // Recomendação:
    //   buy_size: >70% serviu → compra o tamanho normal
    //   go_up:    apertaram mais que folgaram E > 30% problema → subir tamanho
    //   go_down:  folgaram mais que apertaram E > 30% problema → descer tamanho
    //   mixed:    sem clareza
    let recommendation: 'buy_size' | 'go_up' | 'go_down' | 'mixed' | 'no_data' = 'mixed';
    if (total < 3) {
      recommendation = 'mixed'; // pouco dado, não recomenda
    } else if (fitsPct >= 70) {
      recommendation = 'buy_size';
    } else if (counts.tight > counts.loose && (counts.tight / total) > 0.3) {
      recommendation = 'go_up';
    } else if (counts.loose > counts.tight && (counts.loose / total) > 0.3) {
      recommendation = 'go_down';
    }

    return {
      total,
      fits: counts.fits,
      tight: counts.tight,
      loose: counts.loose,
      returned: counts.returned,
      fitsPct,
      recommendation,
    };
  }

  /**
   * Lista produtos do cliente que ainda não receberam feedback.
   * Usado pelo trigger D+7 que abre tela de coleta.
   *
   * Retorna pedidos finalizados/entregues há ≥7 dias E ≤30 dias
   * que não têm feedback ainda.
   */
  async getPendingReviews(customerId: string) {
    // TODO: integrar com OrderApp pra pegar pedidos elegíveis
    // por enquanto, retorna vazio — tela usa lista do app direto
    return [];
  }
}
