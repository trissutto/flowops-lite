import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Service de LINKING automático Customer ↔ CustomerAccount.
 *
 * Usado:
 *   - Pelo ETL Giga sempre que importa Customer novo (precisa saber se
 *     já tem CustomerAccount com mesmo CPF).
 *   - Por job de reconciliação (varre Customer sem link e tenta vincular).
 *   - Pelo PDV se vendedora cadastrar cliente novo durante venda.
 *
 * Lógica:
 *   1) Recebe customerId (acabou de ser criado/atualizado)
 *   2) Acha o CPF do Customer
 *   3) Procura CustomerAccount pelo mesmo CPF
 *   4) Se existir e ainda não estiver linkado → cria link
 *   5) Se NÃO existir account → não faz nada (cliente não usa app ainda)
 *
 * Idempotente: chamar várias vezes não duplica vínculos (UNIQUE no schema).
 */
@Injectable()
export class CustomerLinkingService {
  private readonly logger = new Logger(CustomerLinkingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tenta vincular UM Customer específico a um CustomerAccount existente
   * (se houver um com mesmo CPF). Retorna info sobre o que aconteceu.
   */
  async autoLinkByCustomer(customerId: string): Promise<{
    linked: boolean;
    accountId?: string;
    reason?: string;
  }> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, cpf: true },
    });

    if (!customer) return { linked: false, reason: 'customer não encontrado' };
    if (!customer.cpf) return { linked: false, reason: 'sem CPF' };

    const account = await this.prisma.customerAccount.findUnique({
      where: { cpf: customer.cpf },
      select: { id: true },
    });

    if (!account) {
      return { linked: false, reason: 'sem CustomerAccount com esse CPF' };
    }

    // Cria link (UNIQUE garante idempotência)
    try {
      await this.prisma.customerAccountLink.create({
        data: {
          accountId: account.id,
          customerId: customer.id,
          isPrimary: false, // novo link nunca é primary (já tem o original)
        },
      });
      this.logger.log(
        `Linkado Customer ${customer.id} → Account ${account.id} (CPF ${customer.cpf})`,
      );
      return { linked: true, accountId: account.id };
    } catch (err: any) {
      // P2002 = link já existia (ok)
      if (err?.code === 'P2002') {
        return { linked: false, accountId: account.id, reason: 'já linkado' };
      }
      throw err;
    }
  }

  /**
   * Job de reconciliação — varre TODOS os Customer com CPF que não estão
   * linkados em nenhum CustomerAccount, e linka onde houver match.
   *
   * Roda manualmente OU via cron noturno. Retorna stats.
   */
  async reconcileAll(): Promise<{
    scanned: number;
    linked: number;
    skipped: number;
  }> {
    const accounts = await this.prisma.customerAccount.findMany({
      select: { id: true, cpf: true },
    });
    if (accounts.length === 0) {
      return { scanned: 0, linked: 0, skipped: 0 };
    }

    let linked = 0;
    let skipped = 0;
    let scanned = 0;

    // Pra cada account, acha Customers com mesmo CPF sem link ainda
    for (const acc of accounts) {
      const candidates = await this.prisma.customer.findMany({
        where: {
          cpf: acc.cpf,
          // NOT exists link com este account
          accountLinks: { none: { accountId: acc.id } },
        },
        select: { id: true },
      });

      scanned += candidates.length;

      if (candidates.length === 0) continue;

      try {
        await this.prisma.customerAccountLink.createMany({
          data: candidates.map((c) => ({
            accountId: acc.id,
            customerId: c.id,
            isPrimary: false,
          })),
          skipDuplicates: true,
        });
        linked += candidates.length;
      } catch (err: any) {
        skipped += candidates.length;
        this.logger.warn(
          `reconcile falhou pra account ${acc.id}: ${err?.message || err}`,
        );
      }
    }

    this.logger.log(
      `Reconcile: ${scanned} candidatos, ${linked} vinculados, ${skipped} skipped`,
    );
    return { scanned, linked, skipped };
  }
}
