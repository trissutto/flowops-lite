import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  digitsOnly,
} from '../person-identity/identity-normalization';
import { chavesDeEndereco, semAcento } from './endereco-normalizacao';

/** Os tipos de chave que o motor sabe cruzar. */
export type TipoChave =
  | 'cpf'
  | 'email'
  | 'telefone'
  | 'endereco'
  | 'cep_numero'
  | 'cartao'
  | 'titular'
  | 'ip'
  | 'aparelho';

export interface Chave {
  tipo: TipoChave;
  valor: string;
}

/**
 * DADO SINTÉTICO NUNCA VIRA CHAVE.
 *
 * O sistema gera cliente falso em dois caminhos vivos: o link de pagamento do
 * PDV (`pdv-<id>@lurds.com.br`, telefone da matriz 13 996218277) e o PagBank
 * (`consumidor@lurds.com.br`). São dezenas ou centenas de registros com o
 * MESMO valor — se virassem chave, o módulo abriria no primeiro dia dizendo
 * que meia rede tem relação com meia rede.
 *
 * É o mesmo defeito que a Pagar.me já nos cobrou do outro lado do balcão: o
 * antifraude DELA leu nosso telefone repetido como assinatura de fraude e
 * derrubou a aprovação de cartão de 63% pra 22,8% (medição de 01/08). Aqui a
 * gente evita cometer o mesmo erro contra a nossa própria cliente.
 */
const EMAIL_SINTETICO = /^(pdv-[^@]+|consumidor|contato|matriz|vendas?)@lurds\.com\.br$/i;
const TELEFONE_SINTETICO = new Set(['13996218277', '996218277']);

/** Valor curto demais não identifica ninguém — só junta. */
const MIN_TAMANHO: Partial<Record<TipoChave, number>> = {
  titular: 6,
  endereco: 8,
  ip: 7,
};

@Injectable()
export class RiscoChavesService {
  private readonly logger = new Logger(RiscoChavesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * AS CHAVES DE UM PEDIDO — função pura, testável sem banco.
   *
   * Recebe a linha do pedido como ela sai do Prisma (com os JSON ainda em
   * texto) e devolve o que dá pra cruzar. O que não dá, simplesmente não sai:
   * chave duvidosa é pior que chave faltando.
   *
   * ⚠️ NOME NÃO É CHAVE, de propósito. O documento pede o nome entre os dados
   * a cruzar mas avisa na mesma frase pra "não considerar apenas
   * correspondência exata de nome" — e é isso mesmo: "Maria Silva" cruza meia
   * cidade, e a suspeita do exemplo do próprio documento aparece como "Nayara
   * Santos" e "Maiara Santoa" justamente pra escapar de casamento por nome. O
   * nome aparece na TABELA de pedidos relacionados, pra pessoa ver — ele só
   * não pontua.
   */
  chavesDoPedido(order: any): Chave[] {
    const chaves: Chave[] = [];
    const por = (tipo: TipoChave, valor: string | null | undefined) => {
      const v = String(valor || '').trim().slice(0, 200);
      if (!v) return;
      if (v.length < (MIN_TAMANHO[tipo] ?? 3)) return;
      chaves.push({ tipo, valor: v });
    };

    por('cpf', normalizeCpf(order?.customerCpf));

    const email = normalizeEmail(order?.customerEmail);
    if (email && !EMAIL_SINTETICO.test(email)) por('email', email);

    const fone = normalizePhone(order?.customerPhone);
    if (fone && !TELEFONE_SINTETICO.has(fone)) por('telefone', fone);

    // ── Endereço ────────────────────────────────────────────────────────
    // RETIRADA EM LOJA NÃO GERA CHAVE DE ENDEREÇO. O endereço do pedido de
    // retirada é o da LOJA: dezenas de clientes sem relação nenhuma dividindo
    // a mesma linha. Seria a maior fábrica de alarme falso do módulo, e alarme
    // falso mata a confiança na fila inteira.
    if (!order?.isPickup) {
      const end = this.parse(order?.shippingAddress);
      const { cepNumero, endereco } = chavesDeEndereco({
        logradouro: end?.address_1,
        numero: end?.number,
        cep: end?.postcode || order?.shippingCep,
      });
      por('cep_numero', cepNumero);
      por('endereco', endereco);
    }

    // ── Pagamento ───────────────────────────────────────────────────────
    const pay = this.parse(order?.paymentInfo);
    const tx = pay?.transacao || {};
    // Os 4 últimos SOZINHOS não identificam cartão (10 mil combinações). Só
    // viram chave junto da bandeira, e mesmo assim pesam pouco.
    if (tx.ultimos4 && tx.bandeira) {
      por('cartao', `${semAcento(tx.bandeira)}-${digitsOnly(tx.ultimos4)}`);
    }
    if (tx.titular) {
      const titular = semAcento(tx.titular)
        .replace(/[^a-z ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      por('titular', titular);
    }

    // ── Sinais técnicos ─────────────────────────────────────────────────
    por('ip', String(order?.clienteIp || '').trim().toLowerCase());

    // O APARELHO é o sinal técnico forte: vive ~2 anos no localStorage dela,
    // enquanto o IP do 4G muda a cada torre. Já era gravado desde sempre e
    // ninguém tinha usado pra nada além de mandar evento pro Meta.
    const track = this.parse(order?.trackingInfo);
    por('aparelho', String(track?.anonymous_id || '').trim());

    return chaves;
  }

  /**
   * Grava (ou regrava) as chaves de um pedido. Idempotente: apagar antes de
   * gravar faz a correção de endereço do pedido chegar nas chaves, e o
   * `@@unique` (orderId, tipo, valor) segura o resto.
   */
  async gravarChaves(orderId: string): Promise<number> {
    const order = await (this.prisma as any).order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        customerCpf: true,
        customerEmail: true,
        customerPhone: true,
        shippingAddress: true,
        shippingCep: true,
        paymentInfo: true,
        trackingInfo: true,
        clienteIp: true,
        isPickup: true,
        createdAt: true,
        wcDateCreated: true,
      },
    });
    if (!order) return 0;

    const chaves = this.chavesDoPedido(order);
    const pedidoEm = order.wcDateCreated || order.createdAt || new Date();

    await (this.prisma as any).$transaction([
      (this.prisma as any).orderRiskKey.deleteMany({ where: { orderId } }),
      ...(chaves.length
        ? [
            (this.prisma as any).orderRiskKey.createMany({
              data: chaves.map((c) => ({ orderId, tipo: c.tipo, valor: c.valor, pedidoEm })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    return chaves.length;
  }

  /**
   * Nunca derruba o caminho de venda. Chave de risco que falha é análise
   * atrasada; exceção subindo daqui é pedido que a cliente não consegue
   * fechar. O backfill recupera o que faltar.
   */
  async gravarChavesSeguro(orderId: string): Promise<void> {
    try {
      await this.gravarChaves(orderId);
    } catch (e: any) {
      this.logger.warn(`[risco] chaves não gravaram pedido=${orderId}: ${e?.message || e}`);
    }
  }

  /**
   * BACKFILL — a base inteira ganha chave sem esperar venda nova.
   *
   * Sem ele o módulo nasce cego: o cruzamento só acharia relação entre pedidos
   * feitos DEPOIS do deploy, e o pedido com chargeback que a gente quer
   * reconhecer é justamente um pedido velho.
   *
   * Processa em lotes, do mais novo pro mais antigo (o pedido de ontem
   * interessa mais que o de 2024), e é retomável: só olha pedido que ainda não
   * tem chave nenhuma.
   */
  async backfill(opts: { lote?: number; ciclos?: number } = {}): Promise<{
    processados: number;
    chaves: number;
    restantes: number;
  }> {
    const lote = Math.min(Math.max(Number(opts.lote) || 500, 1), 2000);
    const ciclos = Math.min(Math.max(Number(opts.ciclos) || 1, 1), 200);
    let processados = 0;
    let chaves = 0;

    for (let i = 0; i < ciclos; i += 1) {
      const pendentes: Array<{ id: string }> = await (this.prisma as any).$queryRawUnsafe(
        `SELECT o.id FROM orders o
          WHERE NOT EXISTS (SELECT 1 FROM order_risk_keys k WHERE k.order_id = o.id)
          ORDER BY o.created_at DESC
          LIMIT ${lote}`,
      );
      if (!pendentes.length) break;

      for (const p of pendentes) {
        try {
          chaves += await this.gravarChaves(p.id);
          processados += 1;
        } catch (e: any) {
          this.logger.warn(`[risco] backfill falhou pedido=${p.id}: ${e?.message || e}`);
        }
      }
      this.logger.log(`[risco] backfill: ${processados} pedidos, ${chaves} chaves`);
    }

    const restantes = await this.pedidosSemChave();
    return { processados, chaves, restantes };
  }

  /** Quantos pedidos ainda não têm chave — o progresso do backfill. */
  async pedidosSemChave(): Promise<number> {
    const linhas: Array<{ restantes: bigint }> = await (this.prisma as any).$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS restantes FROM orders o
        WHERE NOT EXISTS (SELECT 1 FROM order_risk_keys k WHERE k.order_id = o.id)`,
    );
    return Number(linhas?.[0]?.restantes || 0);
  }

  private parse(texto: any): any {
    if (!texto) return null;
    if (typeof texto === 'object') return texto;
    try {
      return JSON.parse(String(texto));
    } catch {
      return null;
    }
  }
}
