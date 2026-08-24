import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PEÇA PROMETIDA × PEÇA QUE EXISTE  (24/08 — ordem do dono)
 *
 *  A Grade por Loja mostra `estoque − prometido`. Quando a loja promete mais
 *  do que tem, o número fica NEGATIVO: Itanhaém aparecia com `-2` em VOGUE-PD
 *  PRETO DOURADO 46 porque tinha 0 na arara e DUAS ordens pendentes pra
 *  Anália Franco, criadas com 3 SEGUNDOS de diferença em 29/06 — bipe/clique
 *  duplo que ninguém enviou nem cancelou.
 *
 *  Duas coisas moram aqui, e as duas atacam a mesma raiz:
 *
 *   1) A TRAVA — promessa nova só nasce se houver peça pra ela.
 *      `garantirDisponivel` recusa a ordem quando
 *      `prometidas_abertas + qty > estoque`. Não é "uma ordem por peça":
 *      transferir 2 unidades de verdade continua passando, porque a conta
 *      olha o SALDO, não a repetição.
 *
 *   2) A EXPIRAÇÃO — promessa que ninguém honra não vale pra sempre.
 *      `expirarPendenciasVelhas` cancela pendência SEM CAIXA parada há mais
 *      de N dias (7, decisão do dono). Sem isso o negativo volta sozinho:
 *      medição de 24/08 achou 198 pendências órfãs na rede, 139 com mais de
 *      7 dias, a mais velha de 27/04.
 *
 *  ⚠️ O que NÃO é tocado: pendência DENTRO de caixa aberta. A peça já está
 *  bipada na caixa — quem resolve isso é o "Fechar e enviar" (ou o excluir
 *  da própria caixa), não uma varredura por idade.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class PromessaEstoqueService {
  private readonly logger = new Logger(PromessaEstoqueService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Mesma normalização do espelho Wincred (codigo sem zeros à esquerda). */
  private normalizeCodigo(raw: string): string {
    const s = String(raw ?? '').trim();
    if (!s || !/^\d+$/.test(s)) return s;
    return s.replace(/^0+/, '') || '0';
  }

  /**
   * Quanto já está PROMETIDO saindo desta loja, por código.
   *
   * Aberto = `pending` (qualquer) + `sent` com a caixa ainda ABERTA — a mesma
   * régua do `pendenciasPorSku`, que é quem desenha o número da grade. Caixa
   * fechada/in_transit não conta: ali o estoque da origem já baixou.
   */
  async prometidasPorCodigo(
    codigos: string[],
    origemCode: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const lista = Array.from(new Set(codigos.map((c) => String(c ?? '').trim()).filter(Boolean)));
    if (!lista.length || !origemCode) return out;

    const rows: any[] = await this.prisma.transferOrder.findMany({
      where: {
        codigoBipado: { in: lista },
        lojaOrigemCode: origemCode,
        realignmentStatus: { in: ['pending', 'sent'] },
      } as any,
      select: {
        codigoBipado: true,
        qtyOrigem: true,
        realignmentStatus: true,
        shipmentId: true,
      } as any,
    });
    if (!rows.length) return out;

    // Só as 'sent' precisam saber o estado da caixa.
    const shipIds = Array.from(
      new Set(rows.filter((r) => r.realignmentStatus === 'sent' && r.shipmentId).map((r) => r.shipmentId)),
    );
    const ships: any[] = shipIds.length
      ? await (this.prisma as any).realignmentShipment.findMany({
          where: { id: { in: shipIds } },
          select: { id: true, status: true },
        })
      : [];
    const statusCaixa = new Map<string, string>(ships.map((s) => [s.id, s.status]));

    for (const r of rows) {
      if (r.realignmentStatus === 'sent') {
        const caixa = r.shipmentId ? (statusCaixa.get(r.shipmentId) ?? 'open') : 'open';
        if (caixa !== 'open') continue; // já baixou na origem
      }
      const k = String(r.codigoBipado);
      out.set(k, (out.get(k) ?? 0) + (Number(r.qtyOrigem) || 0));
    }
    return out;
  }

  /**
   * Estoque do espelho por código nesta loja.
   *
   * `null` = o espelho NÃO CONHECE esse código (peça recém-cadastrada, código
   * de bipe torto, REF no lugar do código). Nesses casos a trava sai de cena:
   * bloquear por um número que não existe seria pior do que deixar passar.
   * Linha ausente num código QUE O ESPELHO CONHECE é zero de verdade.
   */
  async estoqueNoEspelho(
    codigos: string[],
    lojaCode: string,
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const lista = Array.from(new Set(codigos.map((c) => String(c ?? '').trim()).filter(Boolean)));
    if (!lista.length || !lojaCode) return out;

    // Busca pelos dois formatos: o código do bipe às vezes chega com zero à
    // esquerda ("05387465") e o espelho guarda sem ("5387465").
    const variantes = new Map<string, string>(); // variante -> codigo original
    for (const c of lista) {
      variantes.set(c, c);
      variantes.set(this.normalizeCodigo(c), c);
    }

    const rows: any[] = await (this.prisma as any).wincredEstoque.findMany({
      where: { codigo: { in: Array.from(variantes.keys()) } },
      select: { codigo: true, loja: true, estoque: true },
    });

    const conhecidos = new Set<string>();
    const daLoja = new Map<string, number>();
    for (const r of rows) {
      const orig = variantes.get(String(r.codigo)) ?? String(r.codigo);
      conhecidos.add(orig);
      if (String(r.loja).trim() === String(lojaCode).trim()) {
        daLoja.set(orig, Number(r.estoque) || 0);
      }
    }

    for (const c of lista) {
      out.set(c, conhecidos.has(c) ? (daLoja.get(c) ?? 0) : null);
    }
    return out;
  }

  /**
   * A TRAVA. Recusa o lote inteiro quando alguma peça não tem saldo pra
   * sustentar a promessa nova — e diz QUAL peça e POR QUÊ, senão quem está no
   * balcão não sabe o que fazer com o erro.
   *
   * Itens do MESMO código+origem somam entre si: pedir 2 de uma vez e pedir 1
   * duas vezes têm que dar no mesmo resultado.
   */
  async garantirDisponivel(
    itens: Array<{ codigo?: string | null; origemCode: string; qty: number; rotulo?: string }>,
  ): Promise<void> {
    const validos = (itens || []).filter((i) => i && i.codigo && i.origemCode && (i.qty || 0) > 0);
    if (!validos.length) return;

    // Agrupa por origem pra fazer 1 par de consultas por loja.
    const porOrigem = new Map<string, typeof validos>();
    for (const i of validos) {
      const k = String(i.origemCode);
      if (!porOrigem.has(k)) porOrigem.set(k, []);
      porOrigem.get(k)!.push(i);
    }

    const problemas: string[] = [];

    for (const [origem, lista] of porOrigem) {
      const codigos = lista.map((i) => String(i.codigo));
      const [prometidas, estoques] = await Promise.all([
        this.prometidasPorCodigo(codigos, origem),
        this.estoqueNoEspelho(codigos, origem),
      ]);

      // Quanto este lote está pedindo de cada código.
      const pedindo = new Map<string, number>();
      const rotulos = new Map<string, string>();
      for (const i of lista) {
        const c = String(i.codigo);
        pedindo.set(c, (pedindo.get(c) ?? 0) + (Number(i.qty) || 0));
        if (i.rotulo && !rotulos.has(c)) rotulos.set(c, i.rotulo);
      }

      for (const [codigo, qty] of pedindo) {
        const estoque = estoques.get(codigo);
        if (estoque == null) continue; // espelho não conhece — fail-open
        const jaPedidas = prometidas.get(codigo) ?? 0;
        if (jaPedidas + qty <= estoque) continue;

        const nome = rotulos.get(codigo) || codigo;
        problemas.push(
          jaPedidas > 0
            ? `${nome}: a loja tem ${estoque} e ${jaPedidas} já está pedida — não sobra pra pedir ${qty}.`
            : `${nome}: a loja tem ${estoque} — não dá pra pedir ${qty}.`,
        );
      }
    }

    if (problemas.length) {
      throw new BadRequestException(
        `Peça já prometida (ou sem saldo): ${problemas.join(' ')} ` +
          `Cancele o pedido anterior na tela de realinhamento antes de pedir de novo.`,
      );
    }
  }

  /**
   * A TRAVA DO BIPE — versão que respeita a peça na mão.
   *
   * No balcão a vendedora bipa uma peça FÍSICA, e o espelho pode não saber
   * dela (peça que veio do provador, de outra loja, sem registro). Por isso o
   * primeiro bipe NUNCA é barrado: se ainda não existe promessa aberta desse
   * código pra esse destino, passa direto.
   *
   * A partir do SEGUNDO é que a conta entra — e foi exatamente aí que os `-2`
   * nasceram: VOGUE-PD PRETO DOURADO 46 e 48 bipadas DUAS vezes pra Anália
   * Franco com 3 segundos de diferença, com 1 peça na loja. Duas peças de
   * verdade continuam passando; o eco do leitor, não.
   */
  async garantirNaoDuplicaBipe(input: {
    codigo?: string | null;
    origemCode: string;
    destinoCode: string;
    rotulo?: string;
  }): Promise<void> {
    const codigo = String(input.codigo ?? '').trim();
    if (!codigo || !input.origemCode || !input.destinoCode) return;

    const abertas = await this.abertasPorDestino(codigo, input.origemCode, input.destinoCode);
    if (abertas <= 0) return; // primeiro bipe: nunca barra

    const estoques = await this.estoqueNoEspelho([codigo], input.origemCode);
    const estoque = estoques.get(codigo);
    if (estoque == null) return; // espelho não conhece o código — fail-open
    if (abertas + 1 <= estoque) return; // tem peça pra sustentar mais uma

    const nome = input.rotulo || codigo;
    throw new BadRequestException(
      `${nome} já está pedida daqui pra essa loja (${abertas}) e a loja tem ${estoque}. ` +
        `Se for outra peça de verdade, ajuste o estoque antes; se foi bipe repetido, ` +
        `é só seguir — a primeira já está na caixa.`,
    );
  }

  /** Promessas abertas deste código, desta origem, PARA UM destino. */
  private async abertasPorDestino(
    codigo: string,
    origemCode: string,
    destinoCode: string,
  ): Promise<number> {
    const rows: any[] = await this.prisma.transferOrder.findMany({
      where: {
        codigoBipado: codigo,
        lojaOrigemCode: origemCode,
        lojaDestinoCode: destinoCode,
        realignmentStatus: { in: ['pending', 'sent'] },
      } as any,
      select: { qtyOrigem: true, realignmentStatus: true, shipmentId: true } as any,
    });
    if (!rows.length) return 0;

    const shipIds = Array.from(
      new Set(rows.filter((r) => r.realignmentStatus === 'sent' && r.shipmentId).map((r) => r.shipmentId)),
    );
    const ships: any[] = shipIds.length
      ? await (this.prisma as any).realignmentShipment.findMany({
          where: { id: { in: shipIds } },
          select: { id: true, status: true },
        })
      : [];
    const statusCaixa = new Map<string, string>(ships.map((s) => [s.id, s.status]));

    let total = 0;
    for (const r of rows) {
      if (r.realignmentStatus === 'sent') {
        const caixa = r.shipmentId ? (statusCaixa.get(r.shipmentId) ?? 'open') : 'open';
        if (caixa !== 'open') continue;
      }
      total += Number(r.qtyOrigem) || 0;
    }
    return total;
  }

  /**
   * A EXPIRAÇÃO. Cancela pendência SEM CAIXA parada há mais de `dias`.
   *
   * Cancela, não apaga — igual ao `cancelarOrdem` da loja: o rastro fica e a
   * ordem some das listas (que filtram por pending/not_found) e do desconto
   * da grade. O motivo vai no mesmo campo que a exclusão manual usa, pra
   * quem for investigar depois encontrar tudo no mesmo lugar.
   */
  async expirarPendenciasVelhas(dias: number): Promise<{
    dias: number;
    canceladas: number;
    porLoja: Array<{ loja: string; n: number }>;
  }> {
    const d = Math.max(1, Math.floor(Number(dias) || 0));
    const corte = new Date(Date.now() - d * 24 * 60 * 60 * 1000);

    const where = {
      realignmentStatus: 'pending',
      shipmentId: null,
      createdAt: { lt: corte },
    } as any;

    // Fotografa por loja ANTES de escrever — depois do update não dá mais pra
    // saber de quem era, e é esse número que vira log de operação.
    const alvo: any[] = await this.prisma.transferOrder.findMany({
      where,
      select: { lojaOrigemCode: true },
    });
    if (!alvo.length) return { dias: d, canceladas: 0, porLoja: [] };

    const contagem = new Map<string, number>();
    for (const r of alvo) {
      const k = String(r.lojaOrigemCode || '—');
      contagem.set(k, (contagem.get(k) ?? 0) + 1);
    }

    const upd = await this.prisma.transferOrder.updateMany({
      where,
      data: {
        realignmentStatus: 'cancelled',
        realignmentNotFoundNote: `Expirada automaticamente: ${d} dias sem envio`,
      } as any,
    });

    const porLoja = Array.from(contagem.entries())
      .map(([loja, n]) => ({ loja, n }))
      .sort((a, b) => b.n - a.n);

    this.logger.warn(
      `[expiracao-pendencia] ${upd.count} pendência(s) com mais de ${d} dias cancelada(s) · ` +
        porLoja.map((p) => `${p.loja}:${p.n}`).join(' '),
    );

    return { dias: d, canceladas: upd.count ?? 0, porLoja };
  }
}
