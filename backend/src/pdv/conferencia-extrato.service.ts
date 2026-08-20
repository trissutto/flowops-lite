import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { DOMParser } from '@xmldom/xmldom';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CONCILIADOR AUTOMÁTICO DE EXTRATO (20/08 — item 2 da Conferência de Vendas).
 *
 * Objetivo: carimbar sozinho o pedido de venda online "sem prova" quando o
 * dinheiro APARECE na conta PagBank — a matriz só olha o que sobrar.
 *
 * Fonte: API clássica de transações do PagSeguro/PagBank
 * (`ws.pagseguro.uol.com.br/v2/transactions`, email+token, resposta XML) —
 * a mesma credencial que o PagbankService já usa no teste de conexão.
 *
 * ⚠️ LIMITE HONESTO: isso só enxerga o que passa pela CONTA PAGBANK. Se o
 * "PIX recebido" cai em outra conta (chave de outro banco), este cron não
 * acha nada — e o log diz claramente quantas transações a API devolveu, pra
 * ninguém confundir "não achou" com "não olhou".
 *
 * Regra de casamento CONSERVADORA (dinheiro não admite chute):
 *   - transação PAGA (status 3/4) com valor IGUAL (±R$ 0,01) ao pedido;
 *   - data entre 12h antes e 48h depois da criação do pedido;
 *   - casamento 1:1 SEM ambiguidade — 2 pedidos com o mesmo valor na mesma
 *     janela = ninguém é carimbado (fica pra conferência humana).
 *
 * Kill-switch: `CONFERENCIA_EXTRATO=0`.
 */
@Injectable()
export class ConferenciaExtratoService {
  private readonly logger = new Logger(ConferenciaExtratoService.name);
  private ultimoErro: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
  ) {}

  private ligado(): boolean {
    return String(process.env.CONFERENCIA_EXTRATO ?? '').trim() !== '0';
  }

  @Cron('*/30 * * * *', { name: 'conferencia-extrato' })
  async conciliar(): Promise<void> {
    if (!this.ligado()) return;
    try {
      // Candidatos: pedidos dos últimos 7 dias, sem conferência e não cancelados.
      const desde = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const candidatos: any[] = await (this.prisma as any).order.findMany({
        where: {
          source: 'pdv_online',
          vendaConferidaEm: null,
          status: { not: 'cancelled' },
          wcDateCreated: { gte: desde },
        },
        select: {
          id: true, wcOrderNumber: true, totalAmount: true, wcDateCreated: true,
        },
      });
      if (!candidatos.length) return;

      const txs = await this.buscarTransacoesPagas(desde);
      if (txs === null) return; // erro já logado (uma vez por motivo)
      if (!txs.length) {
        this.logger.log(
          `[extrato] API respondeu mas 0 transações pagas na janela — se os PIX manuais ` +
            `caem em outra conta, este conciliador nunca vai achá-los`,
        );
        return;
      }

      // Casamento 1:1 sem ambiguidade.
      const usadaPorTx = new Map<string, any[]>(); // txCode -> pedidos que casam
      const matchPorPedido = new Map<string, any[]>(); // orderId -> txs que casam
      for (const o of candidatos) {
        const total = Number(o.totalAmount) || 0;
        if (total <= 0) continue;
        const criado = new Date(o.wcDateCreated).getTime();
        for (const tx of txs) {
          if (Math.abs(tx.valor - total) > 0.01) continue;
          const t = tx.data.getTime();
          if (t < criado - 12 * 3600 * 1000 || t > criado + 48 * 3600 * 1000) continue;
          (matchPorPedido.get(o.id) ?? matchPorPedido.set(o.id, []).get(o.id))!.push(tx);
          (usadaPorTx.get(tx.code) ?? usadaPorTx.set(tx.code, []).get(tx.code))!.push(o);
        }
      }

      let carimbados = 0;
      for (const o of candidatos) {
        const matches = matchPorPedido.get(o.id) || [];
        if (matches.length !== 1) continue; // 0 = nada; 2+ = ambíguo
        const tx = matches[0];
        if ((usadaPorTx.get(tx.code) || []).length !== 1) continue; // tx disputada
        await (this.prisma as any).order.update({
          where: { id: o.id },
          data: {
            vendaConferidaEm: new Date(),
            vendaConferidaPor: 'extrato PagBank (auto)',
          },
        });
        await (this.prisma as any).orderHistory
          .create({
            data: {
              orderId: o.id,
              note:
                `Pagamento CONFERIDO automaticamente no extrato PagBank: transação ${tx.code} ` +
                `de R$ ${tx.valor.toFixed(2)} em ${tx.data.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
            },
          })
          .catch(() => null);
        carimbados++;
        this.logger.log(`[extrato] ${o.wcOrderNumber} conferido pela transação ${tx.code} (R$ ${tx.valor.toFixed(2)})`);
      }
      if (carimbados) this.logger.log(`[extrato] ciclo: ${carimbados} pedido(s) conferido(s) automaticamente`);
      this.ultimoErro = null;
    } catch (e: any) {
      this.avisarUmaVez(`ciclo falhou: ${e?.message || e}`);
    }
  }

  /** Transações PAGAS (status 3/4) da janela. null = erro (já logado). */
  private async buscarTransacoesPagas(desde: Date): Promise<Array<{ code: string; valor: number; data: Date }> | null> {
    const cfg: any = await (this.prisma as any).pagbankConfig.findFirst().catch(() => null);
    const email = String(cfg?.email || '').trim();
    const token = String(cfg?.bearerToken || '').trim();
    if (!email || !token) {
      this.avisarUmaVez('sem email/token do PagBank na config — conciliador parado');
      return null;
    }
    const fmt = (d: Date) => d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    const out: Array<{ code: string; valor: number; data: Date }> = [];
    try {
      let page = 1;
      // Teto de 10 páginas (1000 transações) por ciclo — mais que isso não é
      // conciliação, é dump.
      for (; page <= 10; page++) {
        const url =
          `https://ws.pagseguro.uol.com.br/v2/transactions` +
          `?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}` +
          `&initialDate=${fmt(desde)}&finalDate=${fmt(new Date())}` +
          `&maxPageResults=100&page=${page}`;
        const r = await firstValueFrom(
          this.http.get(url, { timeout: 20000, responseType: 'text' as any }),
        );
        const doc = new DOMParser().parseFromString(String(r.data || ''), 'text/xml');
        const nodes = doc.getElementsByTagName('transaction');
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes.item(i)!;
          const pega = (tag: string) => {
            const el = n.getElementsByTagName(tag).item(0);
            return el?.textContent?.trim() || '';
          };
          const status = pega('status');
          if (status !== '3' && status !== '4') continue; // só Paga/Disponível
          const valor = Number(pega('grossAmount'));
          const data = new Date(pega('date'));
          const code = pega('code');
          if (!code || !Number.isFinite(valor) || isNaN(data.getTime())) continue;
          out.push({ code, valor, data });
        }
        const totalPages = Number(
          doc.getElementsByTagName('totalPages').item(0)?.textContent || '1',
        );
        if (page >= totalPages) break;
      }
      this.logger.log(`[extrato] PagBank devolveu ${out.length} transação(ões) paga(s) na janela de 7 dias`);
      return out;
    } catch (e: any) {
      const st = e?.response?.status;
      this.avisarUmaVez(
        `API de transações respondeu ${st ?? 'erro de rede'} (${e?.message || e}) — ` +
          `se for 401/403, o token da config não vale pra API clássica: precisamos saber ` +
          `qual conta recebe os PIX manuais`,
      );
      return null;
    }
  }

  /** Loga cada motivo de erro UMA vez (cron de 30min não pode virar spam). */
  private avisarUmaVez(motivo: string): void {
    if (this.ultimoErro === motivo) return;
    this.ultimoErro = motivo;
    this.logger.warn(`[extrato] ${motivo}`);
  }
}
