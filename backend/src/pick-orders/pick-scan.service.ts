import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * BIPE DA SEPARAÇÃO — o bipe É a baixa de estoque.
 *
 * O INCIDENTE (pedido 960000006, São José, 17/08): a atendente bipou 5 das 11
 * peças e separou; o estoque não baixou. O único gatilho de baixa era o
 * `finishSeparation`, e ele EXIGE 100% bipado — com 5 peças na mão ela não
 * conseguia finalizar, a baixa nunca rodava, e as 5 peças já separadas
 * continuavam vendáveis no balcão e no site. O bipe também não existia no
 * servidor: vivia em `localStorage` e só chegava inteiro no finish.
 *
 * A DECISÃO: cada peça bipada vira UMA linha em `pick_order_scans`, gravada na
 * MESMA transação Postgres que aplica o delta de estoque (Flow é a fonte desde
 * 14/07; o Giga recebe a réplica pelo outbox). Não existe janela entre
 * "registrei o bipe" e "baixei a peça" — ou as duas coisas acontecem, ou
 * nenhuma. É por isso que a tela só pode pintar a peça de verde depois do 200.
 *
 * AS TRÊS TRAVAS CONTRA BAIXA DUPLA (estoque é o caminho mais perigoso):
 *   1. `@@unique([pickOrderId, scanUid])` — reenvio do MESMO bipe (rede caiu,
 *      clique duplo) é recusado pelo banco, não por um `if` meu.
 *   2. Teto por SKU dentro da transação, com a linha do pick-order travada em
 *      `FOR UPDATE`: nunca sai do estoque mais do que o pedido pede. É essa
 *      trava que cobre o caso feio — resposta perdida na volta, tela gera uid
 *      novo e manda de novo.
 *   3. Par `stockDecreasedAt`/`stockIncreasedAt` no molde do
 *      RealignmentShipment: o estorno só acha linha baixada-e-não-devolvida,
 *      então estornar duas vezes não cria peça que não existe.
 *
 * QUEM MAIS PRECISA DISSO: todo caminho que cancela/reatribui um card tem que
 * devolver as peças que já saíram. Por isso o serviço mora fora do
 * PickOrdersService — routing (recalcular/trocar loja) e orders (pedido
 * cancelado no site) chamam o MESMO estorno, sem ciclo de módulo.
 */
@Injectable()
export class PickScanService {
  private readonly logger = new Logger(PickScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /** `0` desliga a baixa no bipe: a peça ainda é registrada e conta na tela
   *  (a loja não fica travada), mas o estoque só sai no finish-separation —
   *  o comportamento de antes de 18/08. */
  private get debitOnScanEnabled(): boolean {
    return String(process.env.PICK_SCAN_DEBIT ?? '1').trim() !== '0';
  }

  /** Motivo pra NÃO baixar agora, ou null quando a baixa vale. */
  private skipReason(): 'shadow' | 'killswitch' | null {
    if (!this.debitOnScanEnabled) return 'killswitch';
    // Mesma porta do runAutoDebit: com as escritas em shadow nada sai do
    // estoque em lugar nenhum, então o bipe não pode fingir que saiu.
    if (!this.erp.isWriteEnabled) return 'shadow';
    return null;
  }

  /**
   * Serializa todo mundo que mexe nos bipes DESTE card. Sem isso, dois PCs (ou
   * dois bipes rápidos) leem "4 de 5 bipados" ao mesmo tempo e gravam os dois
   * — o teto por SKU vira decoração. `read committed` do Postgres não segura
   * contagem, só linha travada segura.
   *
   * Público porque o `finishSeparation` (que fecha o card e dispara a baixa do
   * que faltou) precisa entrar na MESMA fila — dois "Finalizar" ao mesmo tempo
   * baixavam o resto do card duas vezes.
   */
  async lockPickOrder(tx: any, pickOrderId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM pick_orders WHERE id = ${pickOrderId} FOR UPDATE`;
  }

  /** Bipes VÁLIDOS (não estornados) do card, na ordem em que entraram. */
  async listActiveScans(pickOrderId: string) {
    return this.prisma.pickOrderScan.findMany({
      where: { pickOrderId, revertedAt: null },
      orderBy: { scannedAt: 'asc' },
      select: { id: true, scanUid: true, sku: true, ean: true, scannedAt: true, debitSkippedReason: true },
    });
  }

  /** Quantas peças de cada SKU já SAÍRAM do estoque por bipe neste card.
   *  Bipe em shadow/killswitch não entra: ele conta na tela, não no estoque. */
  async debitedBySku(pickOrderId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.pickOrderScan.findMany({
      where: { pickOrderId, revertedAt: null, stockDecreasedAt: { not: null }, stockIncreasedAt: null },
      select: { sku: true },
    });
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.sku, (m.get(r.sku) ?? 0) + 1);
    return m;
  }

  /**
   * O QUE AINDA FALTA BAIXAR do card = esperado − já baixado no bipe.
   *
   * É o que impede a baixa dupla no outro sentido: `finishSeparation`,
   * `approveDebit` e a auto-baixa do `shipped` continuam existindo (bipe em
   * shadow, card criado antes deste deploy, matriz aprovando na mão), mas
   * agora só cobrem o buraco — nunca rebaixam a peça que já saiu no leitor.
   */
  async pendingDebitItems(
    pickOrderId: string,
    orderId: string,
    storeId: string,
    storeCode: string,
  ): Promise<Array<{ sku: string; qty: number; storeCode: string }>> {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId, assignedStoreId: storeId },
      select: { sku: true, quantity: true },
    });
    const already = await this.debitedBySku(pickOrderId);
    const out: Array<{ sku: string; qty: number; storeCode: string }> = [];
    const esperado = new Map<string, number>();
    for (const it of items) esperado.set(it.sku, (esperado.get(it.sku) ?? 0) + it.quantity);
    for (const [sku, qty] of esperado.entries()) {
      const falta = qty - (already.get(sku) ?? 0);
      if (falta > 0) out.push({ sku, qty: falta, storeCode });
    }
    return out;
  }

  /**
   * PEÇA NOVA EM CARD JÁ BAIXADO — reabre a baixa quando dá, recusa quando
   * reabrir dobraria estoque.
   *
   * O caso (ON-000214 Suzano 28/08, ON-000201 29/08): a loja bipa tudo,
   * finaliza, o `runAutoDebit` carimba `debitApprovedAt`. DEPOIS a matriz
   * recalcula o pedido — troca peça, move/inclui peça no card — e o card volta
   * pra `separating`, mas o carimbo ficava. O `registerScan` recusava qualquer
   * bipe ("Estoque deste pedido já foi baixado"): card na fila, peça nova na
   * lista, bipe impossível — só destravava com script no banco.
   *
   * POR QUE LIMPAR O CARIMBO É SEGURO (no caminho normal): desde 18/08 a baixa
   * é peça a peça no bipe. Quando o fechamento só CARIMBOU (`"applied":[]` nos
   * logs `debit.real.*applied`), toda peça baixada tem `stockDecreasedAt` no
   * próprio scan — sem o carimbo, `pendingDebitItems` enxerga exatamente as
   * peças novas, e o próximo finish re-carimba sem baixar nada duas vezes.
   *
   * QUANDO NÃO PODE: se algum fechamento APLICOU baixa em nível de card
   * (`applied` não-vazio — bipe que rodou em shadow/killswitch, card anterior
   * a 18/08), essas peças não têm scan com `stockDecreasedAt`, e reabrir faria
   * o próximo finish (e o teto por SKU do bipe) baixá-las DE NOVO. Aí lança
   * `BadRequestException` com a mensagem do caller. Log antigo sem a chave
   * `applied` cai no mesmo lado — na dúvida, não reabre.
   *
   * Chamar DENTRO da transação, com `lockPickOrder` já tomado e o carimbo lido
   * DEPOIS da trava: quem carimba em new/separating é só o finish, que passa
   * pela mesma fila — o carimbo visto sob a trava é o definitivo.
   */
  async reabrirBaixaPraPecaNova(
    tx: any,
    pickOrderId: string,
    opts: {
      reason: string;
      userId?: string | null;
      storeCode?: string | null;
      previousApprovedAt?: Date | null;
      erroSeInseguro: string;
    },
  ): Promise<void> {
    const baixaDeCard = await tx.integrationLog.findFirst({
      where: {
        source: 'erp',
        event: { in: ['debit.real.applied', 'debit.real.auto.applied'] },
        payload: { contains: `"pickOrderId":"${pickOrderId}"` },
        NOT: { payload: { contains: '"applied":[]' } },
      },
      select: { id: true },
    });
    if (baixaDeCard) {
      this.logger.warn(
        `[reabre-baixa] card ${pickOrderId} NÃO reaberto (${opts.reason}): ` +
          `log #${baixaDeCard.id} tem baixa aplicada em nível de card — reabrir dobraria estoque.`,
      );
      throw new BadRequestException(opts.erroSeInseguro);
    }
    await tx.pickOrder.update({
      where: { id: pickOrderId },
      data: { debitApprovedAt: null, debitApprovedBy: null } as any,
    });
    await tx.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.reopened',
        payload: JSON.stringify({
          pickOrderId,
          reopenedBy: opts.userId || 'auto:peca-nova',
          storeCode: opts.storeCode ?? null,
          previousApprovedAt: opts.previousApprovedAt ?? null,
          reason: opts.reason,
        }),
        status: 200,
      },
    });
    this.logger.log(`[reabre-baixa] card ${pickOrderId} reaberto: ${opts.reason}`);
  }

  /**
   * REGISTRA UMA PEÇA BIPADA E BAIXA O ESTOQUE — na mesma transação.
   *
   * Devolve `duplicate: true` (sem baixar nada) quando o mesmo `scanUid`
   * chega de novo: é o reenvio do mesmo bipe, e o certo é confirmar pra tela
   * em vez de tirar outra peça do estoque.
   */
  async registerScan(
    pickOrderId: string,
    storeId: string,
    userId: string,
    input: { scanUid: string; sku: string; ean?: string | null },
  ): Promise<{
    ok: true;
    duplicate: boolean;
    scanUid: string;
    sku: string;
    ean: string | null;
    debitSkippedReason: string | null;
    scanned: Array<{ sku: string; count: number }>;
    totalScanned: number;
  }> {
    const scanUid = String(input?.scanUid ?? '').trim();
    const sku = String(input?.sku ?? '').trim();
    const ean = String(input?.ean ?? '').trim() || null;
    if (!scanUid) throw new BadRequestException('scanUid obrigatório (a tela gera um por peça)');
    if (!sku) throw new BadRequestException('sku obrigatório');

    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true, storeId: true, orderId: true, status: true,
        debitApprovedAt: true, issueReason: true,
        store: { select: { code: true } },
      } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');
    if (po.status !== 'new' && po.status !== 'separating') {
      throw new BadRequestException(`Status atual é "${po.status}" — bipagem só em "new"/"separating"`);
    }
    if ((po as any).issueReason) {
      throw new BadRequestException('Este pedido está com problema reportado — fale com a matriz antes de bipar.');
    }
    // `debitApprovedAt` preenchido NÃO recusa mais aqui: card fechado que
    // GANHOU peça nova (recalculo/troca/mover) volta pra fila carimbado, e é o
    // bipe da peça nova que reabre a baixa — dentro da transação, depois da
    // trava, onde dá pra decidir com segurança (`reabrirBaixaPraPecaNova`).
    const storeCode = String(((po as any).store?.code) ?? '').trim();
    if (!storeCode) {
      throw new BadRequestException('Loja sem código configurado — não dá pra baixar o estoque no bipe.');
    }

    const itens = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: storeId },
      select: { sku: true, quantity: true },
    });
    const esperadoDoSku = itens
      .filter((i) => i.sku === sku)
      .reduce((a, b) => a + b.quantity, 0);
    if (esperadoDoSku <= 0) {
      throw new BadRequestException(`SKU ${sku} não está na lista deste pedido`);
    }

    const skip = this.skipReason();

    try {
      const res = await this.prisma.$transaction(async (tx) => {
        await this.lockPickOrder(tx, pickOrderId);

        // RECONFERE O CARD DEPOIS DA TRAVA. As validações lá em cima leram o
        // card ANTES do lock, e no meio do caminho o cancelamento pode ter
        // commitado (o cancelar do site marca `cancelled` e SÓ DEPOIS estorna).
        // Uma peça bipada nessa fresta nasceria fora do estoque sem ninguém pra
        // devolvê-la: o estorno já passou e não volta.
        const atual: any = await tx.pickOrder.findUnique({
          where: { id: pickOrderId },
          select: { status: true, debitApprovedAt: true, issueReason: true } as any,
        });
        if (!atual) {
          throw new BadRequestException('Este pedido saiu da sua fila — não bipe mais nada nele.');
        }
        if (atual.status !== 'new' && atual.status !== 'separating') {
          throw new BadRequestException(`Este pedido mudou pra "${atual.status}" — não dá mais pra bipar.`);
        }
        if (atual.issueReason) {
          throw new BadRequestException('Este pedido está com problema reportado — fale com a matriz antes de bipar.');
        }
        if (atual.debitApprovedAt) {
          // Card fechado que ganhou peça nova: reabre a baixa e deixa o bipe
          // seguir. Se o bipe for de peça que já estourou o teto (não era peça
          // nova coisa nenhuma), a transação inteira volta atrás no teto por
          // SKU logo abaixo — o carimbo só cai quando um bipe VALE.
          await this.reabrirBaixaPraPecaNova(tx, pickOrderId, {
            reason: 'peça nova em card já baixado — bipe reabriu a baixa',
            userId,
            storeCode,
            previousApprovedAt: atual.debitApprovedAt,
            erroSeInseguro:
              'Estoque deste pedido foi baixado em cima do card fechado — bipar de novo dobraria a baixa. Chame a matriz.',
          });
        }

        const jaBipados = await tx.pickOrderScan.count({
          where: { pickOrderId, sku, revertedAt: null },
        });
        if (jaBipados >= esperadoDoSku) {
          // Teto por SKU. Também é aqui que morre o retry com uid NOVO depois
          // de uma resposta perdida: o primeiro bipe já ocupou a vaga.
          throw new BadRequestException(`Já bipou ${jaBipados} de ${esperadoDoSku} dessa peça`);
        }

        const scan = await tx.pickOrderScan.create({
          data: {
            pickOrderId,
            orderId: po.orderId,
            storeId,
            storeCode,
            sku,
            ean,
            scanUid,
            scannedBy: userId || null,
            stockDecreasedAt: skip ? null : new Date(),
            debitSkippedReason: skip,
          },
        });

        if (!skip) {
          // allowNegative: a peça JÁ ESTÁ NA MÃO da atendente. Travar por
          // divergência de saldo não faz a peça voltar pra arara — só esconde
          // o negativo, que é a informação que a loja precisa ver (31/07).
          await this.erp.applyStockDeltaInTx(
            tx,
            [{ sku, qty: 1, storeCode }],
            -1,
            { allowNegative: true, skipNotFound: true },
          );
        }
        return scan;
      });

      await this.log('pick-order.scan.debited', {
        pickOrderId, orderId: po.orderId, storeId, storeCode, sku, ean,
        scanUid, userId, debitSkippedReason: skip,
      });

      return {
        ok: true as const,
        duplicate: false,
        scanUid: res.scanUid,
        sku: res.sku,
        ean: res.ean,
        debitSkippedReason: res.debitSkippedReason,
        ...(await this.counts(pickOrderId)),
      };
    } catch (e: any) {
      // P2002 = o MESMO scanUid já está gravado. Reenvio do mesmo bipe: a
      // transação inteira caiu (nada foi baixado agora) e a peça de verdade
      // continua contabilizada uma vez só.
      if (e?.code === 'P2002') {
        const anterior = await this.prisma.pickOrderScan.findFirst({
          where: { pickOrderId, scanUid },
          select: { scanUid: true, sku: true, ean: true, debitSkippedReason: true, revertedAt: true },
        });
        if (anterior && !anterior.revertedAt) {
          return {
            ok: true as const,
            duplicate: true,
            scanUid: anterior.scanUid,
            sku: anterior.sku,
            ean: anterior.ean,
            debitSkippedReason: anterior.debitSkippedReason,
            ...(await this.counts(pickOrderId)),
          };
        }
        throw new BadRequestException('Esse bipe já foi desfeito — bipe a peça de novo.');
      }
      throw e;
    }
  }

  /**
   * DESFAZ UM BIPE e devolve a peça pro estoque da loja — mesma transação.
   * O `updateMany` com `revertedAt: null` no WHERE é o que garante que dois
   * cliques em "Desfazer" devolvem UMA peça, não duas.
   */
  async undoScan(
    pickOrderId: string,
    storeId: string,
    userId: string,
    scanUid: string,
  ): Promise<{ ok: true; reverted: boolean; scanUid: string; scanned: Array<{ sku: string; count: number }>; totalScanned: number }> {
    const uid = String(scanUid ?? '').trim();
    if (!uid) throw new BadRequestException('scanUid obrigatório');

    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, storeId: true, status: true, debitApprovedAt: true } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');
    if ((po as any).debitApprovedAt) {
      throw new BadRequestException(
        'Estoque deste pedido já foi baixado por inteiro — desfazer aqui criaria peça que não existe. Use Devolução/Troca.',
      );
    }

    const reverted = await this.prisma.$transaction(async (tx) => {
      await this.lockPickOrder(tx, pickOrderId);
      const scan = await tx.pickOrderScan.findFirst({
        where: { pickOrderId, scanUid: uid, revertedAt: null },
      });
      if (!scan) return null;

      // O `revertedAt: null` no WHERE é a trava: quem devolve a peça é quem
      // CONSEGUIU virar a linha. Se outra chamada virou primeiro, `count` vem
      // 0 e nada entra no estoque — dois "desfazer" devolvem UMA peça.
      const virou = await tx.pickOrderScan.updateMany({
        where: { id: scan.id, revertedAt: null },
        data: { revertedAt: new Date(), revertReason: 'undo', revertedBy: userId || null },
      });
      if (!virou.count) return null;

      if (scan.stockDecreasedAt && !scan.stockIncreasedAt) {
        await tx.pickOrderScan.update({
          where: { id: scan.id },
          data: { stockIncreasedAt: new Date() },
        });
        await this.erp.applyStockDeltaInTx(
          tx,
          [{ sku: scan.sku, qty: 1, storeCode: scan.storeCode }],
          +1,
        );
      }
      return scan;
    });

    if (reverted) {
      await this.log('pick-order.scan.reverted', {
        pickOrderId, scanUid: uid, sku: reverted.sku, storeCode: reverted.storeCode,
        reason: 'undo', userId,
      });
    }

    return { ok: true as const, reverted: !!reverted, scanUid: uid, ...(await this.counts(pickOrderId)) };
  }

  /**
   * ESTORNO DO CARD INTEIRO — chamado por TODO caminho que cancela, remove ou
   * reatribui a separação. Sem isso a baixa no bipe vira peça sumida: a loja
   * separou 5, o pedido caiu, e ninguém devolveu nada pro estoque.
   *
   * O que devolver depende de QUANTO saiu, e a gente só devolve o que tem
   * prova de ter saído:
   *   - `debitApprovedAt` preenchido → o card inteiro já foi baixado (bipes +
   *     o que o finish/matriz completou). Devolve o ESPERADO por SKU e marca
   *     os bipes como estornados sem delta próprio (já estão dentro do total).
   *   - senão → devolve peça por peça, pelos bipes com `stockDecreasedAt`.
   *
   * `jaEstornadoPeloCaller` = o chamador já devolveu o total por conta dele
   * (o swap de loja faz isso pro card `shipped`): aqui só carimba os bipes,
   * senão a peça voltaria duas vezes.
   */
  async revertPickOrderStock(
    pickOrderId: string,
    opts: { reason: string; userId?: string | null; jaEstornadoPeloCaller?: boolean },
  ): Promise<{ pecas: number; escopo: 'card-inteiro' | 'bipes' | 'nada' }> {
    const motivo = String(opts.reason || 'cancel').slice(0, 60);

    const res = await this.prisma.$transaction(
      async (tx) => {
        // TRAVA E LÊ AQUI DENTRO. Ler os bipes fora da transação deixava
        // escapar o que entrasse entre a leitura e o estorno — e "a loja
        // bipando enquanto a matriz cancela" é o caso normal, não o raro.
        // A peça desse bipe sairia do estoque e ninguém a devolveria.
        await this.lockPickOrder(tx, pickOrderId);

        const po: any = await tx.pickOrder.findUnique({
          where: { id: pickOrderId },
          select: {
            id: true, storeId: true, orderId: true, status: true, debitApprovedAt: true,
            store: { select: { code: true } },
          } as any,
        });

        // CARD QUE JÁ SAIU DA LOJA — a peça está no caminhão ou com a cliente.
        // Devolver aqui não recoloca nada na arara: inventa peça no sistema, que
        // é o mesmo mal do outro lado (a Consulta e o site passam a vender o que
        // não existe). O caminho de volta é Devolução/Troca, que dá entrada
        // quando a peça CHEGA.
        // O filtro existe no `descobrirCardsComBipeAtivo`, mas quem manda a
        // lista pronta corta por outro critério: o cancelamento do site pega
        // `notIn ['shipped','cancelled']` e deixa 'delivered' passar. A trava
        // mora aqui, no único ponto que mexe no estoque, e não em cada caller.
        // `jaEstornadoPeloCaller` (swapStore de card enviado, que já devolveu o
        // pedido inteiro por conta dele) segue entrando: lá só falta carimbar.
        if (po && !opts.jaEstornadoPeloCaller && ['shipped', 'delivered'].includes(String(po.status))) {
          this.logger.warn(
            `[estorno-bipe] card ${pickOrderId} está "${po.status}" (${motivo}) — NÃO devolve estoque: ` +
            `a peça já saiu da loja. Se ela voltar, a entrada é pela Devolução/Troca.`,
          );
          return {
            pecas: 0, escopo: 'nada' as const, bipes: 0,
            itens: [] as Array<{ sku: string; qty: number; storeCode: string }>,
            storeCode: '', furo: null as string | null,
          };
        }

        const ativos = await tx.pickOrderScan.findMany({
          where: { pickOrderId, revertedAt: null },
          select: { id: true, sku: true, storeCode: true, stockDecreasedAt: true, stockIncreasedAt: true },
        });

        // `stockIncreasedAt` só entra nas linhas que REALMENTE tinham baixado —
        // carimbar a entrada num bipe que rodou em shadow inventaria uma
        // devolução que nunca existiu.
        const baixados = ativos.filter((s: any) => s.stockDecreasedAt && !s.stockIncreasedAt);
        const baixadosIds = baixados.map((s: any) => s.id);
        const semBaixaIds = ativos
          .filter((s: any) => !s.stockDecreasedAt || s.stockIncreasedAt)
          .map((s: any) => s.id);
        const carimbar = async (ids: string[], comEntrada: boolean) => {
          if (!ids.length) return;
          await tx.pickOrderScan.updateMany({
            where: { id: { in: ids }, revertedAt: null },
            data: {
              revertedAt: new Date(),
              revertReason: motivo,
              revertedBy: opts.userId || null,
              ...(comEntrada ? { stockIncreasedAt: new Date() } : {}),
            },
          });
        };
        /** Carimba TODOS os bipes ativos, cada um com o marcador certo. */
        const carimbarTodos = async () => {
          await carimbar(baixadosIds, true);
          await carimbar(semBaixaIds, false);
        };

        // Card inteiro já baixado: devolve o ESPERADO, não os bipes.
        if (po?.debitApprovedAt && !opts.jaEstornadoPeloCaller) {
          const storeCode = String(po.store?.code ?? '').trim();
          const itens = await tx.orderItem.findMany({
            where: { orderId: po.orderId, assignedStoreId: po.storeId },
            select: { sku: true, quantity: true },
          });
          const porSku = new Map<string, number>();
          for (const it of itens) porSku.set(it.sku, (porSku.get(it.sku) ?? 0) + it.quantity);
          const devolver = Array.from(porSku.entries()).map(([sku, qty]) => ({ sku, qty, storeCode }));

          if (storeCode && devolver.length && this.erp.isWriteEnabled) {
            await carimbarTodos();
            // A escrita no Wincred não é desfeita aqui: o Giga é réplica e recebe
            // o `inc` pelo mesmo outbox da baixa.
            await this.erp.applyStockDeltaInTx(tx, devolver, +1);
            // TIRA O CARIMBO DA BAIXA — sem isso o estorno não é idempotente.
            // Os bipes ficam marcados como devolvidos, mas `debitApprovedAt`
            // continuaria preenchido: uma SEGUNDA chamada (cancelar o pedido e
            // depois trocar a loja do card, p.ex.) cairia aqui de novo e
            // devolveria o card INTEIRO outra vez — peça que não existe.
            await tx.pickOrder.update({
              where: { id: pickOrderId },
              data: { debitApprovedAt: null } as any,
            });
            return {
              pecas: devolver.reduce((a, b) => a + b.qty, 0),
              escopo: 'card-inteiro' as const,
              bipes: ativos.length,
              itens: devolver,
              storeCode,
            };
          }

          // Não deu pra devolver o card inteiro (loja sem código, itens já
          // desatribuídos, escrita em shadow). NÃO carimba entrada que não
          // aconteceu — carimbar aqui apagava a única prova de que as peças
          // saíram. Cai pro estorno por bipe, que devolve o que TEM prova.
          this.logger.error(
            `[estorno-bipe] card ${pickOrderId} (${motivo}): a baixa do card inteiro NÃO pôde ser devolvida ` +
            `(storeCode="${storeCode}", ${devolver.length} SKU(s), ERP_WRITE_ENABLED=${this.erp.isWriteEnabled}). ` +
            `Devolvendo só o que foi bipado — o resto precisa de conferência na mão.`,
          );
        }

        if (!ativos.length) {
          return { pecas: 0, escopo: 'nada' as const, bipes: 0, itens: [] as Array<{ sku: string; qty: number; storeCode: string }>, storeCode: '', furo: null as string | null };
        }

        const paraDevolver = opts.jaEstornadoPeloCaller ? [] : baixados;

        const agrupado = new Map<string, { sku: string; qty: number; storeCode: string }>();
        for (const s of paraDevolver as any[]) {
          const k = `${s.storeCode}|${s.sku}`;
          const cur = agrupado.get(k);
          if (cur) cur.qty += 1;
          else agrupado.set(k, { sku: s.sku, qty: 1, storeCode: s.storeCode });
        }
        const devolver = Array.from(agrupado.values());

        await carimbarTodos();
        // Sem trava por `ERP_WRITE_ENABLED`: quem prova que a peça saiu é o
        // `stockDecreasedAt` da própria linha, não o env de hoje — e a entrada
        // no Flow (fonte do estoque desde 14/07) nunca dependeu dele
        // (`increaseStockAsync` também não olha). Bipe que rodou em shadow não
        // tem `stockDecreasedAt` e por isso não entra aqui.
        if (devolver.length) await this.erp.applyStockDeltaInTx(tx, devolver, +1);

        const pecas = devolver.reduce((a, b) => a + b.qty, 0);
        return {
          pecas,
          escopo: (pecas ? 'bipes' : 'nada') as 'bipes' | 'nada',
          bipes: ativos.length,
          itens: devolver,
          storeCode: '',
        };
      },
      // Estorno mexe no card inteiro (um pedido de 11 peças = dezenas de
      // queries). Os 5s de padrão do Prisma abortariam no meio, e meia
      // devolução é pior que nenhuma.
      { timeout: 20000 },
    );

    if (res.bipes || res.pecas) {
      await this.log('pick-order.stock.reverted', {
        pickOrderId, reason: opts.reason, userId: opts.userId ?? null,
        escopo: opts.jaEstornadoPeloCaller ? 'so-carimbo' : res.escopo,
        bipes: res.bipes, storeCode: res.storeCode || undefined, itens: res.itens,
      });
      this.logger.log(
        `[estorno-bipe] card ${pickOrderId} (${motivo}): ${res.bipes} bipe(s) baixado(s), ${res.pecas} peça(s) devolvida(s)`,
      );
    }
    return { pecas: res.pecas, escopo: res.escopo };
  }

  /** Estorna os bipes de UM SKU — usado na troca de peça, onde a peça que saiu
   *  do estoque é a de ANTES da troca (o OrderItem é reescrito in-place). */
  async revertScansForSku(
    pickOrderId: string,
    sku: string,
    reason: string,
    userId?: string | null,
  ): Promise<{ pecas: number }> {
    // Mesma regra do estorno do card: trava e lê DENTRO da transação. A troca
    // de peça acontece com a atendente de leitor na mão — um bipe do SKU velho
    // que entrasse entre a leitura e o carimbo sairia do estoque e ficaria sem
    // dono, porque logo abaixo o `sku` do OrderItem é reescrito e ninguém mais
    // sabe que aquela peça era desse pedido.
    const out = await this.prisma.$transaction(async (tx) => {
      await this.lockPickOrder(tx, pickOrderId);

      const alvo = await tx.pickOrderScan.findMany({
        where: { pickOrderId, sku, revertedAt: null },
        select: { id: true, sku: true, storeCode: true, stockDecreasedAt: true, stockIncreasedAt: true },
      });
      if (!alvo.length) return { pecas: 0, storeCode: '' };

      const devolverN = alvo.filter((s: any) => s.stockDecreasedAt && !s.stockIncreasedAt);
      const storeCode = devolverN[0]?.storeCode ?? alvo[0].storeCode;

      const idsBaixados = devolverN.map((s: any) => s.id);
      const idsSemBaixa = alvo
        .filter((s: any) => !s.stockDecreasedAt || s.stockIncreasedAt)
        .map((s: any) => s.id);

      const carimbo = {
        revertedAt: new Date(),
        revertReason: String(reason || 'swap').slice(0, 60),
        revertedBy: userId || null,
      };
      if (idsBaixados.length) {
        await tx.pickOrderScan.updateMany({
          where: { id: { in: idsBaixados }, revertedAt: null },
          data: { ...carimbo, stockIncreasedAt: new Date() },
        });
      }
      if (idsSemBaixa.length) {
        await tx.pickOrderScan.updateMany({
          where: { id: { in: idsSemBaixa }, revertedAt: null },
          data: carimbo,
        });
      }
      // Sem trava por `ERP_WRITE_ENABLED` — ver o comentário no estorno do
      // card: a prova é o `stockDecreasedAt` da linha, e carimbar entrada sem
      // devolver a peça era perder a peça em silêncio.
      if (devolverN.length) {
        await this.erp.applyStockDeltaInTx(tx, [{ sku, qty: devolverN.length, storeCode }], +1);
      }
      return { pecas: devolverN.length, storeCode };
    });

    if (out.pecas) {
      await this.log('pick-order.stock.reverted', {
        pickOrderId, reason, sku, storeCode: out.storeCode, userId: userId ?? null, escopo: 'sku', pecas: out.pecas,
      });
    }
    return { pecas: out.pecas };
  }

  /** Estorna TODOS os cards de um pedido (cancelamento do pedido inteiro). */
  async revertOrderStock(
    orderId: string,
    opts: { reason: string; userId?: string | null; pickOrderIds?: string[] },
  ): Promise<{ cards: number; pecas: number }> {
    // `pickOrderIds` é AUTORIDADE — inclusive quando chega VAZIO. O caller já
    // decidiu quais cards morreram, e lista vazia quer dizer "nenhum", não
    // "descubra sozinho".
    //
    // Tratar `[]` como "descubra" era um estorno duplo pronto: o WooCommerce
    // manda `refunded` E `cancelled` pro mesmo pedido, e na segunda passada
    // não sobra card cancelável. O fallback então varria os bipes ATIVOS do
    // pedido — e o card JÁ ENVIADO tem os dele ativos DE PROPÓSITO (a peça
    // saiu de verdade, no caminhão) — e devolvia o pedido inteiro pro estoque.
    const ids = opts.pickOrderIds ?? (await this.descobrirCardsComBipeAtivo(orderId));

    let pecas = 0;
    let cards = 0;
    for (const id of ids) {
      try {
        const r = await this.revertPickOrderStock(id, { reason: opts.reason, userId: opts.userId });
        if (r.pecas > 0) cards += 1;
        pecas += r.pecas;
      } catch (e: any) {
        // Estorno é best-effort POR CARD: um card problemático não pode
        // impedir a devolução das peças dos outros.
        this.logger.error(`[estorno-bipe] card ${id} (${opts.reason}) falhou: ${e?.message || e}`);
      }
    }
    return { cards, pecas };
  }

  /**
   * Cards do pedido que ainda têm bipe ativo — usado só quando o caller NÃO
   * disse quais estornar.
   *
   * Tira de fora quem já postou: no card `shipped`/`delivered` os bipes ficam
   * ativos porque a peça saiu do estoque PRA VALER. Devolver esses é inventar
   * peça. Card apagado (o routing apaga) continua na lista de propósito — a
   * linha do bipe é órfã justamente pra sobreviver ao delete e ainda poder ser
   * devolvida.
   */
  private async descobrirCardsComBipeAtivo(orderId: string): Promise<string[]> {
    const comBipe = (
      await this.prisma.pickOrderScan.findMany({
        where: { orderId, revertedAt: null },
        select: { pickOrderId: true },
        distinct: ['pickOrderId'],
      })
    ).map((r) => r.pickOrderId);
    if (!comBipe.length) return [];
    const enviados = new Set(
      (
        await this.prisma.pickOrder.findMany({
          where: { id: { in: comBipe }, status: { in: ['shipped', 'delivered'] } },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    return comBipe.filter((id) => !enviados.has(id));
  }

  private async counts(pickOrderId: string): Promise<{ scanned: Array<{ sku: string; count: number }>; totalScanned: number }> {
    const rows = await this.prisma.pickOrderScan.groupBy({
      by: ['sku'],
      where: { pickOrderId, revertedAt: null },
      _count: { _all: true },
    });
    const scanned = rows.map((r: any) => ({ sku: r.sku, count: r._count._all as number }));
    return { scanned, totalScanned: scanned.reduce((a, b) => a + b.count, 0) };
  }

  private async log(event: string, payload: Record<string, any>): Promise<void> {
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'pick-order',
          direction: 'internal',
          event,
          payload: JSON.stringify(payload),
          status: 200,
        },
      });
    } catch (e: any) {
      // Log de auditoria não pode derrubar a operação — a verdade já está na
      // linha do scan e no estoque.
      this.logger.warn(`[estorno-bipe] falha ao logar ${event}: ${e?.message || e}`);
    }
  }
}
