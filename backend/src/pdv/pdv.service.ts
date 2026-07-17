import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { startOfDayBR, startOfNextDayBR, startOfDayBRFromYmd, endOfDayBRFromYmd } from '../lib/date-br';
import { ErpService } from '../erp/erp.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { CashService } from './cash.service';
import { NfceService } from './nfce.service';
import { PromoConfigService } from '../promo-config/promo-config.service';
import { AccessPolicyService } from '../access-policy/access-policy.service';
import { validateMinLevel } from '../auth/auth-levels.util';
import * as crypto from 'crypto';

/**
 * PdvService — frente de caixa (MVP).
 *
 * Fluxo:
 *   1. createSale(storeCode) → abre venda OPEN
 *   2. addItem(saleId, sku/ean) → busca produto Giga + adiciona snapshot
 *   3. updateItemQty / removeItem (se vendedora errou)
 *   4. finalize(saleId, payment) → status=finalized + (futuro) emite NFC-e
 *   5. cancel(saleId) → status=cancelled
 *
 * NFC-e: por enquanto STUB (gera XML preview mas não envia SEFAZ).
 * Pra emitir de verdade, integrar com FocusNFe/WebMania OU implementar
 * cliente SEFAZ direto (Fase 3).
 */
@Injectable()
export class PdvService {
  private readonly logger = new Logger(PdvService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly catalog: WincredCatalogService,
    private readonly cash: CashService,
    private readonly nfce: NfceService,
    private readonly promoConfig: PromoConfigService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  /**
   * Conjunto de REFs (normalizadas TRIM+UPPER) classificadas como BÁSICO
   * dentre as informadas. Usado pela promoção 50% pra pular peças básicas.
   * Retorna Set vazio se a tabela não existir ou der erro (fail-open).
   */
  private async basicoRefsIn(refs: string[]): Promise<Set<string>> {
    const norm = (r: any) => String(r || '').trim().toUpperCase();
    const wanted = Array.from(new Set(refs.map(norm).filter(Boolean)));
    if (!wanted.length) return new Set();
    try {
      const rows = await (this.prisma as any).productClassification.findMany({
        where: { ref: { in: wanted }, tipoProduto: 1 },
        select: { ref: true },
      });
      return new Set((rows as any[]).map((r) => norm(r.ref)));
    } catch (e: any) {
      this.logger.warn(`[pdv] lookup básico falhou (fail-open): ${e?.message}`);
      return new Set();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VENDA — ciclo de vida
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Cria nova venda OPEN. Vendedora pode ter várias OPEN simultâneas
   * (ex: troca enquanto outra cliente espera).
   */
  async createSale(input: {
    storeCode: string;
    storeId?: string;
    vendedorUserId?: string;
    vendedorName?: string;
    sellerId?: string;
    sellerName?: string;
    /** MODO TREINAMENTO — quando true, venda inteira é "fake" pra prática */
    isTraining?: boolean;
  }) {
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');
    const store = await this.prisma.store.findUnique({
      where: { code: input.storeCode },
      select: { code: true, name: true },
    });
    if (!store) throw new BadRequestException(`Loja ${input.storeCode} não cadastrada`);

    // Vincula a sessão de caixa atual (se houver). Ainda permite criar
    // venda sem caixa aberto (rascunho), mas finalize() vai exigir.
    const cashSession = await this.cash.getCurrentSession(store.code);

    const sale = await (this.prisma as any).pdvSale.create({
      data: {
        storeCode: store.code,
        storeName: store.name,
        cashSessionId: cashSession?.id || null,
        vendedorUserId: input.vendedorUserId || null,
        vendedorName: input.vendedorName || null,
        sellerId: input.sellerId || null,
        sellerName: input.sellerName || null,
        status: 'open',
        isTraining: !!input.isTraining,
      },
    });
    return sale;
  }

  /**
   * Atribui ou troca a vendedora (Seller) responsável pela venda.
   * Pode ser feito a qualquer momento ANTES do finalize.
   */
  async setSeller(input: { saleId: string; sellerId: string | null }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    if (!input.sellerId) {
      return (this.prisma as any).pdvSale.update({
        where: { id: input.saleId },
        data: { sellerId: null, sellerName: null },
      });
    }
    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: input.sellerId },
      select: { id: true, name: true, active: true },
    });
    if (!seller) throw new BadRequestException('Vendedora não encontrada');
    if (!seller.active) throw new BadRequestException('Vendedora inativa');
    return (this.prisma as any).pdvSale.update({
      where: { id: input.saleId },
      data: { sellerId: seller.id, sellerName: seller.name },
    });
  }

  /**
   * MASTER: cancela uma venda zumbi (finalizada SEM payment) — fluxo de
   * limpeza pos-bug. Apenas muda status pra 'cancelled' + audit log.
   *
   * NAO mexe em estoque (peca ja saiu na compra real "irma" — re-incrementar
   * causaria estoque inflado).
   * NAO mexe em payments (nao tem).
   * NAO mexe em marcado.
   *
   * Pre-requisitos validados:
   *  - venda existe
   *  - status atual = 'finalized'
   *  - payments.length === 0 (so cancela zumbi de verdade)
   *
   * Idempotente: se ja cancelada, retorna OK sem fazer nada.
   */
  async masterCancelZumbi(input: {
    saleId: string;
    motivo: string;
    userName: string;
  }) {
    const { saleId, motivo, userName } = input;
    if (!saleId) throw new BadRequestException('saleId obrigatorio');
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe motivo (>=3 chars)');
    }

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      include: { payments: true, items: { select: { id: true, sku: true, total: true } } },
    });
    if (!sale) throw new NotFoundException('Venda nao encontrada');

    if (sale.status === 'cancelled') {
      return { ok: true, alreadyDone: true, saleId, message: 'Venda ja estava cancelada' };
    }
    if (sale.status !== 'finalized') {
      throw new BadRequestException(
        `So pode cancelar venda finalizada. Status atual: ${sale.status}. ` +
        `Pra venda aberta, use cancelar normal.`,
      );
    }
    if ((sale.payments || []).length > 0) {
      throw new BadRequestException(
        `Venda tem ${sale.payments.length} pagamento(s) registrado(s) — NAO eh zumbi. ` +
        `Cancelar afetaria a conciliacao. Operacao bloqueada por seguranca.`,
      );
    }

    await (this.prisma as any).pdvSale.update({
      where: { id: saleId },
      data: { status: 'cancelled' },
    });

    this.logger.warn(
      `[MASTER] CANCEL-ZUMBI saleId=${saleId} total=R$${sale.total} ` +
      `items=${(sale.items || []).length} motivo="${motivo}" por ${userName}`,
    );

    return {
      ok: true,
      saleId,
      totalCancelado: Number(sale.total || 0),
      qtdItens: (sale.items || []).length,
      message: 'Venda cancelada. Estoque NAO foi mexido (peca ja saiu na compra real).',
    };
  }

  /**
   * Cancela venda DUPLICADA — mesmo COM pagamento registrado.
   * Caso real: vendedora bateu venda 2x antes de imprimir cupom.
   * Diferente de zumbi: a venda tem pagamento mas é uma cópia da outra.
   * Estoque NAO é alterado (assume que só uma das vendas teve peça baixada de verdade
   * via NF emitida; ou se ambas baixaram, isso vira tarefa de reconciliação manual).
   */
  /**
   * ESTORNO COMPLETO de venda finalizada — usado pelo botão "ESTORNAR"
   * da tela /retaguarda/faturamento (drill-down).
   *
   * Diferente do masterCancelDuplicada: este AQUI tenta REVERTER tudo:
   *   1. Cancela NFC-e na SEFAZ se autorizada (chama nfce.cancel)
   *   2. Reverte estoque no Wincred (gravarVendaPdv com qty negativa)
   *   3. Marca cashback ganho como REVOGADO (cliente perde o cashback gerado)
   *   4. Marca a sale como cancelled
   *   5. Logger detalhado pra auditoria
   *
   * Cada passo é tentado independentemente — se um falhar, os outros seguem.
   * Retorna relatório do que funcionou e do que precisa ação manual.
   *
   * Requer:
   *   - senha master (validada no controller via validateMinLevel)
   *   - motivo (>= 5 chars)
   *
   * Atenção: NÃO consegue estornar pagamento de cartão fisicamente. Vendedora
   * precisa fazer estorno manual na maquininha. O relatório avisa.
   */
  async masterEstornarVenda(input: {
    saleId: string;
    motivo: string;
    userName: string;
  }) {
    const { saleId, motivo, userName } = input;
    if (!saleId) throw new BadRequestException('saleId obrigatório');
    if (!motivo || motivo.trim().length < 5) {
      throw new BadRequestException('Informe motivo (≥5 chars)');
    }

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      include: {
        payments: true,
        items: true,
      },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');

    if (sale.status === 'cancelled') {
      return {
        ok: true,
        alreadyDone: true,
        saleId,
        message: 'Venda já estava cancelada',
        passos: [],
      };
    }

    if (sale.status !== 'finalized') {
      throw new BadRequestException(`Venda no status ${sale.status} — só pode estornar finalizada`);
    }

    const passos: Array<{
      passo: string;
      status: 'ok' | 'falhou' | 'pulado' | 'atencao';
      detalhe: string;
    }> = [];

    /* ─── PASSO 1: Cancelar NFC-e na SEFAZ se autorizada ─── */
    if (sale.nfceStatus === 'authorized' && !sale.nfceCanceladaEm) {
      try {
        const r = await this.nfce.cancel(saleId, `Estorno: ${motivo}`.slice(0, 250));
        if (r?.success) {
          passos.push({
            passo: 'NFC-e SEFAZ',
            status: 'ok',
            detalhe: `Cancelada. Protocolo cancelamento: ${r.nProtCancelamento || '—'}`,
          });
        } else {
          passos.push({
            passo: 'NFC-e SEFAZ',
            status: 'falhou',
            detalhe: r?.motivo || r?.error || 'SEFAZ rejeitou cancelamento. Verifique janela 30min.',
          });
        }
      } catch (e: any) {
        passos.push({
          passo: 'NFC-e SEFAZ',
          status: 'falhou',
          detalhe: `Erro ao cancelar: ${e?.message || String(e)}`,
        });
      }
    } else if (sale.nfceCanceladaEm) {
      passos.push({ passo: 'NFC-e SEFAZ', status: 'pulado', detalhe: 'Já cancelada antes' });
    } else {
      passos.push({ passo: 'NFC-e SEFAZ', status: 'pulado', detalhe: 'NFC-e não foi autorizada (skip)' });
    }

    /* ─── PASSO 2: Cancelar venda no Wincred (some do faturamento) ─── */
    if (!sale.isTraining) {
      try {
        const r = await (this.erp as any).marcarVendaWincredCancelada({
          saleId,
          storeCode: sale.storeCode,
        });
        if (r?.ok) {
          passos.push({
            passo: 'Venda Wincred',
            status: 'ok',
            detalhe: `Marcada como cancelada (${r.affected ?? 0} linhas). Some do faturamento.`,
          });
        } else {
          passos.push({
            passo: 'Venda Wincred',
            status: 'falhou',
            detalhe: `Não removeu do Wincred: ${r?.error || 'erro desconhecido'}. Marque manual!`,
          });
        }
      } catch (e: any) {
        passos.push({
          passo: 'Venda Wincred',
          status: 'falhou',
          detalhe: `Erro: ${e?.message || String(e)}`,
        });
      }
    } else {
      passos.push({
        passo: 'Venda Wincred',
        status: 'pulado',
        detalhe: 'Modo treinamento',
      });
    }

    /* ─── PASSO 2b: Devolver estoque Wincred (qty negativa) ─── */
    if (sale.stockDecreasedAt && !sale.isTraining) {
      try {
        await this.erp.gravarVendaPdv({
          storeCode: sale.storeCode,
          items: sale.items.map((it: any) => ({
            sku: String(it.sku || it.ean || ''),
            qty: -Math.abs(Number(it.qty) || 1),
            valorUnit: Number(it.precoUnit) || 0,
            desconto: 0,
            descricao: String(it.descricao || ''),
          })),
          pagamentos: [{ metodo: 'estorno', valor: -Math.abs(Number(sale.total) || 0) }],
          obsPedido: `estorno-${saleId.slice(0, 8)}`,
        } as any);
        passos.push({
          passo: 'Estoque Wincred',
          status: 'ok',
          detalhe: `${sale.items.length} item(ns) devolvido(s) ao estoque`,
        });
      } catch (e: any) {
        passos.push({
          passo: 'Estoque Wincred',
          status: 'falhou',
          detalhe: `Erro ao reverter: ${e?.message || String(e)}. Faça manual!`,
        });
      }
    } else {
      passos.push({
        passo: 'Estoque Wincred',
        status: 'pulado',
        detalhe: sale.isTraining ? 'Modo treinamento' : 'Estoque não foi baixado',
      });
    }

    /* ─── PASSO 3: Revogar cashback ganho ─── */
    if (sale.customerCpf && !sale.isTraining) {
      try {
        const cpfDigits = String(sale.customerCpf).replace(/\D/g, '');
        const totalCents = Math.round(Number(sale.total || 0) * 100);
        const cashbackGerado = Math.floor(totalCents * 0.10); // 10% padrão
        if (cashbackGerado > 0) {
          // Procura a conta unificada
          const acc = await (this.prisma as any).customerAccount.findUnique({
            where: { cpf: cpfDigits.length === 11 ? `${cpfDigits.slice(0,3)}.${cpfDigits.slice(3,6)}.${cpfDigits.slice(6,9)}-${cpfDigits.slice(9)}` : cpfDigits },
            select: { id: true, cashbackBalanceCents: true, cashbackEarnedCents: true },
          }) || await (this.prisma as any).customerAccount.findUnique({
            where: { cpf: cpfDigits },
            select: { id: true, cashbackBalanceCents: true, cashbackEarnedCents: true },
          });
          if (acc) {
            await (this.prisma as any).customerAccount.update({
              where: { id: acc.id },
              data: {
                cashbackBalanceCents: Math.max(0, (acc.cashbackBalanceCents || 0) - cashbackGerado),
                cashbackEarnedCents: { decrement: BigInt(cashbackGerado) },
              },
            });
            passos.push({
              passo: 'Cashback cliente',
              status: 'ok',
              detalhe: `Revogados R$ ${(cashbackGerado / 100).toFixed(2)} do cliente`,
            });
          } else {
            passos.push({
              passo: 'Cashback cliente',
              status: 'pulado',
              detalhe: 'Cliente não tem conta no app — nada a revogar',
            });
          }
        } else {
          passos.push({ passo: 'Cashback cliente', status: 'pulado', detalhe: 'Sem cashback gerado' });
        }
      } catch (e: any) {
        passos.push({
          passo: 'Cashback cliente',
          status: 'falhou',
          detalhe: `Erro: ${e?.message || String(e)}`,
        });
      }
    } else {
      passos.push({ passo: 'Cashback cliente', status: 'pulado', detalhe: 'Venda sem CPF' });
    }

    /* ─── PASSO 4: Aviso sobre pagamentos cartão ─── */
    const temCartao = (sale.payments || []).some((p: any) =>
      ['credito', 'debito', 'cartao'].includes(String(p.method || '').toLowerCase()),
    );
    if (temCartao) {
      passos.push({
        passo: 'Pagamento cartão',
        status: 'atencao',
        detalhe: '⚠️ Estorno do cartão é MANUAL na maquininha (Stone/PagBank). Faça lá pessoalmente.',
      });
    }

    /* ─── PASSO 5: Marca a sale como cancelada ─── */
    await (this.prisma as any).pdvSale.update({
      where: { id: saleId },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: `[ESTORNO MASTER] ${motivo} — por ${userName}`,
      } as any,
    });
    passos.push({ passo: 'Status venda', status: 'ok', detalhe: 'Marcada como cancelled' });

    /* ─── Log final ─── */
    this.logger.warn(
      `[MASTER ESTORNO] saleId=${saleId} loja=${sale.storeCode} total=R$${sale.total} ` +
      `cliente=${sale.customerCpf || 'avulso'} motivo="${motivo}" por ${userName} ` +
      `— passos: ${passos.map(p => `${p.passo}:${p.status}`).join(' | ')}`,
    );

    return {
      ok: true,
      saleId,
      totalEstornado: Number(sale.total || 0),
      passos,
      message: `Estorno concluído. ${passos.filter(p => p.status === 'falhou').length} falha(s). Veja os passos abaixo.`,
      precisaAcaoManual: passos.some(p => p.status === 'falhou' || p.status === 'atencao'),
    };
  }

  async masterCancelDuplicada(input: {
    saleId: string;
    motivo: string;
    userName: string;
  }) {
    const { saleId, motivo, userName } = input;
    if (!saleId) throw new BadRequestException('saleId obrigatorio');
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe motivo (>=3 chars)');
    }

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      include: { payments: true, items: { select: { id: true, sku: true, total: true } } },
    });
    if (!sale) throw new NotFoundException('Venda nao encontrada');

    if (sale.status === 'cancelled') {
      return { ok: true, alreadyDone: true, saleId, message: 'Venda ja estava cancelada' };
    }

    // Bloqueia se venda já tem NFC-e emitida (precisa cancelar cupom fiscal antes via SEFAZ)
    if (sale.nfceStatus === 'autorizada' && !sale.nfceCanceladaEm) {
      throw new BadRequestException(
        'Venda tem NFC-e autorizada. Cancela o cupom fiscal primeiro (SEFAZ) e depois exclui.',
      );
    }

    await (this.prisma as any).pdvSale.update({
      where: { id: saleId },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: `[DUPLICADA] ${motivo} — por ${userName}`,
      } as any,
    });

    this.logger.warn(
      `[MASTER] CANCEL-DUPLICADA saleId=${saleId} total=R$${sale.total} ` +
      `payments=${(sale.payments || []).length} items=${(sale.items || []).length} motivo="${motivo}" por ${userName}`,
    );

    return {
      ok: true,
      saleId,
      totalCancelado: Number(sale.total || 0),
      qtdPagamentos: (sale.payments || []).length,
      qtdItens: (sale.items || []).length,
      message: 'Venda duplicada cancelada. NFC-e nao foi afetada — verifica no caixa se precisa estornar o pagamento manualmente.',
    };
  }

  /**
   * Lê venda + itens + pagamentos parciais (com totais sempre atualizados).
   */
  async getSale(id: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    return sale;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SPLIT PAYMENT — múltiplas formas por venda
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Soma o valor já pago (todos os pagamentos parciais).
   * PUBLIC (jun/2026): controller usa pra calcular residual do crediário.
   */
  async sumPaidValue(saleId: string, excludeMethods: string[] = []): Promise<number> {
    const where: any = { saleId };
    if (excludeMethods.length > 0) {
      where.method = { notIn: excludeMethods };
    }
    const payments = await (this.prisma as any).pdvSalePayment.findMany({
      where,
      select: { valor: true },
    });
    return (payments as any[]).reduce((s, p) => s + (p.valor || 0), 0);
  }

  /**
   * Adiciona um pagamento parcial à venda.
   * Pode ser um único pagamento (R$ 153,10 dinheiro) ou parte de split
   * (R$ 100 dinheiro + R$ 53,10 PIX em 2 chamadas).
   */
  async addPayment(input: {
    saleId: string;
    method: string;
    valor: number;
    details?: any;
  }) {
    if (!input.method) throw new BadRequestException('method obrigatório');
    if (!input.valor || input.valor <= 0) throw new BadRequestException('valor deve ser > 0');

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true, total: true, customerCpf: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    // Crediário precisa de cliente
    if (input.method === 'crediario' && !sale.customerCpf) {
      throw new BadRequestException('Crediário exige CPF do cliente');
    }

    // VENDA ONLINE — pagamento já recebido por fora (PIX direto / link externo).
    // CPF obrigatório pra rastreabilidade (cliente sempre identificado em venda
    // online de WhatsApp/Instagram). NFC-e NÃO é emitida automaticamente —
    // venda online geralmente não exige nota.
    if (input.method === 'venda_online' && !sale.customerCpf) {
      throw new BadRequestException(
        'Venda online exige CPF do cliente. Identifique a cliente antes de fechar.',
      );
    }

    // VALE-TROCA: valida o código antes de aceitar como pagamento.
    // Confere existe, não usado, não vencido e tem saldo >= valor.
    if (input.method === 'vale_troca') {
      const code = String(input.details?.creditoCode || '').trim().toUpperCase();
      if (!code) throw new BadRequestException('Código TROCA-XXXXX obrigatório');
      const ret = await (this.prisma as any).pdvReturn.findUnique({
        where: { creditoCode: code },
      });
      if (!ret) throw new BadRequestException(`Vale-troca ${code} não encontrado`);
      // GUARD TREINO: vale gerado em devolução de TREINAMENTO não vale
      // dinheiro — bloqueia uso em venda real (em venda de treino, passa).
      if (ret.isTraining) {
        const saleVale = await (this.prisma as any).pdvSale.findUnique({
          where: { id: input.saleId },
          select: { isTraining: true },
        });
        if (!saleVale?.isTraining) {
          throw new BadRequestException(
            `Vale-troca ${code} foi gerado em MODO TREINAMENTO — não vale como pagamento real.`,
          );
        }
      }
      if (ret.status === 'used') {
        throw new BadRequestException(
          `Vale-troca ${code} já foi usado em ${ret.creditoUsadoAt ? new Date(ret.creditoUsadoAt).toLocaleString('pt-BR') : 'data desconhecida'}`,
        );
      }
      // Vale anulado (ex: residual cujo vale original voltou num cancelamento)
      // não pode ser reusado — senão vira duplo crédito.
      if (ret.status === 'cancelled' || ret.status === 'anulado') {
        throw new BadRequestException(
          `Vale-troca ${code} foi anulado e não vale mais como pagamento.`,
        );
      }
      if (ret.creditoValidade && new Date(ret.creditoValidade).getTime() < Date.now()) {
        throw new BadRequestException(
          `Vale-troca ${code} venceu em ${new Date(ret.creditoValidade).toLocaleDateString('pt-BR')}`,
        );
      }
      const valorVale = Number(ret.valorTotal) || 0;
      if (input.valor > valorVale + 0.01) {
        throw new BadRequestException(
          `Vale-troca ${code} tem saldo R$ ${valorVale.toFixed(2)}, não dá pra cobrir R$ ${input.valor.toFixed(2)}`,
        );
      }
      // GUARD ANTI-USO-DUPLO: vale-troca é cupom de uso ÚNICO.
      // Busca QUALQUER pdvSalePayment com esse código em vendas ATIVAS
      // (open ou finalized). Se já aplicado em OUTRA venda → bloqueia.
      // (Status do pdvReturn só vira used no finalize; entre addPayment e
      // finalize, o code fica amarrado no payment.details — essa busca cobre
      // esse intervalo crítico onde 2 PDVs poderiam usar o mesmo vale.)
      // PERF: filtra no BANCO por `details contains code` (details é String/Text
      // com JSON serializado — o código TROCA-XXXXX aparece literal no texto).
      // Antes carregava a tabela INTEIRA de payments vale_troca e filtrava em JS.
      // mode insensitive garante superset do filtro JS (que faz toUpperCase).
      // A validação JS abaixo continua como confirmação (parse + compare exato).
      const outrasOcorrencias = await (this.prisma as any).pdvSalePayment.findMany({
        where: {
          method: 'vale_troca',
          details: { contains: code, mode: 'insensitive' },
        },
        select: { id: true, saleId: true, details: true, sale: { select: { status: true } } },
      });
      for (const p of outrasOcorrencias as any[]) {
        let codeDet = '';
        try {
          const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
          codeDet = String(det?.creditoCode || '').trim().toUpperCase();
        } catch { continue; }
        if (codeDet !== code) continue;
        // Mesmo código encontrado
        if (p.saleId !== input.saleId) {
          const outroStatus = p.sale?.status;
          // Venda cancelada → libera (vale ficou solto, pode reusar)
          if (outroStatus === 'cancelled') continue;
          throw new BadRequestException(
            `Vale-troca ${code} já foi aplicado em outra venda (status: ${outroStatus || 'desconhecido'}). ` +
              `Cupom de uso único — não pode ser duplicado.`,
          );
        }
        // Mesma venda → não pode 2x
        throw new BadRequestException(`Vale-troca ${code} já foi adicionado nessa venda`);
      }
    }

    // Não deixa pagar mais que o total
    const jaPago = await this.sumPaidValue(input.saleId);
    const restante = sale.total - jaPago;
    const valor = Math.round(input.valor * 100) / 100;
    if (valor > restante + 0.001) {
      throw new BadRequestException(
        `Valor R$${valor.toFixed(2)} maior que o restante R$${restante.toFixed(2)}`,
      );
    }

    const payment = await (this.prisma as any).pdvSalePayment.create({
      data: {
        saleId: input.saleId,
        method: input.method,
        valor,
        details: input.details ? JSON.stringify(input.details) : null,
      },
    });

    return payment;
  }

  /**
   * AJUSTE DE PAGAMENTO — só admin/supervisor.
   * Permite trocar forma, valor, bandeira de um pagamento (incluindo de venda
   * já FINALIZADA). Toda alteração é auditada em PdvPaymentAudit.
   */
  async updatePayment(input: {
    saleId: string;
    paymentId: string;
    method?: string;
    valor?: number;
    details?: any;
    reason: string;
    changedByUserId?: string;
    changedByUserName?: string;
    changedByRole?: string;
  }) {
    if (!input.reason || input.reason.trim().length < 3) {
      throw new BadRequestException('Razão obrigatória (mínimo 3 caracteres)');
    }
    const payment = await (this.prisma as any).pdvSalePayment.findUnique({
      where: { id: input.paymentId },
    });
    if (!payment || payment.saleId !== input.saleId) {
      throw new NotFoundException('Pagamento não encontrado nessa venda');
    }
    // NÃO bloqueia por status — supervisor pode ajustar venda finalizada.

    const newMethod = input.method ?? payment.method;
    const newValor = input.valor !== undefined
      ? Math.round(input.valor * 100) / 100
      : payment.valor;
    const newDetailsJson = input.details !== undefined
      ? JSON.stringify(input.details)
      : payment.details;

    if (newValor <= 0) {
      throw new BadRequestException('Valor deve ser > 0');
    }

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { total: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    const allPayments = await (this.prisma as any).pdvSalePayment.findMany({
      where: { saleId: input.saleId },
    });
    const somaOutros = (allPayments as any[])
      .filter((p) => p.id !== input.paymentId)
      .reduce((s, p) => s + (Number(p.valor) || 0), 0);
    if (somaOutros + newValor > sale.total + 0.01) {
      throw new BadRequestException(
        `Soma dos pagamentos R$${(somaOutros + newValor).toFixed(2)} ultrapassa total R$${sale.total.toFixed(2)}`,
      );
    }

    await (this.prisma as any).pdvPaymentAudit.create({
      data: {
        paymentId: input.paymentId,
        saleId: input.saleId,
        oldMethod: payment.method,
        oldValor: payment.valor,
        oldDetails: payment.details,
        newMethod,
        newValor,
        newDetails: newDetailsJson,
        changedByUserId: input.changedByUserId ?? null,
        changedByUserName: input.changedByUserName ?? null,
        changedByRole: input.changedByRole ?? null,
        reason: input.reason.trim().slice(0, 500),
      },
    });

    const updated = await (this.prisma as any).pdvSalePayment.update({
      where: { id: input.paymentId },
      data: {
        method: newMethod,
        valor: newValor,
        details: newDetailsJson,
      },
    });

    this.logger.warn(
      `[pdv] PAGAMENTO AJUSTADO sale=${input.saleId} payment=${input.paymentId} ` +
      `${payment.method}/${payment.valor} → ${newMethod}/${newValor} ` +
      `por ${input.changedByUserName || input.changedByRole || '?'} · razão: ${input.reason}`,
    );

    return updated;
  }

  async getPaymentAudits(input: { saleId: string; paymentId?: string }) {
    const where: any = { saleId: input.saleId };
    if (input.paymentId) where.paymentId = input.paymentId;
    return (this.prisma as any).pdvPaymentAudit.findMany({
      where,
      orderBy: { changedAt: 'desc' },
    });
  }

  async removePayment(input: { saleId: string; paymentId: string }) {
    const payment = await (this.prisma as any).pdvSalePayment.findUnique({
      where: { id: input.paymentId },
    });
    if (!payment || payment.saleId !== input.saleId) {
      throw new NotFoundException('Pagamento não encontrado nessa venda');
    }
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { status: true },
    });
    if (sale?.status !== 'open') throw new BadRequestException('Venda já fechada');
    await (this.prisma as any).pdvSalePayment.delete({ where: { id: input.paymentId } });
    return { ok: true };
  }

  /**
   * Lista vendas da loja (default últimas 20 do dia).
   */
  async listSales(input: { storeCode: string; status?: string; limit?: number }) {
    const where: any = { storeCode: input.storeCode };
    if (input.status) where.status = input.status;
    return (this.prisma as any).pdvSale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: input.limit || 20,
      select: {
        id: true,
        storeCode: true,
        status: true,
        total: true,
        paymentMethod: true,
        customerName: true,
        customerCpf: true,
        sellerName: true,
        vendedorName: true,
        nfceStatus: true,
        nfceNumber: true,
        createdAt: true,
        finalizedAt: true,
        // Contagem de items + payments — usado pelo frontend pra distinguir
        // vendas com peca bipada (= Pausadas REAIS) de fantasmas vazias
        // (= vendedora abriu PDV mas nao bipou nada).
        _count: { select: { items: true, payments: true } },
      },
    });
  }

  /**
   * Lista NFC-es emitidas com filtros + agregados.
   * Usado pela tela /minha-loja/pdv/notas.
   */
  async listNfces(input: {
    storeCode?: string;
    storeCodes?: string[]; // restringe a um CONJUNTO de lojas (ex: franquias)
    startDate?: string;
    endDate?: string;
    status?: string;
    q?: string;
    limit?: number;
  }): Promise<any> {
    const limit = Math.min(500, Math.max(10, input.limit || 100));

    // Default: hoje (no fuso BR — servidor roda em UTC).
    let dateStart: Date = startOfDayBR();
    let dateEnd: Date = startOfNextDayBR();
    if (input.startDate) {
      dateStart = startOfDayBRFromYmd(input.startDate);
    }
    if (input.endDate) {
      dateEnd = endOfDayBRFromYmd(input.endDate);
    }

    const where: any = {
      nfceStatus: { not: null },
      finalizedAt: { gte: dateStart, lte: dateEnd },
    };
    // Conjunto de lojas (franquias) tem prioridade; senão filtra por 1 loja.
    if (input.storeCodes && input.storeCodes.length > 0) {
      where.storeCode = { in: input.storeCodes };
    } else if (input.storeCode) {
      where.storeCode = input.storeCode;
    }
    if (input.status && input.status !== 'all') {
      where.nfceStatus = input.status;
    }
    if (input.q) {
      const q = String(input.q).trim();
      where.OR = [
        { nfceNumber: { contains: q } },
        { customerCpf: { contains: q } },
        { customerName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const rows = await (this.prisma as any).pdvSale.findMany({
      where,
      orderBy: { nfceAutorizadaEm: 'desc' },
      take: limit,
      select: {
        id: true,
        storeCode: true,
        storeName: true,
        total: true,
        paymentMethod: true,
        customerName: true,
        customerCpf: true,
        nfceStatus: true,
        nfceNumber: true,
        nfceSerie: true,
        nfceChave: true,
        nfceProtocolo: true,
        nfceAutorizadaEm: true,
        nfceCanceladaEm: true,
        nfceCancelamentoMotivo: true,
        finalizedAt: true,
        createdAt: true,
      },
    });

    // Calcula podeCancelar (autorizada + dentro de 30min)
    const now = Date.now();
    const enriched = rows.map((r: any) => {
      const autEm = r.nfceAutorizadaEm ? new Date(r.nfceAutorizadaEm).getTime() : 0;
      const minutosDesde = autEm ? (now - autEm) / 60000 : 999;
      const podeCancelar =
        r.nfceStatus === 'authorized' && !r.nfceCanceladaEm && minutosDesde <= 30;
      return {
        ...r,
        podeCancelar,
        minutosRestantes: podeCancelar ? Math.max(0, Math.floor(30 - minutosDesde)) : 0,
      };
    });

    const summary = {
      totalNotas: enriched.length,
      totalValor: enriched.reduce((s: number, r: any) =>
        s + (r.nfceStatus === 'authorized' ? Number(r.total) : 0), 0),
      autorizadas: enriched.filter((r: any) => r.nfceStatus === 'authorized').length,
      canceladas: enriched.filter((r: any) => r.nfceStatus === 'cancelled' || r.nfceCanceladaEm).length,
      rejeitadas: enriched.filter((r: any) => r.nfceStatus === 'rejected' || r.nfceStatus === 'error').length,
      porLoja: [] as Array<{ storeCode: string; storeName: string | null; count: number; total: number }>,
    };

    const lojaMap = new Map<string, { storeCode: string; storeName: string | null; count: number; total: number }>();
    for (const r of enriched) {
      const key = r.storeCode || '?';
      const cur = lojaMap.get(key) || { storeCode: key, storeName: r.storeName, count: 0, total: 0 };
      cur.count += 1;
      if (r.nfceStatus === 'authorized') cur.total += Number(r.total) || 0;
      lojaMap.set(key, cur);
    }
    summary.porLoja = Array.from(lojaMap.values()).sort((a, b) => b.total - a.total);

    return { rows: enriched, summary };
  }

  /**
   * Estatísticas do dia da loja: vendas finalizadas hoje, total vendido,
   * ticket médio. Usa data local (Brasília).
   */
  async statsToday(storeCode: string): Promise<{
    count: number;
    total: number;
    ticketMedio: number;
  }> {
    if (!storeCode) return { count: 0, total: 0, ticketMedio: 0 };
    // Início do dia em Brasília (UTC-3) como instante UTC pra query.
    // (O cálculo manual com now.getDate() usava a DATA em UTC → depois das 21h
    // pulava pro dia seguinte. startOfDayBR resolve no fuso BR.)
    const inicioUtc = startOfDayBR();

    try {
      const sales = await (this.prisma as any).pdvSale.findMany({
        where: {
          storeCode,
          status: 'finalized',
          finalizedAt: { gte: inicioUtc },
        },
        select: { total: true },
      });
      const count = sales.length;
      const total = sales.reduce(
        (s: number, x: any) => s + Number(x.total || 0),
        0,
      );
      const ticketMedio = count > 0 ? total / count : 0;
      return { count, total, ticketMedio };
    } catch (e: any) {
      this.logger.warn(`[statsToday] falhou: ${e?.message}`);
      return { count: 0, total: 0, ticketMedio: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ITENS DO CARRINHO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Adiciona item bipado: busca info no Giga, cria snapshot, recalcula totais.
   *
   * Se já existir o mesmo SKU no carrinho, INCREMENTA qty em vez de duplicar
   * linha (UX melhor pro PDV).
   */
  async addItem(input: { saleId: string; skuOrEan: string; qty?: number }) {
    // ── INSTRUMENTAÇÃO (02/07) — mede cada etapa do bipe pra atacar o
    // pedaço certo da latência (bipe estava ~0,6s ponta a ponta). Uma linha
    // de log por bipe: [bipe-timing] sku total=Xms · lookup=… reload=…
    const t0 = Date.now();
    const marks: string[] = [];
    let tStep = Date.now();
    const mark = (label: string) => {
      marks.push(`${label}=${Date.now() - tStep}`);
      tStep = Date.now();
    };

    // PERF: lookup da venda e do produto em PARALELO. O produto vem do
    // ESPELHO Postgres (WincredCatalogService) com fallback automático pro
    // Giga ao vivo — o bipe não depende mais do MySQL remoto no caso comum.
    // (activePromotion já vem aqui pra applyAutoDiscounts não re-buscar.)
    const [sale, info] = await Promise.all([
      (this.prisma as any).pdvSale.findUnique({
        where: { id: input.saleId },
        select: { id: true, status: true, activePromotion: true },
      }),
      this.catalog.getPdvProductInfo(input.skuOrEan),
    ]);
    mark('lookup');
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda não está aberta (status=${sale.status})`);

    if (!info) throw new NotFoundException(`Produto "${input.skuOrEan}" não encontrado no Giga`);
    if (info.preco <= 0)
      throw new BadRequestException(`Produto ${info.sku} sem preço cadastrado no Giga`);

    const qty = Math.max(1, Math.min(99, input.qty || 1));

    // Procura item existente do mesmo SKU (precisa do sku RESOLVIDO pelo
    // lookup — o código bipado pode vir com padding/EAN — então roda depois).
    const existing = await (this.prisma as any).pdvSaleItem.findFirst({
      where: { saleId: sale.id, sku: info.sku },
    });
    mark('find');

    let item;
    if (existing) {
      const newQty = existing.qty + qty;
      item = await (this.prisma as any).pdvSaleItem.update({
        where: { id: existing.id },
        data: {
          qty: newQty,
          total: info.preco * newQty - (existing.desconto || 0),
        },
      });
    } else {
      item = await (this.prisma as any).pdvSaleItem.create({
        data: {
          saleId: sale.id,
          sku: info.sku,
          ean: info.ean,
          ref: info.ref,
          cor: info.cor,
          tamanho: info.tamanho,
          descricao: info.descricao,
          ncm: info.ncm,
          cfop: info.cfop,
          dataCadastro: info.dataCadastro,
          qty,
          precoUnit: info.preco,
          desconto: 0,
          total: info.preco * qty,
        },
      });
    }
    mark('write');

    await this.applyAutoDiscounts(sale.id, (sale as any).activePromotion);
    mark('promo');
    await this.recalcTotals(sale.id);
    mark('totals');
    // PERF: devolve a venda COMPLETA junto — o frontend não precisa fazer um
    // segundo GET /pdv/sales/:id (eliminava ida-e-volta inteira a cada bipe).
    const freshSale = await this.getSale(sale.id);
    mark('reload');

    this.logger.log(
      `[bipe-timing] ${info.sku} total=${Date.now() - t0}ms · ${marks.join(' ')}${existing ? ' (incremento)' : ''}`,
    );
    return { ok: true, item, sale: freshSale };
  }

  /**
   * Adiciona um item MANUAL na venda — descrição livre + valor digitado pela
   * vendedora. Usado quando o produto não passa pelo bipe (cadastro errado,
   * EAN ausente, peça importada sem código, etc). Não toca no Giga e marca
   * o item com promoTag='MANUAL' pra fugir do recálculo automático.
   *
   * Característica:
   *   - SKU gerado: "MANUAL-{epoch}" pra cada item (sempre nova linha, não merge)
   *   - precoUnit = valor digitado · descricao = livre · qty = livre
   *   - Não cai em applyAutoDiscounts (item solto, não tem campanha)
   */
  async addManualItem(input: {
    saleId: string;
    descricao: string;
    valor: number;
    qty?: number;
  }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda não está aberta (status=${sale.status})`);

    const descricao = String(input.descricao || '').trim().slice(0, 80);
    if (descricao.length < 2)
      throw new BadRequestException('Descrição obrigatória (mínimo 2 caracteres)');
    const valor = Number(input.valor);
    // Aceita valor NEGATIVO (ex: TROCA DEFEITO -R$ 39,90). Bloqueia só zero.
    if (!Number.isFinite(valor) || valor === 0)
      throw new BadRequestException('Valor deve ser diferente de zero (pode ser negativo pra descontos)');
    const qty = Math.max(1, Math.min(99, Math.floor(input.qty || 1)));
    const sku = `MANUAL-${Date.now()}`;

    const item = await (this.prisma as any).pdvSaleItem.create({
      data: {
        saleId: sale.id,
        sku,
        ean: null,
        ref: 'MANUAL',
        cor: null,
        tamanho: null,
        descricao,
        ncm: null,
        cfop: null,
        dataCadastro: null,
        qty,
        precoUnit: valor,
        desconto: 0,
        total: valor * qty,
        promoTag: 'MANUAL', // tag pra não cair no applyAutoDiscounts
      },
    });

    await this.recalcTotals(sale.id);
    return { ok: true, item };
  }

  /**
   * VALE PRESENTE — vende um vale dentro da venda aberta do PDV.
   *
   * Como funciona (tudo em trilho existente, zero fluxo novo):
   *   - Entra na venda como item MANUAL ("VALE PRESENTE VP-XXXX-XXXX") →
   *     o caixa grava no Wincred normal e o estoque NÃO baixa (filtro MANUAL).
   *     O código sai impresso no cupom.
   *   - Cria o crédito no MESMO trilho do vale-troca (PdvReturn com
   *     source='vale_presente'), status 'pending' até a venda FINALIZAR —
   *     venda cancelada nunca ativa o código.
   *   - Resgate: mesma tela/endpoints do vale-troca (checkCredit/useCredit
   *     aceitam o código VP-). Uso parcial = "dividir vale residual" que já existe.
   *   - Validade: 12 meses. Treino: vale nasce isTraining e nunca ativa.
   */
  async addGiftVoucher(input: {
    saleId: string;
    valor: number;
    compradorNome?: string;
    presenteadoNome?: string;
  }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true, storeCode: true, storeName: true, isTraining: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda não está aberta (status=${sale.status})`);

    const valor = Math.round((Number(input.valor) || 0) * 100) / 100;
    if (!Number.isFinite(valor) || valor < 1 || valor > 5000)
      throw new BadRequestException('Valor do vale: entre R$ 1,00 e R$ 5.000,00');

    // Código curto sem caracteres ambíguos (sem 0/O/1/I/L)
    const gen = () => {
      const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      let s = '';
      for (let i = 0; i < 8; i++) s += A[Math.floor(Math.random() * A.length)];
      return `VP-${s.slice(0, 4)}-${s.slice(4)}`;
    };
    let code = gen();
    for (let i = 0; i < 5; i++) {
      const clash = await (this.prisma as any).pdvReturn.findUnique({
        where: { creditoCode: code },
        select: { id: true },
      });
      if (!clash) break;
      code = gen();
    }
    const validade = new Date();
    validade.setMonth(validade.getMonth() + 12);

    const comprador = String(input.compradorNome || '').trim().slice(0, 80);
    const presenteado = String(input.presenteadoNome || '').trim().slice(0, 80);
    await (this.prisma as any).pdvReturn.create({
      data: {
        source: 'vale_presente',
        modo: 'credito',
        status: 'pending', // ativa na finalização da venda
        originalSaleId: sale.id,
        storeCode: sale.storeCode,
        storeName: sale.storeName || sale.storeCode,
        valorTotal: valor,
        creditoCode: code,
        creditoValidade: validade,
        customerName: presenteado || comprador || null,
        motivo:
          `VALE PRESENTE` +
          (comprador ? ` — comprado por ${comprador}` : '') +
          (presenteado ? ` para ${presenteado}` : '') +
          ` · válido até ${validade.toLocaleDateString('pt-BR')}`,
        isTraining: !!sale.isTraining,
      },
    });

    // Item manual na venda: cupom imprime o código, caixa grava, estoque não baixa
    const r = await this.addManualItem({
      saleId: sale.id,
      descricao: `VALE PRESENTE ${code}`,
      valor,
      qty: 1,
    });
    this.logger.log(
      `[pdv] Vale presente ${code} (R$ ${valor.toFixed(2)}) criado na venda ${sale.id} — ativa na finalização`,
    );
    return { ...r, voucher: { code, valor, validade: validade.toISOString() } };
  }

  async updateItem(input: { saleId: string; itemId: string; qty?: number; desconto?: number; password?: string; motivo?: string; excludePromo?: boolean; forcePromo?: boolean }) {
    const item = await (this.prisma as any).pdvSaleItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item || item.saleId !== input.saleId)
      throw new NotFoundException('Item não encontrado nessa venda');

    // Bloqueia edição de item em venda já fechada (mesmo guard de setSaleDiscount).
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    const newQty = input.qty != null ? Math.max(1, Math.min(99, input.qty)) : item.qty;

    // EXCLUSÃO DA PROMOÇÃO POR ITEM (pedido da loja): peça que NÃO participa da
    // campanha. excludePromo=true → zera o desconto e TRAVA como 'SEM_PROMO', que
    // o applyAutoDiscounts preserva (não re-aplica os 50%). É REMOVER desconto,
    // então é permitido MESMO com campanha ativa e NÃO exige senha. excludePromo
    // =false → re-inclui na promoção (volta ao automático, tag null).
    const excluindoPromo = input.excludePromo === true;
    const reincluindoPromo = input.excludePromo === false;
    // FORÇAR PROMO (15/07): botão AZUL — coloca o item BÁSICO na promoção
    // (ignora só o filtro básico; data/coleção seguem valendo no recálculo).
    const forcandoPromo = input.forcePromo === true;
    const desforcandoPromo = input.forcePromo === false;

    const newDesconto = excluindoPromo
      ? 0
      : forcandoPromo || desforcandoPromo
      ? (item.desconto || 0) // o applyAutoDiscounts recalcula
      : input.desconto != null ? Math.max(0, input.desconto) : (item.desconto || 0);
    const bruto = item.precoUnit * newQty;
    if (newDesconto > bruto) {
      throw new BadRequestException(`Desconto (${newDesconto.toFixed(2)}) maior que o total do item (${bruto.toFixed(2)})`);
    }

    // Desconto MANUAL (>0) — só conta como manual se NÃO está excluindo/reincluindo
    // a promoção. marca 'MANUAL' pra applyAutoDiscounts não sobrescrever.
    const isManualDiscount =
      !excluindoPromo && !reincluindoPromo && !forcandoPromo && !desforcandoPromo &&
      input.desconto != null && newDesconto > 0;

    // MD-1: desconto manual por item em faixas (% sobre o BRUTO do item).
    //   0–7% livre · >7–10% senha CAIXA · >10% senha GERENTE + justificativa.
    //   Campanha ativa → bloqueia desconto avulso ADICIONAL (prevalece a promoção).
    //   Pra TIRAR a promoção de um item, usa-se excludePromo (acima), sem senha.
    if (isManualDiscount) {
      if (sale.activePromotion && sale.activePromotion !== 'NONE') {
        throw new BadRequestException(
          'Promoção ativa — desconto avulso por item bloqueado. Pra tirar a promoção de uma peça que não participa, use "Remover desconto" (sem senha).',
        );
      }
      const pct = bruto > 0 ? (newDesconto / bruto) * 100 : 0;
      await this.requireDiscountAuth(pct, input.password, input.motivo);
    }

    const newTag = excluindoPromo
      ? 'SEM_PROMO'
      : reincluindoPromo || forcandoPromo || desforcandoPromo
      ? null // volta pro automático — o applyAutoDiscounts define a tag final
      : isManualDiscount
      ? 'MANUAL'
      : input.desconto != null && newDesconto === 0
      ? null
      : item.promoTag;

    // forcarPromo: liga no forçar, desliga no des-forçar E no excluir (tirar da
    // promo un-força também). Edição de qty/desconto não mexe na flag.
    const newForcar = forcandoPromo
      ? true
      : desforcandoPromo || excluindoPromo
      ? false
      : (item.forcarPromo ?? false);

    const updated = await (this.prisma as any).pdvSaleItem.update({
      where: { id: item.id },
      data: {
        qty: newQty,
        desconto: newDesconto,
        total: bruto - newDesconto,
        promoTag: newTag,
        forcarPromo: newForcar,
      },
    });
    await this.applyAutoDiscounts(input.saleId);
    await this.recalcTotals(input.saleId);
    return updated;
  }

  /**
   * Aplica desconto na VENDA INTEIRA (additionalDiscount, somado por cima
   * dos descontos individuais dos itens).
   * Salva no campo `desconto` da venda, e o `total` é recalculado.
   */
  /**
   * Aplica desconto EXTRA da venda inteira (independente dos descontos de
   * cada item). Soma com os descontos de item pra formar a economia total.
   *
   * Exemplo: subtotal=100, item1 tem desconto manual de 5, user define
   * setSaleDiscount(10) → economia total = 5+10 = 15, total = 85.
   */
  // MD-1: desconto avulso em faixas. % sobre o subtotal BRUTO.
  //   0..livre = sem senha · >livre..caixa = senha CAIXA · >caixa = GERENTE + justificativa.
  //   As faixas (livre/caixa) são configuráveis na tela /retaguarda/descontos-senhas.
  private async requireDiscountAuth(pct: number, password?: string, motivo?: string) {
    const { freeUpToPct, caixaUpToPct } = await this.accessPolicy.getThresholds();
    if (pct > caixaUpToPct + 1e-9) {
      validateMinLevel(password, 'GERENTE'); // lança se senha < GERENTE
      if (!motivo || String(motivo).trim().length < 3) {
        throw new BadRequestException(
          `Justificativa obrigatória para desconto acima de ${caixaUpToPct}%`,
        );
      }
    } else if (pct > freeUpToPct + 1e-9) {
      validateMinLevel(password, 'CAIXA'); // lança se senha < CAIXA
    }
  }

  async setSaleDiscount(input: { saleId: string; desconto: number; password?: string; motivo?: string }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    const desconto = Math.max(0, input.desconto || 0);

    // MD-1: campanha ativa → prevalece a promoção, desconto avulso bloqueado.
    if (desconto > 0 && sale.activePromotion && sale.activePromotion !== 'NONE') {
      throw new BadRequestException(
        'Promoção/campanha ativa — desconto avulso bloqueado (prevalece o desconto da campanha).',
      );
    }
    // MD-1: senha por faixa, % sobre o subtotal BRUTO (preço cheio).
    const subtotalBruto = sale.items.reduce((s: number, i: any) => s + i.precoUnit * i.qty, 0);
    const pct = subtotalBruto > 0 ? (desconto / subtotalBruto) * 100 : 0;
    await this.requireDiscountAuth(pct, input.password, input.motivo);

    // Soma dos itens líquidos (já com descontos individuais aplicados)
    const subtotalLiquido = sale.items.reduce((s: number, i: any) => s + (i.total || 0), 0);
    if (desconto > subtotalLiquido) {
      throw new BadRequestException(
        `Desconto extra (R$${desconto.toFixed(2)}) maior que o subtotal líquido (R$${subtotalLiquido.toFixed(2)})`,
      );
    }

    return (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        desconto,
        total: Math.max(0, subtotalLiquido - desconto),
      },
    });
  }

  async removeItem(input: { saleId: string; itemId: string }) {
    const item = await (this.prisma as any).pdvSaleItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item || item.saleId !== input.saleId)
      throw new NotFoundException('Item não encontrado nessa venda');

    // Bloqueia remoção de item em venda já fechada (mesmo guard de setSaleDiscount).
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    await (this.prisma as any).pdvSaleItem.delete({ where: { id: item.id } });
    await this.applyAutoDiscounts(input.saleId);
    await this.recalcTotals(input.saleId);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENGINE DE PROMOÇÕES AUTOMÁTICAS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Aplica APENAS a campanha promocional ATIVA da venda (exclusiva).
   *
   * Campanhas disponíveis (sale.activePromotion):
   *   - 'YEAR_BASED'    → desconto por data de cadastro do produto
   *                       ate 31/12/2023 = 50% off (liquida produtos antigos)
   *   - 'FOUR_FOR_THREE' → carrinho com ≥4 peças, a menor sai de graça (1 un)
   *   - null/'NONE'     → SEM promoção (zera todos os descontos auto)
   *
   * As campanhas NÃO são acumulativas — só uma roda por vez.
   * Desconto manual (item ou venda) é separado e não é tocado por aqui.
   *
   * Defensivo: se a coluna `promoTag`/`active_promotion` não existir no DB
   * (db push pendente), tenta sem ela e loga o erro pra debug.
   */
  private async applyAutoDiscounts(saleId: string, knownPromotion?: string | null) {
    // PERF: quem já tem a promoção ativa em mãos (addItem) passa por parâmetro
    // e economiza uma ida ao banco por bipe.
    let activePromotion: string;
    if (knownPromotion !== undefined) {
      activePromotion = knownPromotion || 'NONE';
    } else {
      const sale = await (this.prisma as any).pdvSale.findUnique({
        where: { id: saleId },
        select: { activePromotion: true },
      });
      activePromotion = (sale as any)?.activePromotion || 'NONE';
    }

    const items = await (this.prisma as any).pdvSaleItem.findMany({
      where: { saleId },
      orderBy: { createdAt: 'asc' },
    });
    if (!items.length) return;

    // Função pra zerar promo automática de todos itens (preserva desconto manual? não — autodesconto sobrescreve)
    const updates: Array<{ id: string; desconto: number; total: number; tag: string | null }> = [];

    // Helper: itens "travados" que a promoção automática NUNCA toca:
    //   - promoTag='MANUAL'    → desconto fixado pela vendedora.
    //   - promoTag='SEM_PROMO' → peça que a loja tirou da campanha (não participa).
    // Promoção automática só mexe nos demais.
    const isManual = (it: any) => it.promoTag === 'MANUAL' || it.promoTag === 'SEM_PROMO';

    if (activePromotion === 'NONE' || !activePromotion) {
      // Zera tudo (apenas resetando o que veio de promo automática)
      for (const it of items as any[]) {
        if (isManual(it)) continue; // preserva manual
        // Se o promoTag começa com "PROMO" ou "4 LEVA", é auto e zera
        const wasAuto = !it.promoTag || /^(PROMO|4 LEVA)/.test(it.promoTag);
        if (wasAuto) {
          const bruto = it.precoUnit * it.qty;
          updates.push({ id: it.id, desconto: 0, total: bruto, tag: null });
        }
      }
    } else if (activePromotion === 'YEAR_BASED') {
      // Regra: tudo cadastrado ATE 31/12/2023 = 50% off (liquida antigos).
      // Coleções marcadas na REF também entram, independente do ano de
      // cadastro: sufixo -INV (inverno) ou -VER (verão) — regra do dono 10/07/2026.
      const isColecaoPromo = (it: any) => /-(INV|VER)$/i.test(String(it.ref || '').trim());
      const promoByYear = (data: string | null): { pct: number; tag: string } | null => {
        if (!data) return null;
        const dataStr = data.slice(0, 10);
        if (dataStr <= '2023-12-31') {
          const year = parseInt(dataStr.slice(0, 4), 10);
          return { pct: 0.50, tag: `PROMO 50% · ${isNaN(year) ? 'antigo' : year}` };
        }
        return null;
      };

      // Filtro configurável (tela "Promoções PDV"): não dar 50% no que é BÁSICO.
      // A classificação Básico/Moda vem da tela "Produtos Loja".
      // Chave de classificação do item: REF quando existe; senão "#<codigo>"
      // (produtos sem REF — meias/acessórios — são classificados pelo código).
      const clsKey = (it: any): string => {
        const ref = String(it.ref || '').trim();
        if (ref) return ref.toUpperCase();
        const cod = String(it.sku || '').trim();
        return cod ? `#${cod}`.toUpperCase() : '';
      };
      let basicoRefs = new Set<string>();
      try {
        const cfg = await this.promoConfig.getConfig();
        if (cfg.excluirBasicoNa50) {
          const keys = (items as any[]).map(clsKey).filter(Boolean);
          basicoRefs = await this.basicoRefsIn(keys);
        }
      } catch {
        // fail-open: sem config, mantém comportamento antigo (50% em tudo elegível)
      }
      const isBasico = (it: any) =>
        basicoRefs.size > 0 && basicoRefs.has(clsKey(it));

      for (const it of items as any[]) {
        if (isManual(it)) continue; // preserva manual
        const bruto = it.precoUnit * it.qty;
        // Peça básica: fica fora da promoção de 50% (preço cheio) — SALVO se a
        // operadora FORÇOU a entrada (botão azul). Forçar ignora só o filtro
        // básico; data e coleção (-INV/-VER) continuam decidindo abaixo, então
        // um básico NOVO forçado não ganha desconto (cai no 'Sem promo · ano').
        if (isBasico(it) && !it.forcarPromo) {
          updates.push({ id: it.id, desconto: 0, total: bruto, tag: 'Básico · sem promo' });
          continue;
        }
        const promo = isColecaoPromo(it)
          ? { pct: 0.50, tag: 'PROMO 50% · coleção' }
          : promoByYear(it.dataCadastro || null);
        if (promo) {
          const desconto = Math.round(bruto * promo.pct * 100) / 100;
          updates.push({
            id: it.id,
            desconto,
            total: Math.round((bruto - desconto) * 100) / 100,
            tag: promo.tag,
          });
        } else {
          updates.push({
            id: it.id,
            desconto: 0,
            total: bruto,
            tag: it.dataCadastro ? `Sem promo · ${it.dataCadastro.slice(0, 4)}` : 'Sem data cad.',
          });
        }
      }
    } else if (activePromotion === 'FOUR_FOR_THREE') {
      const totalPecas = (items as any[]).reduce((s, i) => s + i.qty, 0);
      // Zera todos os descontos auto primeiro (preserva manuais)
      for (const it of items as any[]) {
        if (isManual(it)) continue;
        const bruto = it.precoUnit * it.qty;
        updates.push({ id: it.id, desconto: 0, total: bruto, tag: null });
      }
      if (totalPecas >= 4) {
        // Acha o item de MENOR preço unitário (ignorando os com desconto MANUAL,
        // que ficam preservados — não pode dar de graça um que já tem desconto fixo)
        const elegiveis = (items as any[]).filter((i) => !isManual(i));
        if (elegiveis.length > 0) {
          const menorPreco = Math.min(...elegiveis.map((i) => i.precoUnit));
          const menorIdx = (items as any[]).findIndex(
            (i) => !isManual(i) && i.precoUnit === menorPreco,
          );
          if (menorIdx >= 0) {
            const it = (items as any[])[menorIdx];
            const bruto = it.precoUnit * it.qty;
            // Desconta 1 unidade
            const desconto = Math.round(it.precoUnit * 100) / 100;
            updates[menorIdx] = {
              id: it.id,
              desconto,
              total: Math.round((bruto - desconto) * 100) / 100,
              tag: '4 LEVA 3 · 1 grátis',
            };
          }
        }
      }
    }

    // Persiste — defensivo contra coluna inexistente
    for (const u of updates) {
      try {
        await (this.prisma as any).pdvSaleItem.update({
          where: { id: u.id },
          data: { desconto: u.desconto, total: u.total, promoTag: u.tag },
        });
      } catch (e: any) {
        // Se promoTag não existe no DB, tenta sem ele
        if (/promoTag|promo_tag|Unknown/i.test(e?.message || '')) {
          this.logger.warn(`[pdv] coluna promo_tag não existe — rodar prisma db push. Salvando sem tag.`);
          try {
            await (this.prisma as any).pdvSaleItem.update({
              where: { id: u.id },
              data: { desconto: u.desconto, total: u.total },
            });
          } catch (e2) {
            this.logger.error(`[pdv] update item ${u.id} falhou: ${(e2 as Error).message}`);
          }
        } else {
          this.logger.error(`[pdv] update item ${u.id} falhou: ${e?.message}`);
        }
      }
    }
  }

  /**
   * Define a campanha promocional ATIVA da venda (exclusiva).
   * Recalcula tudo automaticamente.
   */
  async setPromotion(input: { saleId: string; promotion: string | null }) {
    const allowed = ['YEAR_BASED', 'FOUR_FOR_THREE', 'NONE'];
    const promo = input.promotion && allowed.includes(input.promotion) ? input.promotion : 'NONE';
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    try {
      await (this.prisma as any).pdvSale.update({
        where: { id: input.saleId },
        data: { activePromotion: promo === 'NONE' ? null : promo },
      });
    } catch (e: any) {
      // Se coluna não existe, avisa
      if (/activePromotion|active_promotion|Unknown/i.test(e?.message || '')) {
        throw new BadRequestException(
          'Coluna active_promotion não existe no banco — rode `npx prisma db push` no Railway',
        );
      }
      throw e;
    }

    await this.applyAutoDiscounts(input.saleId);
    await this.recalcTotals(input.saleId);
    return this.getSale(input.saleId);
  }

  /**
   * Recalcula totais da venda a partir dos itens.
   * - subtotal = soma bruta dos itens (sem nenhum desconto)
   * - desconto = soma dos descontos individuais dos itens + desconto da venda
   * - total = subtotal - desconto
   *
   * Preserva o desconto manual aplicado na VENDA inteira (campo `desconto`
   * tem dois usos: aqui guarda total geral; setSaleDiscount sobrescreve
   * só com adicional do nível venda).
   *
   * Estratégia simples: total = soma de items.total - extraDescontoVenda
   * (onde extraDescontoVenda é guardado em paymentDetails.saleDiscountExtra).
   * Pra MVP: total = soma items.total. Desconto manual reaplica via setSaleDiscount.
   */
  /**
   * SEMÂNTICA NOVA (corrigida):
   *   sale.desconto = APENAS o desconto EXTRA da venda inteira (não inclui
   *   descontos individuais de cada item). É independente.
   *
   *   subtotal      = soma(precoUnit × qty)              ← bruto da venda
   *   descontoItens = soma(item.desconto)                ← descontos individuais
   *   sale.desconto = extra da venda (definido em setSaleDiscount)
   *   total         = subtotal - descontoItens - sale.desconto
   *
   * Antes a lógica "absorvia" o desconto do item dentro de sale.desconto
   * mantendo o agregado fixo — confuso pra vendedora ("apliquei 10% no item
   * e o total não muda"). Agora os 2 são independentes e somam.
   */
  private async recalcTotals(saleId: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      select: { desconto: true, items: { select: { precoUnit: true, qty: true, desconto: true, total: true } } },
    });
    if (!sale) return;
    const items = sale.items;
    const subtotal = items.reduce((s: number, i: any) => s + (i.precoUnit * i.qty), 0);
    const descontoItens = items.reduce((s: number, i: any) => s + (i.desconto || 0), 0);
    const saleExtra = sale.desconto || 0;
    // Garante que extra + descontoItens não excede subtotal (clipa se passar)
    const extraClipado = Math.max(0, Math.min(saleExtra, subtotal - descontoItens));
    const total = Math.max(0, subtotal - descontoItens - extraClipado);
    await (this.prisma as any).pdvSale.update({
      where: { id: saleId },
      // NÃO toca em sale.desconto aqui — só atualiza se foi clipado
      data: extraClipado !== saleExtra
        ? { subtotal, desconto: extraClipado, total }
        : { subtotal, total },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLIENTE
  // ═══════════════════════════════════════════════════════════════════════

  async setCustomer(input: {
    saleId: string;
    cpf?: string;
    name?: string;
    email?: string;
    phone?: string;
    // Endereço (essencial pra venda online — WhatsApp/Instagram)
    cep?: string;
    endereco?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
  }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true, nfceStatus: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    // Permite atualizar customer se:
    //  - Venda em aberto (fluxo normal — antes de finalizar) OU
    //  - Venda finalizada MAS NFC-e ainda NÃO foi AUTORIZADA pela SEFAZ
    //
    // BUG FIX (2026-06): o canUpdate antigo era `!sale.nfceStatus`, mas o
    // finalize() SEMPRE seta nfceStatus='preview' (do stub). Resultado: o
    // PATCH /customer rejeitava o CPF avulso depois do pagamento mesmo
    // antes da emissão real. Agora só bloqueia se a NFC-e foi efetivamente
    // autorizada pela SEFAZ (XML enviado, chave de acesso protocolada).
    // Estados aceitos pra update: 'preview' (stub local), 'rejected' (SEFAZ
    // recusou, vendedora corrige e tenta de novo), null (skipped/sem stub).
    const canUpdate =
      sale.status === 'open' ||
      (sale.status === 'finalized' && sale.nfceStatus !== 'authorized');
    if (!canUpdate) {
      throw new BadRequestException(
        sale.nfceStatus === 'authorized'
          ? 'NFC-e já foi autorizada pela SEFAZ — não dá pra alterar dados do cliente'
          : 'Venda já finalizada',
      );
    }

    // Quando atualiza dados do cliente em venda já finalizada com stub de
    // NFC-e pendente (preview/rejected), invalida campos derivados pra
    // forçar regeneração com os dados novos no próximo emit().
    if (sale.status === 'finalized' && sale.nfceStatus && sale.nfceStatus !== 'authorized') {
      // Não precisa limpar explicitamente — o emit() sobrescreve nfceXml/
      // nfceChave/nfceNumero quando regenera. Mas resetar nfceStatus pra
      // 'preview' garante consistência se vendedora vier de um 'rejected'.
      this.logger.log(
        `[pdv] CPF/dados atualizados em venda finalizada ${input.saleId.slice(0, 8)} ` +
        `(nfceStatus=${sale.nfceStatus}) — emit() vai regenerar XML`,
      );
    }

    // Constrói update dinamicamente — só sobrescreve campos enviados.
    // Importante: se vendedora quer só ADICIONAR CPF, não pode zerar nome/email/etc.
    const data: any = {};
    if (input.cpf !== undefined) data.customerCpf = input.cpf?.replace(/\D/g, '') || null;
    if (input.name !== undefined) data.customerName = input.name?.trim() || null;
    if (input.email !== undefined) data.customerEmail = input.email?.trim() || null;
    if (input.phone !== undefined) data.customerPhone = input.phone?.replace(/\D/g, '') || null;
    // Endereço — só limpa máscara do CEP; resto trim
    if (input.cep !== undefined) data.customerCep = input.cep?.replace(/\D/g, '') || null;
    if (input.endereco !== undefined) data.customerEndereco = input.endereco?.trim() || null;
    if (input.numero !== undefined) data.customerNumero = input.numero?.trim() || null;
    if (input.complemento !== undefined) data.customerComplemento = input.complemento?.trim() || null;
    if (input.bairro !== undefined) data.customerBairro = input.bairro?.trim() || null;
    if (input.cidade !== undefined) data.customerCidade = input.cidade?.trim() || null;
    if (input.uf !== undefined) data.customerUf = input.uf?.trim().toUpperCase().slice(0, 2) || null;

    return (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINALIZAÇÃO + PAGAMENTO + NFC-e (stub)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Finaliza venda. 2 modos:
   *
   * MODO LEGADO (1 forma só): { paymentMethod, paymentDetails }
   *   → cria 1 pagamento parcial com valor total
   *
   * MODO SPLIT (várias formas): omitir paymentMethod
   *   → usa os pagamentos já adicionados via addPayment()
   *
   * Em ambos, soma(payments) precisa = total da venda.
   */
  async finalize(input: {
    saleId: string;
    paymentMethod?: string;
    paymentDetails?: any;
    /** Loja do usuário logado (vem do JWT) — usada como fallback se o
     *  storeCode da venda divergir do caixa aberto. */
    userStoreCode?: string;
    /** TRAVA DE SEGURANÇA: sessão em modo treino (header x-training-mode).
     *  Vale como treino mesmo se a venda foi criada ANTES de ligar o modo
     *  (sem isTraining) — impede baixa de estoque/Wincred reais em treino. */
    trainingRequest?: boolean;
  }) {
    const sale = await this.getSale(input.saleId);
    // IDEMPOTENTE: se a venda ja esta finalized, retorna OK sem refazer nada.
    // Cobre race condition de double-click no botao Finalizar + auto-finalize
    // (setTimeout 80ms dispara depois de adicionarPagamento). Antes lancava
    // 400 "Venda ja esta finalized" e a vendedora via erro chato na tela
    // mesmo a venda tendo fechado certo no banco.
    if (sale.status === 'finalized') {
      this.logger.warn(
        `[pdv] finalize chamado em venda ja finalized ${sale.id} — retornando OK (idempotente)`,
      );
      return { ok: true, sale, nfcePreview: null };
    }
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda já está ${sale.status}`);
    if (!sale.items?.length) throw new BadRequestException('Carrinho vazio');
    // Total < 0 sempre é erro de cálculo. Total === 0 é OK em TROCA PAR
    // (cliente devolve peça igual ao valor da nova → vale_troca cobre 100%).
    // Nesse caso a NFC-e original já cobriu o ICMS; a troca é só substituição
    // fiscal e não tem fato gerador novo. Quem valida que existe vale_troca
    // pra cobrir é o guard de payments + sumPaidValue logo abaixo.
    if (sale.total < 0) throw new BadRequestException('Total da venda inválido (< 0)');

    // Nota: a validação de CNPJ esperado vs config NFC-e (Store.expectedCnpj
    // vs NfceConfig.cnpj) foi removida do finalize — admin gerencia esse
    // mapeamento manualmente via /retaguarda/lojas, e ÀS VEZES alterna a
    // empresa emissora propositalmente (ex: SOROCABA normalmente fatura por
    // T.O. RISSUTTO mas eventualmente por LURDS PLUS SIZE por questão
    // contábil). O relatório fiscal /retaguarda/relatorio-fiscal mostra
    // inconsistências de forma informativa, sem bloquear operação.

    // GATE: precisa de caixa aberto na loja pra finalizar.
    // Se a venda foi criada antes do caixa abrir, vincula agora.
    let cashSessionId = sale.cashSessionId;
    if (!cashSessionId) {
      // Tenta primeiro pelo storeCode da venda
      let sess = await this.cash.getCurrentSession(sale.storeCode);

      // Fallback: se não tem caixa pra storeCode da venda mas o usuário
      // tem caixa aberto em OUTRA loja (sua loja vinculada), reconcilia:
      // atualiza o storeCode da venda pra refletir onde a vendedora está
      // operando agora. Isso resolve o caso "venda criada antes do
      // caixa abrir, com storeCode divergente do caixa atual".
      if (!sess && input.userStoreCode && input.userStoreCode !== sale.storeCode) {
        const userSess = await this.cash.getCurrentSession(input.userStoreCode);
        if (userSess) {
          this.logger.warn(
            `[pdv] reconciliando venda ${sale.id}: storeCode ${sale.storeCode} → ${input.userStoreCode} (caixa aberto na loja do usuário)`,
          );
          // Busca a Store pra atualizar storeCode + storeName juntos
          const newStore = await this.prisma.store.findUnique({
            where: { code: input.userStoreCode },
            select: { code: true, name: true },
          });
          await (this.prisma as any).pdvSale.update({
            where: { id: sale.id },
            data: {
              storeCode: input.userStoreCode,
              storeName: newStore?.name || sale.storeName,
            },
          });
          sale.storeCode = input.userStoreCode;
          if (newStore?.name) sale.storeName = newStore.name;
          sess = userSess;
        }
      }

      if (!sess) {
        // Mensagem de erro com diagnóstico — mostra qual storeCode foi consultado
        this.logger.warn(
          `[pdv] finalize REJEITADO (sem caixa): venda ${sale.id} storeCode=${sale.storeCode} userStoreCode=${input.userStoreCode || '—'}`,
        );
        throw new BadRequestException(
          `Não há caixa aberto na loja ${sale.storeCode}. ` +
            `Abra o caixa antes de finalizar a venda.`,
        );
      }
      cashSessionId = sess.id;
      await (this.prisma as any).pdvSale.update({
        where: { id: sale.id },
        data: { cashSessionId },
      });
    }

    // MODO LEGADO REMOVIDO: antes, se finalize recebesse "paymentMethod" no body,
    // o sistema DELETAVA todos os payments criados via /payments e gravava UM ÚNICO
    // com o método+total da venda. Isso quebrava SPLIT: vendedora fazia R$ 300 dinheiro
    // + R$ 800 cartão crédito, mas se algum trigger enviasse paymentMethod="credito",
    // o sistema deletava o "dinheiro 300" e criava um "credito 1100" — perdia o split.
    // O split agora é a UNICA fonte da verdade (sempre via POST /payments).
    if (input.paymentMethod) {
      this.logger.warn(
        `[pdv] finalize chamado com paymentMethod="${input.paymentMethod}" — IGNORADO. ` +
        `Use POST /payments antes pra registrar formas de pagamento.`,
      );
    }

    // GUARD: precisa ter PELO MENOS 1 forma de pagamento associada.
    // (defesa em profundidade — addPayment já valida, mas garante que ninguém
    // burle chamando finalize direto sem registrar payment.)
    // EXCEÇÃO (03/07): TROCA PAR com total ZERO — não há o que pagar, e
    // addPayment rejeita valor <= 0, então é IMPOSSÍVEL registrar payment.
    // Sem a exceção a vendedora ficava num loop: finalizar → escolher
    // vendedora → "sem forma de pagamento" → volta pra tela.
    const payments = await (this.prisma as any).pdvSalePayment.findMany({
      where: { saleId: sale.id },
      orderBy: { createdAt: 'asc' },
    });
    const totalZero = sale.total < 0.01; // total<0 já foi rejeitado acima
    if ((payments as any[]).length === 0 && !totalZero) {
      this.logger.warn(
        `[pdv] finalize REJEITADO (sem pagamento): venda ${sale.id} total=R$${Number(sale.total || 0).toFixed(2)}`,
      );
      throw new BadRequestException(
        'Venda nao pode ser finalizada sem forma de pagamento. ' +
          'Adicione PIX, cartao, dinheiro, crediario ou vale-troca antes.',
      );
    }

    // Verifica que pago = total
    const jaPago = await this.sumPaidValue(sale.id);
    if (Math.abs(jaPago - sale.total) > 0.01) {
      this.logger.warn(
        `[pdv] finalize REJEITADO (pago≠total): venda ${sale.id} ` +
          `total=R$${Number(sale.total || 0).toFixed(2)} pago=R$${jaPago.toFixed(2)} ` +
          `payments=[${(payments as any[]).map((p: any) => `${p.method}:${Number(p.valor || 0).toFixed(2)}`).join(', ')}]`,
      );
      throw new BadRequestException(
        `Total pago R$${jaPago.toFixed(2)} ≠ total venda R$${sale.total.toFixed(2)}. ` +
          `Faltam R$${(sale.total - jaPago).toFixed(2)}.`,
      );
    }
    // 0 pagamentos (troca par zerada) → 'troca_par' · 1 → método dele · N → "MULTIPLO"
    const finalMethod =
      (payments as any[]).length === 0
        ? 'troca_par'
        : (payments as any[]).length === 1
        ? (payments as any[])[0].method
        : 'MULTIPLO';
    const finalDetails =
      (payments as any[]).length === 1
        ? (payments as any[])[0].details
        : JSON.stringify({
            split: (payments as any[]).map((p) => ({
              method: p.method,
              valor: p.valor,
              details: p.details ? JSON.parse(p.details) : null,
            })),
          });

    // VENDA ONLINE — quando TODAS as payments são 'venda_online', pula NFC-e
    // automática (cliente recebeu por fora, geralmente não pede nota). Se
    // depois precisar emitir, basta chamar /nfce/emit manualmente.
    const isAllVendaOnline = (payments as any[]).every(
      (p: any) => String(p.method || '').toLowerCase() === 'venda_online',
    );
    // TROCA PAR — quando TODAS as payments são 'vale_troca', tb pula NFC-e.
    // Justificativa fiscal: NFC-e original já cobriu o ICMS da peça devolvida;
    // a troca é substituição, não venda nova com fato gerador. Pular evita
    // rejeição SEFAZ ("tPag inválido", "vNF=0", etc).
    const isAllValeTroca = (payments as any[]).every(
      (p: any) => String(p.method || '').toLowerCase() === 'vale_troca',
    );
    // TOTAL ZERO — defesa em profundidade. Se por qualquer razão sale.total=0
    // (troca par + ajuste, desconto integral, etc), não tem como emitir NFC-e
    // com vNF=0 — SEFAZ rejeita. Skip.
    const isZeroTotal = !sale.total || sale.total < 0.01;
    const skipNfce = isAllVendaOnline || isAllValeTroca || isZeroTotal;

    // Gera STUB do XML NFC-e SÓ se houver fato gerador / NFC-e aplicável
    const nfceStub = skipNfce ? null : this.buildNfceStub(sale, finalMethod);

    const updated = await (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        status: 'finalized',
        paymentMethod: finalMethod,
        paymentDetails: finalDetails,
        finalizedAt: new Date(),
        // 'skipped' = não foi emitida nem é pra emitir automaticamente
        // (venda online / troca par / total zero). Relatório fiscal filtra.
        nfceStatus: skipNfce ? 'skipped' : 'preview',
        nfceXml: nfceStub?.xml ?? null,
        nfceNumber: nfceStub?.numero ?? null,
        nfceSerie: nfceStub?.serie ?? null,
        nfceChave: nfceStub?.chave ?? null,
      },
    });

    this.logger.log(
      `[pdv] Venda ${sale.id} finalizada: R$${sale.total.toFixed(2)} via ${finalMethod} (${(payments as any[]).length} pagamento(s))`,
    );

    // ── SKIP MODO TREINAMENTO ──
    // Venda marcada como treinamento NÃO grava no Wincred nem decrementa estoque
    // nem emite NFC-e nem mexe em marcado/Giga. Só vive no Postgres do FlowOps
    // como histórico do treino — não conta em relatórios financeiros.
    // UNIÃO DE SINAIS: flag da venda OU header da sessão (trainingRequest).
    // Cobre o caso grave: vendedora liga o treino com venda já aberta — a
    // venda não tinha isTraining e executava TUDO real com banner de treino.
    if ((sale as any).isTraining || input.trainingRequest) {
      if (!(sale as any).isTraining && input.trainingRequest) {
        // Marca retroativamente: não conta em relatório e o cancelamento
        // não tenta reverter estoque que nunca foi baixado.
        try {
          await (this.prisma as any).pdvSale.update({
            where: { id: sale.id },
            data: { isTraining: true },
          });
          this.logger.warn(
            `[pdv→TREINO] Venda ${sale.id} criada FORA do treino mas finalizada com sessão em treino — marcada isTraining=true retroativamente.`,
          );
        } catch { /* segue — o skip abaixo já protege o ERP */ }
      }
      this.logger.log(`[pdv→TREINO] Venda ${sale.id} é treinamento — pulando Wincred, estoque, Giga, NFC-e.`);
      return { ok: true, sale: updated, nfcePreview: null, training: true };
    }

    // ── VALE PRESENTE: ativa os vales comprados NESTA venda ──
    // Criados como 'pending' no addGiftVoucher — só valem depois que o
    // dinheiro entrou (venda finalizada). Venda cancelada nunca ativa.
    try {
      const ativados = await (this.prisma as any).pdvReturn.updateMany({
        where: { originalSaleId: sale.id, source: 'vale_presente', status: 'pending' },
        data: { status: 'completed' },
      });
      if (ativados.count > 0) {
        this.logger.log(`[pdv] ${ativados.count} vale(s) presente ativado(s) na venda ${sale.id}`);
      }
    } catch (e: any) {
      this.logger.warn(`[pdv] falha ao ativar vale presente da venda ${sale.id}: ${e?.message || e}`);
    }

    // PÓS-PROCESSAMENTO ERP (Wincred + estoque) — OUTBOX por padrão.
    //
    // PDV_ERP_OUTBOX (default: ligado; '0' desliga):
    //   ligado  → só ENFILEIRA um job em erp_outbox (INSERT local, ~ms) e a
    //             resposta volta na hora. O ErpOutboxService (cron 30s) grava
    //             no Wincred com retry/backoff — Giga fora do ar NÃO trava
    //             mais a finalização; o job espera o Giga voltar.
    //   '0'     → comportamento legado: executa inline (ou fire-and-forget
    //             com PDV_FINALIZE_ASYNC=true).
    const outboxEnabled = String(process.env.PDV_ERP_OUTBOX ?? '').trim() !== '0';
    if (outboxEnabled) {
      try {
        await (this.prisma as any).erpOutbox.upsert({
          where: { kind_saleId: { kind: 'venda', saleId: sale.id } },
          create: { kind: 'venda', saleId: sale.id, payload: { finalMethod } },
          // Já existia (re-finalize raro) — mantém progresso dos sub-passos.
          update: {},
        });
        this.logger.log(`[pdv→outbox] venda ${sale.id} enfileirada pro sync ERP (caixa + estoque)`);
      } catch (e: any) {
        // Enfileirar falhou (não deveria — é o mesmo Postgres da venda).
        // Rede de segurança: dispara o caminho legado em background.
        this.logger.error(
          `[pdv→outbox] falha ao enfileirar venda ${sale.id}: ${e?.message || e} — executando sync legado em background`,
        );
        void this.postFinalizeErpSync(sale, payments as any[], finalMethod).catch((e2: any) =>
          this.logger.error(`[pdv] postFinalizeErpSync (fallback) falhou pra venda ${sale.id}: ${e2?.message || e2}`),
        );
      }
    } else {
      const finalizeAsync =
        String(process.env.PDV_FINALIZE_ASYNC ?? '').trim().toLowerCase() === 'true';
      if (finalizeAsync) {
        void this.postFinalizeErpSync(sale, payments as any[], finalMethod).catch((e: any) =>
          this.logger.error(
            `[pdv] postFinalizeErpSync (async) falhou pra venda ${sale.id}: ${e?.message || e}`,
          ),
        );
      } else {
        await this.postFinalizeErpSync(sale, payments as any[], finalMethod);
      }
    }

    // VALE-TROCA — marca como USED todo pdvReturn cujo creditoCode foi usado
    // como pagamento nessa venda. Idempotente: se já tava 'used', segue.
    try {
      const valeTrocaPayments = (payments as any[]).filter(
        (p: any) => p.method === 'vale_troca',
      );
      for (const p of valeTrocaPayments) {
        let code: string | null = null;
        try {
          const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
          code = String(det?.creditoCode || '').trim().toUpperCase() || null;
        } catch { /* ignora */ }
        if (!code) continue;
        const ret = await (this.prisma as any).pdvReturn.findUnique({
          where: { creditoCode: code },
        });
        if (!ret) {
          this.logger.warn(`[pdv] vale-troca ${code} não achado pra marcar como usado`);
          continue;
        }
        if (ret.status === 'used') continue; // idempotente
        await (this.prisma as any).pdvReturn.update({
          where: { id: ret.id },
          data: {
            status: 'used',
            creditoUsadoEm: sale.id,
            creditoUsadoAt: new Date(),
          },
        });
        this.logger.log(`[pdv] vale-troca ${code} marcado como USED na venda ${sale.id}`);

        // FIX uso PARCIAL: se o vale cobriu MENOS que o valor total dele, gera
        // automaticamente um vale RESIDUAL com a diferença pra cliente NÃO
        // perder o saldo. Idempotente: pula se já existe residual pra esta
        // venda (cobre também o caso do botão manual "Gerar vale do saldo",
        // cujo motivo também contém "residual") → nunca duplica crédito.
        try {
          const usado = Number(p.valor) || 0;
          const totalVale = Number(ret.valorTotal) || 0;
          const sobra = Math.round((totalVale - usado) * 100) / 100;
          if (sobra > 0.01) {
            const jaTemResidual = await (this.prisma as any).pdvReturn.findFirst({
              where: {
                originalSaleId: sale.id,
                modo: 'credito',
                status: { not: 'cancelled' },
                motivo: { contains: 'residual', mode: 'insensitive' },
              },
              select: { id: true },
            });
            if (!jaTemResidual) {
              const novoCode = `TROCA-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
              await (this.prisma as any).pdvReturn.create({
                data: {
                  originalSaleId: sale.id,
                  originalSaleNumber: (ret as any).originalSaleNumber || null,
                  storeCode: (ret as any).storeCode,
                  storeName: (ret as any).storeName,
                  cashSessionId: null,
                  modo: 'credito',
                  valorTotal: sobra,
                  status: 'completed',
                  customerCpf: (ret as any).customerCpf || null,
                  customerName: (ret as any).customerName || null,
                  creditoCode: novoCode,
                  creditoValidade: new Date(Date.now() + 90 * 86400_000),
                  isTraining: !!(ret as any).isTraining,
                  motivo: `Saldo residual do vale ${code} (uso parcial na venda ${sale.id})`,
                },
              });
              this.logger.log(
                `[pdv] vale RESIDUAL automático ${novoCode} R$${sobra.toFixed(2)} (sobra do ${code})`,
              );
            }
          }
        } catch (e2: any) {
          this.logger.warn(`[pdv] falha ao gerar vale residual do ${code}: ${e2?.message || e2}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[pdv] erro ao marcar vale-troca como usado: ${e?.message || e}`);
    }

    // ── ATUALIZA CRM (Customer) ──────────────────────────────────────────
    // Fase 4 da captura PDV: ao finalizar venda real, soma LTV/orderCount
    // do cliente no Customer. Pula treinamento e vendas sem CPF.
    if (sale.customerCpf && !(sale as any).isTraining) {
      try {
        await this._atualizarCustomerAposVenda(updated);
      } catch (e: any) {
        this.logger.warn(`[pdv→CRM] falha ao atualizar Customer: ${e?.message || e}`);
      }
    }

    return { ok: true, sale: updated, nfcePreview: nfceStub };
  }

  /**
   * PÓS-PROCESSAMENTO ERP do finalize(): gravação da venda no Wincred
   * (tabela `caixa`) + baixa de estoque + marcação de stockDecreasedAt.
   *
   * Extraído do finalize() pra permitir execução assíncrona via flag
   * PDV_FINALIZE_ASYNC (fire-and-forget). Erros aqui NUNCA bloqueiam a venda
   * — o Postgres do flowops é a fonte da verdade; cada bloco tem try/catch
   * próprio que só loga warning (mesmo comportamento de quando era inline).
   *
   * IMPORTANTE: recebe tudo por parâmetro (sale/payments/finalMethod) — não
   * depende de estado capturado do finalize, pra ser seguro rodar destacado.
   */
  private async postFinalizeErpSync(
    sale: any,
    payments: any[],
    finalMethod: string,
  ): Promise<void> {
    // Caminho LEGADO (PDV_ERP_OUTBOX=0) — executa os dois passos em sequência,
    // engolindo erro com warning (comportamento histórico).
    const caixa = await this.erpStepGravarCaixa(sale, payments, finalMethod);
    if (!caixa.ok) {
      this.logger.warn(
        `[pdv→wincred] Venda ${sale.id} NÃO gravada no Wincred: ${caixa.error}. Venda no flowops segue OK.`,
      );
    }
    const estoque = await this.erpStepBaixarEstoque(sale);
    if (!estoque.ok) {
      this.logger.warn(
        `[pdv→estoque] Venda ${sale.id}: falha na baixa de estoque — ${estoque.error}. Venda no flowops segue OK.`,
      );
    }
  }

  /**
   * PASSO 1 do sync ERP: grava a venda na tabela `caixa` do Wincred.
   * Retorna status estruturado (o outbox usa pra decidir retry).
   * mode='shadow' (PDV_ERP_WRITE_ENABLED=false) conta como ok — nada mais a fazer.
   */
  async erpStepGravarCaixa(
    sale: any,
    payments: any[],
    finalMethod: string,
  ): Promise<{ ok: boolean; mode?: string; error?: string }> {
    try {
      // ⚡ Rateia o sale.desconto (desconto GERAL via F2) proporcionalmente
      // entre os items — sem isso o Wincred gravava valor SEM o desconto
      // geral, distorcendo o fechamento de caixa.
      const saleItems = (sale.items || []) as any[];
      const descontoGeral = Number(sale.desconto) || 0;
      const baseRateio = saleItems
        .filter((it: any) => (Number(it.precoUnit) || 0) > 0)
        .reduce((s, it: any) => s + (Number(it.precoUnit) || 0) * (Number(it.qty) || 1), 0);
      const result = await this.erp.gravarVendaPdv({
        storeCode: sale.storeCode,
        items: saleItems.map((it: any) => {
          const valorUnit = Number(it.precoUnit) || 0;
          const qty = Number(it.qty) || 1;
          const descontoItem = Number(it.desconto) || 0;
          const bruto = valorUnit * qty;
          let descontoRateado = 0;
          if (descontoGeral > 0 && baseRateio > 0 && bruto > 0) {
            descontoRateado = Math.round((descontoGeral * (bruto / baseRateio)) * 100) / 100;
          }
          return {
            sku: String(it.sku || it.ean || ''),
            qty,
            valorUnit,
            desconto: descontoItem + descontoRateado,
            descricao: String(it.descricao || ''),
            tributo: it.cfop ? String(it.cfop).slice(0, 4) : undefined,
          };
        }),
        // Pagamentos: usa array payments (após split) ou fallback pro paymentMethod legado.
        // Quando método é credito/debito genérico, extrai a bandeira do details
        // (ex: method='credito' + details.bandeira='MASTERCARD' → mapeia como MASTERCARD).
        pagamentos: payments.length > 0
          ? payments.map((p: any) => {
              let metodo = String(p.method || '');
              const generico = metodo === 'credito' || metodo === 'debito' || metodo === 'cartao';
              if (generico && p.details) {
                try {
                  const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
                  if (det?.bandeira) {
                    metodo = String(det.bandeira); // MASTERCARD, VISA, ELO etc.
                  }
                } catch { /* ignora details inválido */ }
              }
              return { metodo, valor: Number(p.valor) || 0 };
            })
          : [{ metodo: finalMethod, valor: sale.total }],
        clienteCode: 0,
        clienteCpf: sale.customerCpf || undefined,
        nomeCliente: sale.customerName || undefined,
        // Vendedora pra comissão (Seller) tem prioridade. Senão, usa operador
        // (vendedorName = quem digitou). lookup é automático no erp.service.
        vendedorName: sale.sellerName || sale.vendedorName || undefined,
        operadorName: sale.vendedorName || undefined,
        obsPedido: `flowops-${sale.id.slice(0, 8)}`,
      });
      if (!result.ok) {
        return { ok: false, mode: result.mode, error: result.error || 'gravarVendaPdv retornou ok=false' };
      }
      if (result.mode === 'shadow') {
        this.logger.warn(
          `[pdv→wincred SHADOW] Venda ${sale.id}: ${result.sqlExecuted.length} SQLs gerados (não executados). Set PDV_ERP_WRITE_ENABLED=true pra ativar.`,
        );
        return { ok: true, mode: 'shadow' };
      }
      this.logger.log(
        `[pdv→wincred REAL] Venda ${sale.id} → caixa NUMERO=${result.numero} (${result.registros?.length} registros)`,
      );
      return { ok: true, mode: 'real' };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * Um item baixa estoque no ERP? Exclui SÓ o que não é produto de catálogo:
   *   - sku vazio
   *   - sku 'MANUAL-...' e ref 'MANUAL' → linha avulsa (vale presente, peça sem
   *     cadastro, ajuste manual) — não existe no estoque.
   *   - ref/promoTag 'MARCADO' → item "provar em casa", estoque já tratado.
   *
   * IMPORTANTE (16/07): NÃO excluir por promoTag==='MANUAL'. Produto real que
   * recebeu desconto manual por item ganha promoTag='MANUAL' (pra fugir do
   * applyAutoDiscounts) mas TEM sku/ref reais e PRECISA baixar estoque. O filtro
   * antigo pulava esses → estoque fantasma (ex: casaco 700961/46 em São José,
   * vendido 14/07 e ainda em estoque). Como a venda marcava stockDecreasedAt
   * mesmo assim, o reconcile normal nunca achava.
   */
  private isStockEligibleItem(it: any): boolean {
    const sku = String(it?.sku || '').trim();
    if (!sku) return false;
    if (sku.startsWith('MANUAL-')) return false;
    if (it?.ref === 'MANUAL') return false;
    if (it?.ref === 'MARCADO') return false;
    if (it?.promoTag === 'MARCADO') return false;
    return true;
  }

  /** Item real (sku/ref de catálogo) que só virou MANUAL por desconto manual. */
  private isManualPricedRealItem(it: any): boolean {
    return it?.promoTag === 'MANUAL' && this.isStockEligibleItem(it);
  }

  /**
   * PASSO 2 do sync ERP: baixa de estoque no Wincred.
   * PULA items MANUAL/MARCADO. allowNegative + skipNotFound (divergências não
   * bloqueiam). Marca sale.stockDecreasedAt no sucesso — mesma flag usada pelo
   * reconcileStockBacklog, então o backlog continua funcionando como rede de
   * segurança. Idempotente: se stockDecreasedAt já está marcado, não repete.
   */
  async erpStepBaixarEstoque(
    sale: any,
  ): Promise<{ ok: boolean; skippedWriteDisabled?: boolean; error?: string }> {
    try {
      // Guard de idempotência — retry do outbox nunca baixa estoque 2x.
      const fresh = await (this.prisma as any).pdvSale.findUnique({
        where: { id: sale.id },
        select: { stockDecreasedAt: true },
      });
      if (fresh?.stockDecreasedAt) return { ok: true };

      if (!this.erp.isWriteEnabled) {
        this.logger.warn(
          `[pdv→estoque] Venda ${sale.id}: ERP_WRITE_ENABLED=false — estoque NAO baixado no Wincred.`,
        );
        // Sem permissão de escrita não adianta re-tentar — o reconcile pega
        // depois (stockDecreasedAt continua null).
        return { ok: true, skippedWriteDisabled: true };
      }

      const saleItems = (sale.items || []) as any[];
      // Itens que BAIXAM estoque. NOTA (16/07): NÃO filtrar por
      // promoTag==='MANUAL' — isso pulava produto REAL que só recebeu desconto
      // manual por item (sku/ref reais), deixando estoque fantasma. O item
      // avulso de verdade (vale presente / sem cadastro) já é excluído pelo
      // sku 'MANUAL-...' e ref 'MANUAL'. Ver isStockEligibleItem().
      const eligible = saleItems.filter((it: any) => this.isStockEligibleItem(it));
      const stockItems = eligible.map((it: any) => ({
        sku: String(it.sku || '').trim(),
        qty: Math.max(1, Number(it.qty) || 1),
        storeCode: sale.storeCode,
      }));

      if (stockItems.length === 0) {
        try {
          await (this.prisma as any).pdvSale.update({
            where: { id: sale.id },
            data: { stockDecreasedAt: new Date() },
          });
        } catch { /* segue */ }
        return { ok: true };
      }

      const r = await this.erp.decreaseStock(stockItems, {
        allowNegative: true,
        skipNotFound: true,
      });
      if (!r.success) {
        return {
          ok: false,
          error: `${r.error || 'falha desconhecida'} · items: ${stockItems.map((i) => i.sku).join(',')}`,
        };
      }
      this.logger.log(
        `[pdv→estoque] Venda ${sale.id}: ${r.applied.length} item(s) baixado(s) no Wincred ` +
        `(loja ${sale.storeCode}) em ${r.attempts || 1} tentativa(s).`,
      );
      try {
        const nowStamp = new Date();
        await (this.prisma as any).pdvSale.update({
          where: { id: sale.id },
          data: { stockDecreasedAt: nowStamp },
        });
        // Marca a flag POR ITEM nos que baixaram — o backfill de manuais
        // (reconcileManualStockBacklog) usa isso pra não re-baixar.
        const ids = eligible.map((it: any) => it.id).filter(Boolean);
        if (ids.length > 0) {
          await (this.prisma as any).pdvSaleItem.updateMany({
            where: { id: { in: ids } },
            data: { stockDecreasedAt: nowStamp },
          });
        }
      } catch { /* segue */ }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * Atualiza o Customer (CRM) após uma venda finalizada com CPF.
   *
   * Comportamento:
   *  1. Busca Customer por CPF (com e sem formatação)
   *  2. Se não existe, cria com originStoreId = loja da venda
   *  3. Se existe, atualiza:
   *      - orderCount += 1
   *      - ltvCents += sale.total
   *      - lastOrderAt = now
   *      - ticketMedio = ltv / orderCount
   *      - vipTier recalculado conforme régua oficial
   *
   * Tier: bronze<500 / prata 500-1500 / ouro 1500-5000 / diamante 5000+
   *
   * Skip: vendas de treinamento, sem CPF, ou total<=0.
   */
  private async _atualizarCustomerAposVenda(sale: any): Promise<void> {
    const cpfDigits = String(sale.customerCpf || '').replace(/\D/g, '');
    if (cpfDigits.length !== 11) return;
    const totalCents = Math.round(Number(sale.total || 0) * 100);
    if (totalCents <= 0) return;

    // CPF formatado padrão FlowOps (123.456.789-01)
    const cpfFmt = `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`;

    const existing = await (this.prisma as any).customer.findFirst({
      where: { OR: [{ cpf: cpfDigits }, { cpf: cpfFmt }] },
      select: {
        id: true, ltvCents: true, orderCount: true, vipTier: true,
        tierEnteredAt: true, originStoreId: true, originSource: true,
      },
    });

    // Helper: calcula tier conforme régua oficial
    const calcTier = (ltvCents: bigint | number): string => {
      const reais = Number(ltvCents) / 100;
      if (reais < 500) return 'bronze';
      if (reais < 1500) return 'prata';
      if (reais < 5000) return 'ouro';
      return 'diamante';
    };

    if (!existing) {
      // Cliente NOVO — cria no CRM com 1ª compra + tier conforme régua
      // originStoreId = loja da venda (vendedora cadastrou no PDV)
      const store = sale.storeCode
        ? await (this.prisma as any).store.findUnique({ where: { code: sale.storeCode } })
        : null;
      const novoTier = calcTier(totalCents);
      await (this.prisma as any).customer.create({
        data: {
          cpf: cpfFmt,
          name: sale.customerName || null,
          email: sale.customerEmail?.toLowerCase()?.trim() || null,
          whatsapp: String(sale.customerPhone || '').replace(/\D/g, '') || null,
          originSource: 'pdv',
          originStoreId: store?.id || null,
          ltvCents: BigInt(totalCents),
          orderCount: 1,
          lastOrderAt: new Date(),
          ticketMedioCents: totalCents,
          vipTier: novoTier,
          tierEnteredAt: new Date(),
          active: true,
          cashbackBalance: { create: {} },
        },
      });
      this.logger.log(`[pdv→CRM] Cliente NOVO criado: ${cpfFmt} · LTV inicial R$${(totalCents/100).toFixed(2)} · ${novoTier}`);
      return;
    }

    // Cliente EXISTENTE — soma venda no LTV/orderCount e recalcula tier
    const novoLtv = BigInt(existing.ltvCents || 0) + BigInt(totalCents);
    const novoCount = (existing.orderCount || 0) + 1;
    const novoTier = calcTier(novoLtv);
    const tierMudou = novoTier !== existing.vipTier;

    await (this.prisma as any).customer.update({
      where: { id: existing.id },
      data: {
        ltvCents: novoLtv,
        orderCount: novoCount,
        lastOrderAt: new Date(),
        ticketMedioCents: Math.round(Number(novoLtv) / novoCount),
        vipTier: novoTier,
        ...(tierMudou ? { tierEnteredAt: new Date() } : {}),
      },
    });
    this.logger.log(
      `[pdv→CRM] Cliente ${existing.id}: +R$${(totalCents/100).toFixed(2)} ` +
      `→ LTV R$${(Number(novoLtv)/100).toFixed(2)} (${novoCount}x) ${tierMudou ? `· tier ${existing.vipTier} → ${novoTier}` : ''}`,
    );
  }

  async cancel(input: { saleId: string; reason?: string }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      include: { payments: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status === 'cancelled')
      throw new BadRequestException('Venda já está cancelada');
    // Venda FINALIZADA só pode ser cancelada via Estorno master (senha de
    // administrador + justificativa + reversão de estoque/fiscal). O cancel
    // simples é só pra venda em aberto (carrinho) — não fura o estorno.
    if (sale.status === 'finalized')
      throw new BadRequestException(
        'Venda finalizada — use o Estorno (exige senha de administrador e justificativa).',
      );

    const updated = await (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: input.reason || null,
      },
    });

    // FIX: cancelar venda DEVOLVE o vale-troca usado nela. Sem isso, o cliente
    // que pagou com vale e teve a venda cancelada PERDIA o crédito (o vale
    // ficava 'used' pra sempre). Reverte pra 'completed' e limpa o uso.
    try {
      const valePayments = ((sale as any).payments || []).filter(
        (p: any) => p.method === 'vale_troca',
      );
      for (const p of valePayments) {
        let code: string | null = null;
        try {
          const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
          code = String(det?.creditoCode || '').trim().toUpperCase() || null;
        } catch { /* ignora */ }
        if (!code) continue;
        const ret = await (this.prisma as any).pdvReturn.findUnique({
          where: { creditoCode: code },
        });
        // Só restaura o vale se ele foi consumido JUSTAMENTE nesta venda.
        if (ret && ret.status === 'used' && ret.creditoUsadoEm === sale.id) {
          await (this.prisma as any).pdvReturn.update({
            where: { id: ret.id },
            data: { status: 'completed', creditoUsadoEm: null, creditoUsadoAt: null },
          });
          this.logger.log(`[pdv] cancel: vale ${code} DEVOLVIDO (venda ${sale.id} cancelada)`);
        }
      }
      // ANULA vales RESIDUAIS gerados a partir desta venda (uso parcial). Sem
      // isso, restaurar o vale original E manter o residual = DUPLO crédito.
      // Só anula residuais ainda NÃO usados (se já foi gasto, não dá pra anular).
      const anulados = await (this.prisma as any).pdvReturn.updateMany({
        where: {
          originalSaleId: sale.id,
          modo: 'credito',
          status: { notIn: ['used', 'cancelled'] },
          motivo: { contains: 'residual', mode: 'insensitive' },
        },
        data: { status: 'cancelled' },
      });
      if (anulados?.count) {
        this.logger.log(`[pdv] cancel: ${anulados.count} vale(s) residual(is) anulado(s) da venda ${sale.id}`);
      }
    } catch (e: any) {
      this.logger.warn(`[pdv] cancel: erro ao devolver/anular vale: ${e?.message || e}`);
    }

    return updated;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // RECONCILIACAO DE ESTOQUE — script admin pra baixar estoque retroativo
  // de vendas finalizadas que NAO baixaram estoque (bug historico fixado).
  //
  // Idempotente via flag stockDecreasedAt: vendas ja processadas sao puladas.
  // Pode rodar em modo dryRun=true (preview, sem mudar nada) ou execute.
  // ═════════════════════════════════════════════════════════════════════════

  // ═════════════════════════════════════════════════════════════════════════
  // CLEANUP de VENDAS FANTASMA — open + items vazios + criadas ha > X min.
  // Sao vendas criadas quando vendedora abre o PDV mas nao bipa nada e sai.
  // Acumulam ao longo do dia e poluem o "Pausadas". Esse metodo cancela elas
  // em lote (status='cancelled' com reason='auto-cleanup-fantasma').
  // ═════════════════════════════════════════════════════════════════════════
  async cleanupGhostSales(input: {
    olderThanMinutes?: number;
    storeCode?: string;
    dryRun?: boolean;
  }): Promise<{
    mode: 'dry-run' | 'executed';
    cutoff: string;
    storeCode: string | null;
    encontradas: number;
    canceladas: number;
    ids: string[];
  }> {
    const olderThanMinutes = Math.max(1, input.olderThanMinutes || 30);
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    const dryRun = !!input.dryRun;
    const storeCode = input.storeCode?.trim() || null;

    const where: any = {
      status: 'open',
      createdAt: { lt: cutoff },
      items: { none: {} },
    };
    if (storeCode) where.storeCode = storeCode;

    const fantasmas = await (this.prisma as any).pdvSale.findMany({
      where,
      select: { id: true },
      take: 500,
    });
    const ids = (fantasmas as any[]).map((s) => s.id);

    if (dryRun || ids.length === 0) {
      return {
        mode: dryRun ? 'dry-run' : 'executed',
        cutoff: cutoff.toISOString(),
        storeCode,
        encontradas: ids.length,
        canceladas: 0,
        ids,
      };
    }

    const r = await (this.prisma as any).pdvSale.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: 'auto-cleanup-fantasma',
      },
    });

    this.logger.log(`[pdv/cleanup] ${r.count} venda(s) fantasma canceladas (criadas antes de ${cutoff.toISOString()})`);

    return {
      mode: 'executed',
      cutoff: cutoff.toISOString(),
      storeCode,
      encontradas: ids.length,
      canceladas: r.count,
      ids,
    };
  }

  async reconcileStockBacklog(input: {
    sinceIso?: string;
    untilIso?: string;
    storeCode?: string;
    dryRun?: boolean;
    limit?: number;
  }): Promise<{
    mode: 'dry-run' | 'executed';
    sinceIso: string;
    untilIso: string;
    storeCode: string | null;
    totalSalesEncontradas: number;
    salesProcessadas: number;
    itemsAgregados: number;
    qtdTotal: number;
    falhas: Array<{ saleId: string; storeCode: string; error: string }>;
    aplicados: number;
    finished: boolean;
  }> {
    const sinceIso = input.sinceIso
      || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const since = new Date(sinceIso);
    const untilIso = input.untilIso || new Date().toISOString();
    const until = new Date(untilIso);
    const limit = Math.max(1, Math.min(500, input.limit || 100));
    const dryRun = !!input.dryRun;
    const storeCode = input.storeCode?.trim() || null;

    const where: any = {
      status: 'finalized',
      finalizedAt: { gte: since, lte: until },
      stockDecreasedAt: null,
      // CRÍTICO: venda de TREINO fica finalizada SEM baixa de estoque DE
      // PROPÓSITO (finalize pula ERP). Sem este filtro, o backfill pegava
      // essas vendas e baixava estoque REAL no Wincred — era a causa do
      // "modo treinamento baixando estoque" (loja 15, jun/2026).
      isTraining: false,
    };
    if (storeCode) where.storeCode = storeCode;

    const totalSalesEncontradas = await (this.prisma as any).pdvSale.count({ where });

    const sales = await (this.prisma as any).pdvSale.findMany({
      where,
      orderBy: { finalizedAt: 'asc' },
      take: limit,
      include: {
        items: {
          select: { id: true, sku: true, qty: true, ref: true, promoTag: true },
        },
      },
    });

    const falhas: Array<{ saleId: string; storeCode: string; error: string }> = [];
    let aplicados = 0;
    let itemsAgregados = 0;
    let qtdTotal = 0;

    for (const sale of sales as any[]) {
      try {
        // Mesmo critério do bipe (isStockEligibleItem): produto real com
        // desconto manual (promoTag='MANUAL' + sku/ref reais) TAMBÉM baixa.
        const eligible = (sale.items as any[]).filter((it) => this.isStockEligibleItem(it));
        const stockItems = eligible.map((it) => ({
          sku: String(it.sku || '').trim(),
          qty: Math.max(1, Number(it.qty) || 1),
          storeCode: sale.storeCode,
        }));

        if (stockItems.length === 0) {
          if (!dryRun) {
            await (this.prisma as any).pdvSale.update({
              where: { id: sale.id },
              data: { stockDecreasedAt: new Date() },
            });
          }
          continue;
        }

        itemsAgregados += stockItems.length;
        qtdTotal += stockItems.reduce((s, i) => s + i.qty, 0);

        if (dryRun) continue;

        if (!this.erp.isWriteEnabled) {
          falhas.push({
            saleId: sale.id,
            storeCode: sale.storeCode,
            error: 'ERP_WRITE_ENABLED=false — sem permissao pra baixar estoque',
          });
          continue;
        }

        const r = await this.erp.decreaseStock(stockItems, {
          allowNegative: true,
          skipNotFound: true,
        });

        if (!r.success) {
          falhas.push({
            saleId: sale.id,
            storeCode: sale.storeCode,
            error: r.error || 'falha desconhecida',
          });
        } else {
          aplicados++;
          const nowStamp = new Date();
          await (this.prisma as any).pdvSale.update({
            where: { id: sale.id },
            data: { stockDecreasedAt: nowStamp },
          });
          const ids = eligible.map((it: any) => it.id).filter(Boolean);
          if (ids.length > 0) {
            await (this.prisma as any).pdvSaleItem.updateMany({
              where: { id: { in: ids } },
              data: { stockDecreasedAt: nowStamp },
            });
          }
        }
      } catch (e: any) {
        falhas.push({
          saleId: sale.id,
          storeCode: sale.storeCode,
          error: e?.message || String(e),
        });
      }
    }

    return {
      mode: dryRun ? 'dry-run' : 'executed',
      sinceIso,
      untilIso,
      storeCode,
      totalSalesEncontradas,
      salesProcessadas: (sales as any[]).length,
      itemsAgregados,
      qtdTotal,
      falhas,
      aplicados,
      finished: (sales as any[]).length < limit,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // BACKFILL de ESTOQUE FANTASMA "MANUAL" (16/07)
  //
  // Caso invisível ao reconcile normal: produto REAL (sku/ref de catálogo)
  // vendido com DESCONTO MANUAL por item ganhou promoTag='MANUAL' e o filtro
  // antigo o excluía da baixa — MAS a venda marcava sale.stockDecreasedAt do
  // mesmo jeito. Resultado: item nunca baixou e o reconcile (que busca
  // sale.stockDecreasedAt=null) nunca o via.
  //
  // Aqui a busca é POR ITEM: promoTag='MANUAL' + sku/ref reais + a flag NOVA
  // item.stockDecreasedAt=null. Idempotente via essa flag por item — a baixa
  // do bipe/reconcile (já corrigidos) também a marca, então nada roda 2x.
  // ═════════════════════════════════════════════════════════════════════════
  async reconcileManualStockBacklog(input: {
    sinceIso?: string;
    untilIso?: string;
    storeCode?: string;
    dryRun?: boolean;
    limit?: number;
  }): Promise<{
    mode: 'dry-run' | 'executed';
    sinceIso: string;
    untilIso: string;
    storeCode: string | null;
    itemsEncontrados: number;
    qtdTotal: number;
    porLoja: Record<string, { itens: number; qtd: number }>;
    amostra: Array<{ saleId: string; storeCode: string; sku: string; ref: string | null; qty: number; finalizedAt: string | null }>;
    aplicados: number;
    falhas: Array<{ itemId: string; sku: string; storeCode: string; error: string }>;
    finished: boolean;
  }> {
    const sinceIso = input.sinceIso
      || new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const since = new Date(sinceIso);
    const untilIso = input.untilIso || new Date().toISOString();
    const until = new Date(untilIso);
    const limit = Math.max(1, Math.min(2000, input.limit || 1000));
    const dryRun = !!input.dryRun;
    const storeCode = input.storeCode?.trim() || null;

    // Itens MANUAL de produto real ainda não baixados, em vendas finalizadas
    // (não treino) na janela. O sku/ref reais separam do avulso (MANUAL-...).
    const where: any = {
      promoTag: 'MANUAL',
      stockDecreasedAt: null,
      NOT: [
        { sku: { startsWith: 'MANUAL-' } },
        { ref: 'MANUAL' },
        { ref: 'MARCADO' },
      ],
      sale: {
        is: {
          status: 'finalized',
          isTraining: false,
          finalizedAt: { gte: since, lte: until },
          ...(storeCode ? { storeCode } : {}),
        },
      },
    };

    const items: any[] = await (this.prisma as any).pdvSaleItem.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true, sku: true, ref: true, qty: true,
        sale: { select: { id: true, storeCode: true, finalizedAt: true } },
      },
    });

    const porLoja: Record<string, { itens: number; qtd: number }> = {};
    let qtdTotal = 0;
    for (const it of items) {
      const loja = String(it.sale?.storeCode || '??');
      const q = Math.max(1, Number(it.qty) || 1);
      qtdTotal += q;
      if (!porLoja[loja]) porLoja[loja] = { itens: 0, qtd: 0 };
      porLoja[loja].itens += 1;
      porLoja[loja].qtd += q;
    }
    const amostra = items.slice(0, 30).map((it) => ({
      saleId: it.sale?.id,
      storeCode: it.sale?.storeCode,
      sku: it.sku,
      ref: it.ref,
      qty: it.qty,
      finalizedAt: it.sale?.finalizedAt ? new Date(it.sale.finalizedAt).toISOString() : null,
    }));

    const base = {
      sinceIso, untilIso, storeCode,
      itemsEncontrados: items.length,
      qtdTotal, porLoja, amostra,
      finished: items.length < limit,
    };

    if (dryRun) {
      return { mode: 'dry-run', ...base, aplicados: 0, falhas: [] };
    }

    if (!this.erp.isWriteEnabled) {
      return {
        mode: 'executed', ...base, aplicados: 0,
        falhas: items.map((it) => ({
          itemId: it.id, sku: it.sku, storeCode: it.sale?.storeCode,
          error: 'ERP_WRITE_ENABLED=false — sem permissao pra baixar estoque',
        })),
      };
    }

    let aplicados = 0;
    const falhas: Array<{ itemId: string; sku: string; storeCode: string; error: string }> = [];

    // Baixa item a item (cada um pode ser de loja diferente) e marca a flag
    // POR ITEM só quando a baixa dá certo — retry seguro.
    for (const it of items) {
      const loja = String(it.sale?.storeCode || '').trim();
      const sku = String(it.sku || '').trim();
      const qty = Math.max(1, Number(it.qty) || 1);
      if (!loja || !sku) {
        falhas.push({ itemId: it.id, sku, storeCode: loja, error: 'sku/loja ausente' });
        continue;
      }
      try {
        const r = await this.erp.decreaseStock(
          [{ sku, qty, storeCode: loja }],
          { allowNegative: true, skipNotFound: true },
        );
        if (!r.success) {
          falhas.push({ itemId: it.id, sku, storeCode: loja, error: r.error || 'falha desconhecida' });
          continue;
        }
        await (this.prisma as any).pdvSaleItem.update({
          where: { id: it.id },
          data: { stockDecreasedAt: new Date() },
        });
        aplicados++;
      } catch (e: any) {
        falhas.push({ itemId: it.id, sku, storeCode: loja, error: e?.message || String(e) });
      }
    }

    this.logger.log(
      `[pdv/reconcile-manual] ${aplicados} item(s) MANUAL baixado(s), ${falhas.length} falha(s) ` +
      `(janela ${sinceIso}..${untilIso})`,
    );

    return { mode: 'executed', ...base, aplicados, falhas };
  }

  /**
   * Stub do XML NFC-e — só pra mostrar na UI o que SERIA enviado pra SEFAZ.
   * Quando integrar SEFAZ real, vira o XML assinado de verdade.
   */
  private buildNfceStub(sale: any, paymentMethod: string) {
    const numero = String(Date.now()).slice(-9);
    const serie = '001';
    // Chave fictícia (44 dígitos) só pra preview
    const chave = `35${new Date().toISOString().slice(2, 7).replace('-', '')}00000000000000550010000000000${numero}`.slice(0, 44);

    const itensXml = sale.items
      .map((it: any, idx: number) => `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${it.sku}</cProd>
        <cEAN>${it.ean || 'SEM GTIN'}</cEAN>
        <xProd>${this.escapeXml(it.descricao)}</xProd>
        <NCM>${it.ncm || '00000000'}</NCM>
        <CFOP>${it.cfop || '5102'}</CFOP>
        <uCom>UN</uCom>
        <qCom>${it.qty}.00</qCom>
        <vUnCom>${it.precoUnit.toFixed(2)}</vUnCom>
        <vProd>${it.total.toFixed(2)}</vProd>
      </prod>
    </det>`)
      .join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe${chave}" versao="4.00">
    <ide>
      <cUF>35</cUF>
      <natOp>VENDA AO CONSUMIDOR</natOp>
      <mod>65</mod>
      <serie>${serie}</serie>
      <nNF>${numero}</nNF>
      <dhEmi>${new Date().toISOString()}</dhEmi>
      <tpNF>1</tpNF>
      <tpAmb>2</tpAmb>
    </ide>
    <emit>
      <CNPJ>00000000000000</CNPJ>
      <xNome>LURDS PLUS SIZE - ${this.escapeXml(sale.storeName)}</xNome>
    </emit>
    ${sale.customerCpf ? `<dest><CPF>${sale.customerCpf}</CPF>${sale.customerName ? `<xNome>${this.escapeXml(sale.customerName)}</xNome>` : ''}</dest>` : ''}
    ${itensXml}
    <total>
      <ICMSTot>
        <vProd>${sale.subtotal.toFixed(2)}</vProd>
        <vDesc>${sale.desconto.toFixed(2)}</vDesc>
        <vNF>${sale.total.toFixed(2)}</vNF>
      </ICMSTot>
    </total>
    <pag>
      <detPag>
        <tPag>${this.mapPaymentToTpag(paymentMethod)}</tPag>
        <vPag>${sale.total.toFixed(2)}</vPag>
      </detPag>
    </pag>
  </infNFe>
</NFe>`;
    return { xml, numero, serie, chave };
  }

  private escapeXml(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private mapPaymentToTpag(method: string): string {
    // Códigos SEFAZ tabela 38
    switch (method) {
      case 'dinheiro': return '01';
      case 'cheque': return '02';
      case 'credito': return '03';
      case 'debito': return '04';
      case 'crediario': return '05';
      case 'pix': return '17';
      case 'vale': return '10';
      default: return '99';
    }
  }
}
