import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A SACOLA QUE TEM DONA — captura no § 1 do checkout (dono, 14/08).
 *
 * O buraco que este service fecha: até 14/08 a única linha que sobrava de uma
 * compra não concluída era o `add_to_cart` do `site_eventos`, ANÔNIMO (só
 * `session_id`). Dava pra contar 32 sacolas por dia e não dava pra ligar
 * NENHUMA delas a uma pessoa. O `Order` — esse sim com nome e telefone — só
 * nasce no submit do checkout inteiro, depois de identificação + entrega +
 * pagamento. Quem desistia no meio não existia em lugar nenhum.
 *
 * Agora, no instante em que a cliente confirma nome + celular, a sacola vira
 * linha recuperável. `etapa` acompanha o avanço dela (identificacao → entrega
 * → pagamento) porque é isso que muda a conversa: "faltou escolher o frete" é
 * outra mensagem de "o cartão recusou".
 *
 * TRÊS COISAS QUE ESTE SERVICE NUNCA FAZ:
 *  1. **Não cria pedido.** Sem número LP, sem estoque, sem cobrança — a faixa
 *     950M é escassa e já foi reciclada uma vez (incidente do LP-000012).
 *  2. **Não lança.** Chamado de dentro do checkout: métrica de recuperação
 *     não pode derrubar venda. Toda falha vira log e `false`.
 *  3. **Não guarda CPF nem cartão.** Pra chamar no WhatsApp bastam nome,
 *     telefone e o que ela separou.
 */

export interface SacolaItemEntrada {
  ref?: string | null;
  nome?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  quantidade?: number | null;
  preco?: number | null;
}

export interface SacolaEntrada {
  sessionId?: string | null;
  nome?: string | null;
  email?: string | null;
  telefone?: string | null;
  itens?: SacolaItemEntrada[] | null;
  valor?: number | null;
  etapa?: string | null;
  cep?: string | null;
  cidade?: string | null;
  uf?: string | null;
  utmCampaign?: string | null;
}

/** Só estas três — etapa fora da lista vira 'identificacao'. */
const ETAPAS = new Set(['identificacao', 'entrega', 'pagamento']);

@Injectable()
export class SacolaService {
  private readonly logger = new Logger(SacolaService.name);

  constructor(private readonly prisma: PrismaService) {}

  private texto(valor: unknown, max: number): string {
    if (valor === null || valor === undefined) return '';
    return String(valor).trim().slice(0, max);
  }

  private digitos(valor: unknown): string {
    return String(valor ?? '').replace(/\D/g, '');
  }

  /**
   * Grava (ou atualiza) a sacola da sessão.
   *
   * Upsert por `sessionId` porque a mesma pessoa passa por aqui várias vezes:
   * confirma a identificação, volta pra corrigir o e-mail, escolhe o frete.
   * São eventos da MESMA sacola — três linhas seriam três ligações pra mesma
   * cliente, que é a maneira mais rápida de a fila perder a confiança de quem
   * atende (a mesma lição de "alarme falso" da fila da loja).
   */
  async registrar(entrada: SacolaEntrada): Promise<boolean> {
    const sessionId = this.texto(entrada?.sessionId, 64);
    const nome = this.texto(entrada?.nome, 120);
    const telefone = this.digitos(entrada?.telefone).slice(0, 11);
    const email = this.texto(entrada?.email, 160);

    // Sem os três não existe recuperação possível — descarta em silêncio em
    // vez de encher a fila de linha que ninguém consegue usar.
    if (!sessionId || nome.length < 2 || telefone.length < 10) return false;

    const itens = (Array.isArray(entrada?.itens) ? entrada.itens : [])
      .slice(0, 50)
      .map((it) => ({
        ref: this.texto(it?.ref, 40) || null,
        nome: this.texto(it?.nome, 160) || null,
        cor: this.texto(it?.cor, 60) || null,
        tamanho: this.texto(it?.tamanho, 10) || null,
        quantidade: Math.max(1, Math.min(99, Number(it?.quantidade) || 1)),
        preco: Number(it?.preco) > 0 ? Number(it?.preco) : 0,
      }));

    const pecas = itens.reduce((s, it) => s + it.quantidade, 0);
    // O valor de exibição sai dos itens quando o site não mandou o total —
    // fila sem valor não prioriza nada.
    const valorInformado = Number(entrada?.valor);
    const valor =
      Number.isFinite(valorInformado) && valorInformado > 0
        ? valorInformado
        : itens.reduce((s, it) => s + it.preco * it.quantidade, 0);

    const etapa = ETAPAS.has(String(entrada?.etapa)) ? String(entrada.etapa) : 'identificacao';
    const cep = this.digitos(entrada?.cep).slice(0, 8) || null;

    const dados = {
      nome,
      email,
      telefone,
      itens: itens as any,
      valor,
      pecas,
      etapa,
      cep,
      cidade: this.texto(entrada?.cidade, 80) || null,
      uf: this.texto(entrada?.uf, 2).toUpperCase() || null,
      utmCampaign: this.texto(entrada?.utmCampaign, 120) || null,
    };

    try {
      await (this.prisma as any).sacolaCheckout.upsert({
        where: { sessionId },
        create: { sessionId, ...dados },
        // Sacola que JÁ virou pedido e volta a receber toque (F5 na página de
        // confirmação, segunda compra na mesma sessão) reabre como sacola
        // nova: o carimbo antigo sai junto, senão ela ficaria invisível.
        update: { ...dados, pedidoId: null, convertidoEm: null },
      });
      return true;
    } catch (e: any) {
      this.logger.warn(`[sacola] não gravou (${sessionId}): ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * Carimba a sacola como convertida — quem assume a fila agora é o pedido.
   *
   * Chamado logo depois que o `Order` nasce. Se a cobrança falhar em seguida e
   * o pedido for descartado, `reabrir` desfaz o carimbo: a cliente não pode
   * sumir da fila por causa de um pedido que deixou de existir.
   */
  async marcarConvertida(sessionId: string | null | undefined, pedidoId: string): Promise<void> {
    const sid = this.texto(sessionId, 64);
    if (!sid) return;
    try {
      await (this.prisma as any).sacolaCheckout.updateMany({
        where: { sessionId: sid },
        data: { pedidoId, convertidoEm: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`[sacola] não carimbou conversão (${sid}): ${e?.message ?? e}`);
    }
  }

  /** Desfaz o carimbo do pedido que foi descartado (cobrança não saiu). */
  async reabrir(pedidoId: string): Promise<void> {
    try {
      await (this.prisma as any).sacolaCheckout.updateMany({
        where: { pedidoId },
        data: { pedidoId: null, convertidoEm: null },
      });
    } catch (e: any) {
      this.logger.warn(`[sacola] não reabriu (pedido ${pedidoId}): ${e?.message ?? e}`);
    }
  }
}
