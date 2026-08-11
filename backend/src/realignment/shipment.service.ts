import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RealignmentPricingService } from './realignment-pricing.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { CorreiosService } from '../correios/correios.service';
import { NfeTransferService } from '../nfe/nfe-transfer.service';
import { RemessaEnvioService } from './remessa-envio.service';

/**
 * RealignmentShipmentService — gerencia o ciclo de REMESSA entre lojas.
 *
 * Diferente do markAsSent antigo (item-a-item), agora a vendedora MONTA uma
 * remessa adicionando peças, e quando termina FECHA → vira código único e
 * baixa estoque Giga em batch. Loja destino bipa cada peça e dá entrada.
 *
 * Convenção: TODOS endpoints só pra role=store (vendedora) ou admin.
 * O role check fica no controller.
 */
@Injectable()
export class RealignmentShipmentService {
  private readonly logger = new Logger(RealignmentShipmentService.name);

  // ⚡ Cache de SKUs por remessa — populado no 1º bipe, reutilizado nos próximos.
  // Reduz bipe de ~150ms pra ~30ms (zero queries Wincred após o 1º).
  private readonly skuCache = new Map<string, { skuMap: Map<string, string>; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000;
  private invalidateSkuCache(shipmentId: string) { this.skuCache.delete(shipmentId); }

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly pricing: RealignmentPricingService,
    private readonly gateway: RealtimeGateway,
    private readonly catalog: WincredCatalogService,
    private readonly correios: CorreiosService,
    private readonly nfe: NfeTransferService,
    private readonly envio: RemessaEnvioService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // GERAÇÃO DE CÓDIGO (REM-YYYY-NNNNNN sequencial global)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Gera o próximo código de remessa baseado no MAIOR código existente do ano
   * (não em `count()`). Razão: se uma remessa for deletada, count() retorna
   * um número que JÁ EXISTE → UNIQUE constraint violation no INSERT.
   *
   * Estratégia: pega último código com MAX(numero) e soma 1.
   * Se houver race com outra vendedora, o caller faz retry com nextSuffix.
   */
  private async generateShipmentCode(suffix = 0): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `REM-${year}-`;
    // Pega o último código existente do ano (ordenando desc por code).
    // Como o code tem padding de 6 zeros, ordenação alfabética = numérica.
    const last = await (this.prisma as any).realignmentShipment.findFirst({
      where: { code: { startsWith: prefix } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    let lastNum = 0;
    if (last?.code) {
      const m = String(last.code).match(/-(\d+)$/);
      if (m) lastNum = parseInt(m[1], 10) || 0;
    }
    const nextNum = lastNum + 1 + suffix;
    return `${prefix}${String(nextNum).padStart(6, '0')}`;
  }

  /**
   * Cria a remessa com retry — se 2 vendedoras criarem simultâneo, o INSERT
   * pode falhar com UNIQUE constraint. Tenta até 5x com sufixo crescente.
   */
  private async createShipmentWithRetry(data: {
    fromStoreCode: string;
    fromStoreName: string;
    toStoreCode: string;
    toStoreName: string;
    openedByUserId?: string | null;
    tipo?: string;
  }): Promise<any> {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await this.generateShipmentCode(attempt);
      try {
        return await (this.prisma as any).realignmentShipment.create({
          data: {
            code,
            fromStoreCode: data.fromStoreCode,
            fromStoreName: data.fromStoreName,
            toStoreCode: data.toStoreCode,
            toStoreName: data.toStoreName,
            tipo: data.tipo ?? 'REALINHAMENTO',
            status: 'open',
            openedByUserId: data.openedByUserId ?? null,
          },
        });
      } catch (e: any) {
        lastErr = e;
        // P2002 = unique constraint violation no Prisma. Tenta próximo número.
        const isUnique = e?.code === 'P2002' || /Unique constraint/i.test(e?.message || '');
        if (!isUnique) throw e;
        this.logger.warn(
          `[shipment] code ${code} colidiu (tentativa ${attempt + 1}/5), tentando próximo`,
        );
      }
    }
    throw lastErr || new Error('Falha ao gerar código de remessa após 5 tentativas');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOJA ORIGEM — montar e enviar remessa
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista as remessas ABERTAS da loja origem (ainda em montagem).
   * Cada par origem→destino só pode ter 1 remessa aberta por vez —
   * a vendedora vai acumulando peças nela até fechar e enviar.
   */
  async listOpenShipmentsForOrigin(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true, name: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where: { fromStoreCode: (store as any).code, status: 'open' },
      orderBy: { openedAt: 'asc' },
    });

    // Pra cada shipment, conta quantos itens já estão dentro
    const result = await Promise.all(
      shipments.map(async (s: any) => {
        const items = await this.prisma.transferOrder.findMany({
          // Peça CANCELADA (excluída do pedido) não pertence mais à caixa —
          // sem o filtro ela continuava na grade e no contador do cartão.
          where: { shipmentId: s.id, realignmentStatus: { not: 'cancelled' } } as any,
          select: {
            id: true,
            refCode: true,
            cor: true,
            tamanho: true,
            qtyOrigem: true,
            descricao: true,
            precoUnitCents: true,
            // ── O que a GRADE da tela precisa ──
            // A caixa carrega o proprio conteudo. Antes a tela montava a grade
            // a partir de "enviados HOJE", e por isso toda caixa que virava o
            // dia perdia a grade e caia numa tabela plana onde nao da pra
            // bipar. Com destino e horario aqui, a grade nasce da CAIXA e nao
            // depende de data nenhuma.
            lojaDestinoCode: true,
            lojaDestinoName: true,
            realignmentSentAt: true,
            // Pro controller preencher descrição vazia via espelho
            codigoBipado: true,
          } as any,
        });
        return { ...s, items };
      }),
    );

    return result;
  }

  /**
   * Remessas JÁ FECHADAS que ainda não têm etiqueta gerada.
   *
   * A tela da loja só mostrava as ABERTAS (amarelas) e, logo depois de
   * fechar, um painel com "Gerar envio Correios". Quem fechasse a remessa e
   * saísse da tela — ou fechasse no outro PC da loja, ou antes deste painel
   * existir — perdia o caminho pra etiqueta: a remessa some das amarelas ao
   * fechar e não reaparece em lugar nenhum. Foi o que aconteceu em Suzano:
   * peças enviadas no dia, nenhuma caixa amarela e nenhum jeito de imprimir.
   *
   * Aqui elas voltam pra tela enquanto faltar a etiqueta. Sai da lista sozinha
   * quando `envioGeneratedAt` é preenchido — lista de trabalho, não histórico.
   */
  async listPendingLabelForOrigin(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true, name: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    /**
     * FILTRO LARGO DE PROPÓSITO — a primeira versão desta lista voltou VAZIA em
     * produção e o dono continuou sem conseguir imprimir. Três motivos possíveis,
     * e eu tinha plantado os três:
     *
     * 1. `NOT: { transportMode: 'proprio' }` sumia com quem tem `transportMode`
     *    NULL — que é a MAIORIA (null = regra automática). Em SQL,
     *    `NULL <> 'proprio'` não é verdadeiro, é desconhecido, e linha
     *    desconhecida não entra no resultado. Armadilha clássica de nulo.
     * 2. `envioGeneratedAt: null` escondia justamente a caixa que teve o envio
     *    gerado e NÃO foi impressa — que é um dos casos que a pessoa precisa
     *    resolver.
     * 3. depender de `sentAt` preenchido pra ordenar/filtrar.
     *
     * Agora a pergunta é a simples: "o que esta loja fechou nos últimos dias?".
     * O estado de cada uma vai junto (`envioGeneratedAt`, `trackingCode`) e a
     * TELA decide o texto do botão — gerar ou reimprimir. Lista curta, então
     * mostrar demais custa barato; mostrar de menos custa uma caixa parada.
     */
    const seteDias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where: {
        fromStoreCode: (store as any).code,
        /**
         * SÓ `in_transit`. Eu tinha incluído `received` ao alargar o filtro, e
         * isso trouxe caixa VELHA de volta pra tela: quando o destino confirma
         * o recebimento, o `updatedAt` da remessa é tocado ali — então uma
         * caixa de semanas atrás, recebida hoje, entrava na janela de 7 dias
         * como se fosse trabalho pendente. Caixa recebida já chegou; não há o
         * que postar.
         */
        status: 'in_transit',
        updatedAt: { gte: seteDias },
        /**
         * Envio próprio não tem etiqueta dos Correios pra pedir.
         *
         * Escrito com o nulo EXPLÍCITO. A primeira versão usava
         * `NOT: { transportMode: 'proprio' }` e sumia com a lista inteira,
         * porque `NULL <> 'proprio'` em SQL não é verdadeiro, é desconhecido —
         * e null aqui é o caso mais comum (regra automática).
         */
        OR: [{ transportMode: null }, { transportMode: { not: 'proprio' } }],
      },
      orderBy: [{ sentAt: 'desc' }, { updatedAt: 'desc' }],
      take: 15,
    });

    /**
     * Caixa da ROTA PRÓPRIA não pede etiqueta.
     *
     * Itanhaém, Praia Grande e Santos trocam mercadoria no carro da rede. O
     * filtro do SQL acima só corta quem já tem `transportMode='proprio'`
     * gravado — e na rota própria ele nasce NULO (regra automática). Sem isto,
     * a loja veria "Gerar envio Correios" numa caixa que vai de carro e
     * abriria pré-postagem que ninguém vai postar.
     *
     * Reusa `lojasDaRotaPropria` do serviço de envio: a regra tem que ser a
     * MESMA que decide na hora de gerar, senão a tela oferece o que o backend
     * recusa.
     */
    const rota = await this.envio.lojasDaRotaPropria();
    const daRota = (s: any) =>
      rota.size > 0 &&
      rota.has(String(s.fromStoreCode || '').toUpperCase()) &&
      rota.has(String(s.toStoreCode || '').toUpperCase());

    /**
     * ⚠️ A caixa da ROTA PRÓPRIA CONTINUA NA LISTA (04/08 — incidente Santos).
     *
     * Antes ela era FILTRADA FORA daqui, e o efeito colateral era brutal:
     * assim que a loja fechava uma caixa Itanhaém→Santos (rota do carro da
     * rede), ela sumia da tela inteira — não está mais em "abertas", e a lista
     * de fechadas só trazia quem precisa de etiqueta. As peças separadas
     * ficavam invisíveis; o dono perguntou "onde estão as separadas?" e não
     * havia onde olhar.
     *
     * O que a rota própria não tem é ETIQUETA — não é motivo pra esconder a
     * caixa. Vai o sinalizador `rotaPropria` e a TELA decide o que oferecer
     * (conferir conteúdo e reabrir sim, Correios não).
     */
    const paraEtiqueta = (shipments as any[]).map((s) => ({ ...s, rotaPropria: daRota(s) }));

    // Nota autorizada por caixa — a tela precisa AVISAR antes de reabrir, e não
    // descobrir no erro. Uma query pra todas em vez de uma por cartão.
    const notas = paraEtiqueta.length
      ? await (this.prisma as any).nfeDoc.findMany({
          where: { shipmentId: { in: paraEtiqueta.map((s: any) => s.id) }, status: 'authorized' },
          select: { shipmentId: true, numero: true },
        })
      : [];
    const notaPorCaixa = new Map<string, any>(
      (notas as any[]).map((n) => [n.shipmentId, n.numero]),
    );

    return Promise.all(
      paraEtiqueta.map(async (s: any) => {
        const items = await this.prisma.transferOrder.findMany({
          where: { shipmentId: s.id } as any,
          select: { id: true, qtyOrigem: true } as any,
        });
        return {
          ...s,
          items,
          totalPecas: (items as any[]).reduce((n, i) => n + (i.qtyOrigem || 1), 0),
          jaTemEtiqueta: !!s.envioGeneratedAt,
          notaAutorizada: notaPorCaixa.get(s.id) ?? null,
          // true = vai no carro da rede; a tela troca os Correios pelo botão
          // "Postar pelos Correios" (forçar). Depois de forçada, o
          // transportMode vira 'correios' e o cartão volta ao normal —
          // sem isto o "Etiqueta + NF" continuava escondido numa caixa que
          // JÁ TEM rastreio.
          rotaPropria: !!s.rotaPropria && String(s.transportMode || '') !== 'correios',
        };
      }),
    );
  }

  /**
   * EXCLUI uma caixa ABERTA (04/08 — botão "Excluir remessa" da tela).
   *
   * Caixa aberta ainda não baixou estoque, não tem obrigação, etiqueta nem
   * nota — excluir é barato: as peças voltam pra fila "a enviar" e a caixa
   * vira 'cancelled' (código nunca é apagado; o rastro fica). As ORDENS não
   * são canceladas — pedido da matriz continua valendo; pra tirar peça do
   * pedido existe o 🗑 da célula.
   *
   * Caixa fechada NÃO passa por aqui: fechamento se desfaz pelo Reabrir, que
   * devolve estoque e cancela obrigações/etiqueta/nota na ordem certa.
   */
  async cancelOpenShipment(input: { shipmentId: string; storeId: string | null }) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (input.storeId) {
      const store = await this.prisma.store.findUnique({
        where: { id: input.storeId },
        select: { code: true } as any,
      });
      if (!store || (store as any).code !== shipment.fromStoreCode) {
        throw new ForbiddenException('Essa remessa não é da sua loja');
      }
    }
    if (shipment.status !== 'open') {
      throw new BadRequestException(
        'Só caixa ABERTA pode ser excluída. Caixa fechada se desfaz pelo "Reabrir caixa" na aba Enviados.',
      );
    }

    const upd = await this.prisma.transferOrder.updateMany({
      // Peça EXCLUÍDA (lixeirinha) NÃO volta pra fila — excluir a caixa
      // ressuscitava peça que a loja tinha tirado do pedido de propósito.
      where: { shipmentId: shipment.id, realignmentStatus: { not: 'cancelled' } } as any,
      data: {
        realignmentStatus: 'pending',
        realignmentSentAt: null,
        shipmentId: null,
      } as any,
    });

    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: { status: 'cancelled', totalItems: 0, totalQty: 0 },
    });

    this.logger.warn(
      `[shipment] ${shipment.code} EXCLUÍDA (aberta): ${upd.count} peça(s) voltaram pra fila de separação`,
    );
    return { ok: true, code: shipment.code, pecasDevolvidas: upd.count ?? 0 };
  }

  /**
   * REABRE uma caixa fechada — desfaz o fechamento, não "muda um status".
   *
   * Fechar faz três coisas além de trocar o status: baixa o estoque da origem,
   * cria as obrigações financeiras entre as lojas e avisa a loja destino. Um
   * reabrir que só mexesse no status deixaria a peça fora do estoque, uma
   * cobrança fantasma no acerto do mês e o destino esperando caixa que não vem.
   * Por isso aqui é desfeito na ordem inversa.
   *
   * O QUE BLOQUEIA (e por quê):
   *  · caixa já RECEBIDA — a peça já entrou no estoque do destino; desfazer
   *    daqui criaria estoque do nada nas duas pontas;
   *  · NF-e AUTORIZADA — documento fiscal emitido não se apaga por botão de
   *    tela, se cancela na SEFAZ com prazo e justificativa;
   *  · ETIQUETA já gerada — existe pré-postagem nos Correios com essa caixa.
   * Nos três a mensagem diz o que fazer, em vez de só recusar.
   */
  async reopenShipment(input: {
    shipmentId: string;
    storeId: string;
    userId?: string;
    /** Reabrir mesmo com etiqueta gerada, descartando a pré-postagem. */
    descartarEtiqueta?: boolean;
    /** Reabrir cancelando a NF-e autorizada na SEFAZ (evento 110111). */
    cancelarNota?: boolean;
    /** Justificativa do cancelamento (SEFAZ exige 15-255). Tem padrão. */
    justificativa?: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.fromStoreCode !== (store as any).code) {
      throw new ForbiddenException('Essa remessa não é da sua loja');
    }
    if (shipment.status === 'open') {
      return { ok: true, jaEstavaAberta: true, code: shipment.code };
    }
    if (shipment.status !== 'in_transit') {
      throw new BadRequestException(
        shipment.status === 'received'
          ? 'A loja destino já recebeu esta caixa — não dá pra reabrir daqui.'
          : `Remessa está como "${shipment.status}" e não pode ser reaberta.`,
      );
    }
    /**
     * Etiqueta já gerada: BLOQUEIA, mas com porta de saída.
     *
     * A primeira versão só recusava — e virou beco: a loja gerou a etiqueta de
     * todas as caixas e depois nenhuma podia ser reaberta pra juntar. Trava sem
     * saída é defeito, não proteção. Com `descartarEtiqueta` a pessoa assume
     * que aquela etiqueta vai pro lixo, e o sistema tenta cancelar a
     * pré-postagem nos Correios antes de soltar a caixa.
     *
     * A NF-e autorizada (abaixo) NÃO ganha porta dessas: nota fiscal se cancela
     * na SEFAZ, com prazo e justificativa, não por botão de tela.
     */
    let etiquetaDescartada: string | null = null;
    if (shipment.envioGeneratedAt && !input.descartarEtiqueta) {
      throw new BadRequestException(
        `Esta caixa já tem etiqueta dos Correios${shipment.trackingCode ? ` (${shipment.trackingCode})` : ''}. ` +
        'Reabrir descarta essa etiqueta — confirme se é isso mesmo.',
      );
    }

    /**
     * NF-e autorizada: cancela na SEFAZ (evento 110111) ANTES de tudo.
     *
     * Reusa `NfeTransferService.cancelDoc`, que já existe e já resolve o
     * emitente correto — transferência às vezes sai pela raiz do destino, e
     * autor errado é recusa 574. Escrever cancelamento fiscal de novo aqui
     * seria a segunda versão da mesma coisa.
     *
     * Se a SEFAZ recusar, ESTOURA e nada mais é tocado: a caixa continua
     * fechada, com a nota válida. É o contrário da etiqueta — pré-postagem não
     * usada caduca sozinha, nota fiscal não. Prazo em SP é 24h; passou disso, a
     * SEFAZ recusa e o caminho é com o contador (devolução), não por esta tela.
     */
    let notaCancelada: string | null = null;
    const nfAutorizada = await (this.prisma as any).nfeDoc.findFirst({
      where: { shipmentId: shipment.id, status: 'authorized' },
      select: { id: true, numero: true } as any,
    });
    if (nfAutorizada && !input.cancelarNota) {
      throw new BadRequestException(
        `Esta caixa tem a NF-e ${nfAutorizada.numero} autorizada. ` +
        'Reabrir exige cancelar a nota na SEFAZ — confirme se é isso mesmo.',
      );
    }
    if (nfAutorizada && input.cancelarNota) {
      const justificativa =
        String(input.justificativa || '').trim() ||
        `Remessa ${shipment.code} reaberta na loja de origem para reagrupamento das pecas`;
      // cancelDoc valida 15-255 e estoura com o cStat/xMotivo da SEFAZ.
      await this.nfe.cancelDoc(nfAutorizada.id, justificativa, input.userId ?? null);
      notaCancelada = String(nfAutorizada.numero);
      this.logger.log(`[reopen] ${shipment.code}: NF-e ${notaCancelada} cancelada na SEFAZ`);
    }

    // Cancela a pré-postagem ANTES de mexer no resto: se os Correios
    // recusarem, a caixa continua fechada e nada foi desfeito pela metade.
    // Falha de comunicação não trava (a pré-postagem não postada caduca), mas
    // vai pro log e pra resposta — a pessoa precisa saber que a etiqueta pode
    // ter ficado viva lá.
    if (shipment.envioGeneratedAt && input.descartarEtiqueta) {
      etiquetaDescartada = shipment.trackingCode || shipment.correiosPrepostagemId || 'sem código';
      if (shipment.correiosPrepostagemId) {
        const r = await this.correios.cancelarPrepostagem(shipment.correiosPrepostagemId);
        if (!r?.ok) {
          this.logger.warn(
            `[reopen] ${shipment.code}: Correios não cancelou a pré-postagem ` +
            `${shipment.correiosPrepostagemId}: ${r?.erro || 'motivo desconhecido'}`,
          );
        }
      }
    }

    // Peça EXCLUÍDA (lixeirinha) fica atada à caixa com status cancelled e o
    // fechamento nunca baixou o estoque dela. Sem este filtro, o reabrir
    // (a) DEVOLVIA estoque que não saiu — peça fantasma no estoque — e
    // (b) RESSUSCITAVA a peça pra fila "a enviar" que a loja tinha excluído.
    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id, realignmentStatus: { not: 'cancelled' } } as any,
      select: { id: true, refCode: true, cor: true, tamanho: true, qtyOrigem: true, codigoBipado: true } as any,
    });

    // 1. DEVOLVE o estoque à origem — só se o fechamento realmente baixou.
    //    `stockDecreasedAt` é o mesmo marcador que o reprocess usa; sem ele o
    //    fechamento não tirou nada e devolver criaria peça do nada.
    let devolvidos = 0;
    if (shipment.stockDecreasedAt) {
      const stockItems: Array<{ sku: string; qty: number; storeCode: string }> = [];
      for (const it of items as any[]) {
        try {
          const sku =
            it.codigoBipado ||
            (await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho));
          if (sku) {
            stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.fromStoreCode });
          }
        } catch {
          // Item sem SKU não baixou no fechamento (política de unresolved) —
          // então também não tem o que devolver.
        }
      }
      if (stockItems.length) {
        const r = await this.erp.increaseStock(stockItems);
        if (!r?.success) {
          throw new BadRequestException(
            `Não devolvi o estoque pra ${shipment.fromStoreCode}: ${r?.error || 'erro desconhecido'}. ` +
            'A caixa continua fechada — nada foi alterado pela metade.',
          );
        }
        devolvidos = r.applied?.length || 0;
      }
    }

    // 2. CANCELA as obrigações do acerto. Cancela, não apaga: o mês fecha com
    //    o rastro de que existiu e foi desfeita.
    const idsItens = (items as any[]).map((i) => i.id);
    let obrigacoes = 0;
    if (idsItens.length) {
      const upd = await (this.prisma as any).interStoreObligation.updateMany({
        where: { transferOrderId: { in: idsItens }, status: 'pending' },
        data: { status: 'cancelled' },
      });
      obrigacoes = upd.count ?? 0;
    }

    const carimbo =
      `Reaberta em ${new Date().toISOString()} por ${input.userId ?? 'loja'}` +
      (etiquetaDescartada ? ` — etiqueta ${etiquetaDescartada} descartada` : '');

    /**
     * 3. AS PEÇAS VOLTAM PRA "A ENVIAR" e a caixa se desfaz (decisão do dono,
     *    03/08: "o certo era voltar para esta fase aqui").
     *
     * Reabrir não é "destravar a caixa": é desfazer a separação. A peça foi
     * pra outra caixa, pro chão, pra arara — ninguém sabe. Voltando pro estado
     * pendente, a vendedora PEGA E BIPA de novo, e o bipe é o que prova que a
     * peça está na mão. Caixa reaberta que continuasse cheia estaria afirmando
     * uma conferência que não aconteceu.
     *
     * E resolve de graça o problema das 4 remessas pra Anália: reabriu tudo,
     * as peças viram fila única de "a enviar", e o próximo bipe as junta na
     * MESMA caixa nova — uma caixa, uma etiqueta. Por isso o merge que eu tinha
     * escrito (mover itens pra caixa aberta) saiu: virou desnecessário.
     */
    let voltaramPendentes = 0;
    if (idsItens.length) {
      const upd = await this.prisma.transferOrder.updateMany({
        where: { id: { in: idsItens } } as any,
        data: {
          realignmentStatus: 'pending',
          realignmentSentAt: null,
          shipmentId: null,
        } as any,
      });
      voltaramPendentes = upd.count ?? 0;
    }

    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: {
        // 'cancelled' e não 'open': a caixa ficou vazia, e caixa vazia na tela
        // é só um "Fechar e enviar" que não fecha nada. A próxima nasce no
        // primeiro bipe, com número novo.
        status: 'cancelled',
        sentAt: null,
        sentByUserId: null,
        stockDecreasedAt: null,
        totalItems: 0,
        totalQty: 0,
        envioGeneratedAt: null,
        trackingCode: null,
        correiosPrepostagemId: null,
        carrier: null,
        notes: [shipment.notes, `${carimbo} — ${voltaramPendentes} peça(s) devolvidas pra "a enviar"`]
          .filter(Boolean).join(' | ').slice(0, 900),
      } as any,
    });

    // 4. Desavisa o destino — ele recebeu "chegando caixa" quando fechou.
    try {
      const destStore = await this.prisma.store.findUnique({
        where: { code: shipment.toStoreCode },
        select: { id: true } as any,
      });
      if (destStore) {
        this.gateway.emitToStore((destStore as any).id, 'shipment:cancelled', {
          shipmentId: shipment.id,
          code: shipment.code,
          fromStoreName: shipment.fromStoreName,
          motivo: 'reaberta na origem',
        });
      }
    } catch (e) {
      this.logger.warn(`[reopen] falha avisando destino: ${(e as Error).message}`);
    }

    this.logger.log(
      `[reopen] ${shipment.code} reaberta por ${input.userId ?? 'loja'}: ` +
      `${devolvidos} SKU(s) devolvido(s) ao estoque de ${shipment.fromStoreCode}, ` +
      `${obrigacoes} obrigação(ões) cancelada(s), ` +
      `${voltaramPendentes} peça(s) de volta em "a enviar"`,
    );

    return {
      ok: true,
      code: shipment.code,
      itens: items.length,
      estoqueDevolvido: devolvidos,
      obrigacoesCanceladas: obrigacoes,
      voltaramPendentes,
      etiquetaDescartada,
      notaCancelada,
    };
  }

  /**
   * Adiciona uma TransferOrder a uma remessa (criando ou reutilizando a
   * remessa aberta do par origem→destino).
   *
   * Vendedora chama esse método uma vez por peça que está separando.
   * Não baixa Giga ainda — só linka ao shipment.
   */
  async addItemToShipment(input: {
    transferOrderId: string;
    storeId: string;
    userId?: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true, name: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferOrderId },
      select: {
        id: true,
        tipo: true,
        lojaOrigemCode: true,
        lojaOrigemName: true,
        lojaDestinoCode: true,
        lojaDestinoName: true,
        realignmentStatus: true,
        shipmentId: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
      } as any,
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    const o = order as any;
    if (o.tipo !== 'REALINHAMENTO')
      throw new BadRequestException('Ordem não é de realinhamento');
    if (o.lojaOrigemCode !== (store as any).code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (o.realignmentStatus === 'sent')
      throw new BadRequestException('Item já está em uma remessa');
    if (o.realignmentStatus === 'received')
      throw new BadRequestException('Item já foi recebido');

    // Procura remessa OPEN do par origem→destino.
    // tipo + orderBy DESC: mesma regra do markAsSent — o bipe cai SEMPRE na
    // caixa que o cartão da tela mostra (a mais recente), nunca numa antiga
    // invisível (caixa fantasma da REM-809, 05/08).
    let shipment = await (this.prisma as any).realignmentShipment.findFirst({
      where: {
        fromStoreCode: o.lojaOrigemCode,
        toStoreCode: o.lojaDestinoCode,
        status: 'open',
        tipo: 'REALINHAMENTO',
      },
      orderBy: [{ openedAt: 'desc' }, { code: 'desc' }],
    });

    // Se não tem aberta, cria nova (com retry em caso de colisão de code)
    if (!shipment) {
      shipment = await this.createShipmentWithRetry({
        fromStoreCode: o.lojaOrigemCode,
        fromStoreName: o.lojaOrigemName,
        toStoreCode: o.lojaDestinoCode,
        toStoreName: o.lojaDestinoName,
        openedByUserId: input.userId ?? null,
      });
      this.logger.log(`[shipment] Nova remessa ${shipment.code} aberta ${o.lojaOrigemCode}→${o.lojaDestinoCode}`);
    }

    // Marca item como sent + linka ao shipment
    const updated = await this.prisma.transferOrder.update({
      where: { id: o.id },
      data: {
        realignmentStatus: 'sent',
        realignmentSentAt: new Date(),
        realignmentSentByUserId: input.userId ?? null,
        shipmentId: shipment.id,
      } as any,
    });

    return { ok: true, shipmentId: shipment.id, shipmentCode: shipment.code, transferOrderId: (updated as any).id };
  }

  /**
   * TRANSFERÊNCIA PONTO A PONTO (manual): a loja ORIGEM escolhe o DESTINO e
   * BIPA o código. Resolve a peça no Giga, cria um TransferOrder ad-hoc
   * (tipo TRANSFERENCIA) e linka numa remessa TRANSFERENCIA do par origem→
   * destino (separada das caixas de realinhamento). Estoque insuficiente na
   * origem só ALERTA (não bloqueia). Daí pra frente é o MESMO trilho do
   * realinhamento (fechar/enviar = closeAndSend, conferência por bip no destino).
   */
  async biparTransferencia(input: {
    storeId: string;
    destinoCode: string;
    codigo: string;
    userId?: string | null;
    userName?: string | null;
  }) {
    const origem = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true, name: true } as any,
    });
    if (!origem) throw new ForbiddenException('Loja inválida');
    const destino = await this.prisma.store.findFirst({
      where: { code: input.destinoCode, active: true } as any,
      select: { code: true, name: true } as any,
    });
    if (!destino) throw new NotFoundException('Loja destino não encontrada');
    if ((destino as any).code === (origem as any).code)
      throw new BadRequestException('Origem e destino são a mesma loja');
    const codigo = String(input.codigo || '').trim();
    if (!codigo) throw new BadRequestException('Código obrigatório');

    // Valida/resolve o código bipado pela MESMA rotina do PDV: getPdvProductInfo.
    // É a validação mais batida do sistema (o PDV bipa o dia todo). Ela trata
    // padding + EAN13, resolve o CODIGO real E JÁ DEVOLVE O PREÇO na mesma chamada.
    // Isso elimina a chamada ao pool de preço separado (getPricesByCodigos), que
    // era justamente o que PENDURAVA a transferência durante a reconstrução das
    // tabelas do Giga — a triagem/PDV não passam por aquele pool, por isso iam de boa.
    // ESPELHO PRIMEIRO (01/08). Era `this.erp.getPdvProductInfo`, indo direto no
    // MySQL — o ÚNICO bipe do sistema fora do espelho: os outros dez já passam
    // pelo WincredCatalogService. Resultado: com o Giga pendurado, a triagem
    // travava no primeiro bipe enquanto o PDV da mesma loja bipava normalmente.
    //
    // O catálogo tem a MESMA assinatura e já traz o recuo pro Giga embutido
    // (miss, EAN, produto recém-cadastrado, preço zerado) — a troca não muda o
    // que a triagem enxerga, só de onde vem primeiro.
    const info = await this.catalog.getPdvProductInfo(codigo);
    if (!info) throw new NotFoundException(`Código ${codigo} não encontrado`);

    const codigoReal = info.sku; // CODIGO real resolvido pela rotina do PDV
    const ref = String(info.ref || codigoReal).trim();
    const cor = info.cor ? String(info.cor).trim() : null;
    const tamanho = info.tamanho ? String(info.tamanho).trim() : null;
    const descricao = (info.descricao || '').trim() || null;

    // Preço já vem da rotina do PDV. Fallback no espelho local (Postgres) se vier 0.
    // Transferência NÃO bloqueia por preço (é só snapshot pra conferência/impresso).
    let precoReais = Number(info.preco) || 0;
    if (!precoReais) {
      try {
        const gp = await (this.prisma as any).gigaProduto.findFirst({
          where: { codigo: codigoReal },
          select: { vendaUn: true },
        });
        precoReais = Number(gp?.vendaUn) || 0;
      } catch {
        /* sem preço — segue */
      }
    }

    // Estoque na origem — só ALERTA, não bloqueia. Best-effort com timeout curto
    // pra NUNCA travar (Giga reconstrói tabelas ao vivo e a query pode pendurar).
    const withTimeout = <T>(p: Promise<T>, ms: number, fb: T): Promise<T> =>
      Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fb), ms))]);
    const detailed = await withTimeout(
      this.erp
        .getStockBySkusDetailed([codigoReal])
        .catch(() => ({} as Record<string, Array<{ storeCode: string; qty: number }>>)),
      4000,
      {} as Record<string, Array<{ storeCode: string; qty: number }>>,
    );
    const origemQty =
      (detailed[codigoReal] || []).find((e) => e.storeCode === (origem as any).code)?.qty || 0;
    const alerta =
      origemQty < 1
        ? `Atenção: a loja origem (${(origem as any).code}) não tem estoque dessa peça — bipe permitido mesmo assim.`
        : null;
    const precoUnitCents = Math.round((precoReais || 0) * 100);

    // Cria o TransferOrder ad-hoc (tipo TRANSFERENCIA) — 1 peça por bipe (cada
    // unidade vira uma linha; não soma SKU igual).
    const order = await this.prisma.transferOrder.create({
      data: {
        tipo: 'TRANSFERENCIA',
        refCode: ref,
        codigoBipado: codigo,
        descricao,
        cor,
        tamanho,
        qtyOrigem: 1,
        precoUnitCents,
        lojaOrigemCode: (origem as any).code,
        lojaOrigemName: (origem as any).name,
        lojaDestinoCode: (destino as any).code,
        lojaDestinoName: (destino as any).name,
        solicitanteNome: input.userName || 'Operador',
        mensagem: `📦 TRANSFERÊNCIA — ${(origem as any).code}→${(destino as any).code}: ${ref} ${cor || ''} ${tamanho || ''}`.trim(),
        createdByUserId: input.userId ?? null,
        realignmentStatus: 'pending',
      } as any,
    });

    // Acha/cria a remessa ABERTA de TRANSFERENCIA do par origem→destino
    let shipment = await (this.prisma as any).realignmentShipment.findFirst({
      where: {
        fromStoreCode: (origem as any).code,
        toStoreCode: (destino as any).code,
        status: 'open',
        tipo: 'TRANSFERENCIA',
      },
    });
    if (!shipment) {
      shipment = await this.createShipmentWithRetry({
        fromStoreCode: (origem as any).code,
        fromStoreName: (origem as any).name,
        toStoreCode: (destino as any).code,
        toStoreName: (destino as any).name,
        openedByUserId: input.userId ?? null,
        tipo: 'TRANSFERENCIA',
      });
    }

    // Linka a ordem na remessa (mesma marcação do realinhamento)
    await this.prisma.transferOrder.update({
      where: { id: order.id },
      data: {
        realignmentStatus: 'sent',
        realignmentSentAt: new Date(),
        realignmentSentByUserId: input.userId ?? null,
        shipmentId: shipment.id,
      } as any,
    });

    return {
      ok: true,
      shipmentId: shipment.id,
      shipmentCode: shipment.code,
      alerta,
      item: {
        id: order.id,
        codigo: codigoReal,
        ref,
        descricao: order.descricao,
        cor,
        tamanho,
        precoUnitCents,
        estoqueOrigem: origemQty,
      },
    };
  }

  /**
   * Remove um item de uma remessa OPEN (vendedora errou, quer tirar).
   * Volta status pra pending.
   */
  /**
   * Pré-verifica estoque Giga pra todos os items da remessa, SEM fazer UPDATE.
   * Retorna lista de items com problema (estoque insuficiente). Usado pelo
   * fluxo de fechamento ANTES da transação real, e pelo endpoint de precheck
   * que o frontend chama pra mostrar UI de problemas.
   *
   * @param items items da remessa (transferOrders) — fonte da verdade
   * @param stockItems items já com SKU resolvido pelo findCodigoByRefCorTam
   */
  private async precheckStockForShipment(
    items: Array<{ id: string; refCode: string; cor: string | null; tamanho: string | null; qtyOrigem: number }>,
    stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }>,
  ): Promise<{
    problemas: Array<{
      transferOrderId: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      qtyRequerida: number;
      sku: string;
      storeCode: string;
      estoqueGiga: number;
    }>;
  }> {
    const problemas: Array<any> = [];
    // Mapeia transferOrders por (refCode, cor, tamanho) pra associar com stockItems
    const itemByKey = new Map<string, typeof items[0]>();
    for (const it of items) {
      const key = `${it.refCode}::${it.cor || ''}::${it.tamanho || ''}`;
      itemByKey.set(key, it);
    }

    // FIX 2 (root cause): o Giga tem MÚLTIPLOS CODIGOs cadastrados pra MESMA
    // peça (REF+COR+TAM). `findCodigoByRefCorTam` retorna só UM (LIMIT 1) — se
    // esse SKU está zerado mas OUTRO SKU da mesma peça tem estoque, o precheck
    // bloqueava tudo mesmo com peça física disponível.
    //
    // Solução: agrupa stockItems por (refCode, cor, tamanho) e soma a qty pedida
    // de cada grupo, depois pra cada grupo busca SOMA de TODOS os SKUs daquela
    // peça via getStockByRefCorTamInStore.

    // Agrupa stockItems por (refCode, cor, tamanho) usando o item original pra
    // pegar cor/tamanho (stockItems não tem essas infos diretamente).
    const stockByItem = new Map<string, { item: typeof items[0]; qtyTotal: number; sku: string; storeCode: string }>();
    for (const si of stockItems) {
      const itemMatch = items.find((it) => it.refCode === si.refCode);
      if (!itemMatch) continue;
      const key = `${si.refCode}::${itemMatch.cor || ''}::${itemMatch.tamanho || ''}::${si.storeCode}`;
      const prev = stockByItem.get(key);
      if (prev) {
        prev.qtyTotal += si.qty;
      } else {
        stockByItem.set(key, {
          item: itemMatch,
          qtyTotal: si.qty,
          sku: si.sku,
          storeCode: si.storeCode,
        });
      }
    }

    // BATCH: 1 query so pra resolver REF+COR+TAM → estoque (em vez de N queries seriais)
    const batchInput: Array<{ refCode: string; cor: string | null; tamanho: string | null; storeCode: string }> = [];
    for (const grp of stockByItem.values()) {
      batchInput.push({
        refCode: grp.item.refCode,
        cor: grp.item.cor,
        tamanho: grp.item.tamanho,
        storeCode: grp.storeCode,
      });
    }
    let batchResult = new Map<string, { totalQty: number; codigos: string[] }>();
    try {
      batchResult = await this.erp.getStockByRefCorTamInStoreBatch(batchInput);
    } catch (e) {
      this.logger.warn(`precheck: getStockByRefCorTamInStoreBatch falhou: ${(e as Error).message} — caindo pra leitura individual`);
    }

    for (const grp of stockByItem.values()) {
      const key = `${String(grp.item.refCode).trim().toUpperCase()}::${String(grp.item.cor || '').trim().toUpperCase()}::${String(grp.item.tamanho || '').trim().toUpperCase()}::${String(grp.storeCode).trim()}`;
      let estoqueGiga = 0;
      const found = batchResult.get(key);
      if (found) {
        estoqueGiga = found.totalQty;
      } else {
        // Fallback individual (caso o batch tenha falhado)
        try {
          const r = await this.erp.getStockByRefCorTamInStore(
            grp.item.refCode,
            grp.item.cor,
            grp.item.tamanho,
            grp.storeCode,
          );
          estoqueGiga = r.totalQty;
        } catch (e) {
          this.logger.warn(`precheck fallback ${grp.item.refCode}: ${(e as Error).message}`);
        }
      }
      if (estoqueGiga < grp.qtyTotal) {
        problemas.push({
          transferOrderId: grp.item.id,
          refCode: grp.item.refCode,
          cor: grp.item.cor,
          tamanho: grp.item.tamanho,
          qtyRequerida: grp.qtyTotal,
          sku: grp.sku,
          storeCode: grp.storeCode,
          estoqueGiga,
        });
      }
    }
    return { problemas };
  }

  /**
   * Versão pública do precheck — usado pelo frontend ANTES de tentar fechar
   * a remessa. Retorna lista de items com estoque problemático pra UI mostrar
   * antes de chamar closeAndSend.
   */
  async precheckCloseShipment(input: { shipmentId: string; storeId: string }) {
    const tStart = Date.now();
    const store = await this.prisma.store.findUnique({ where: { id: input.storeId } });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.fromStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'open')
      throw new BadRequestException(`Remessa não está aberta (status=${shipment.status})`);

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      select: { id: true, refCode: true, codigoBipado: true, cor: true, tamanho: true, qtyOrigem: true } as any,
    });
    if (!items.length) return { ok: true, totalItems: 0, problemas: [] };

    // OTIMIZADO: items com codigoBipado vao DIRETO (zero query). Os outros
    // resolvem via 1 query batch unica. Antes: loop sync com N queries seriais
    // = ~3-5 segundos pra 45 itens. Agora: ~150ms total.
    const tResolve = Date.now();
    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ transferOrderId: string; refCode: string; cor: string | null; tamanho: string | null }> = [];

    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }

    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(`[precheck] batchFindCodigosByRefCorTam falhou: ${(e as Error).message}`);
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    for (const it of items as any[]) {
      try {
        let sku: string | null = it.codigoBipado || null;
        if (!sku) sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
        if (!sku) {
          unresolved.push({ transferOrderId: it.id, refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
          continue;
        }
        stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.fromStoreCode, refCode: it.refCode });
      } catch {
        unresolved.push({ transferOrderId: it.id, refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    this.logger.log(`[precheck] resolveSku ${items.length} items em ${Date.now() - tResolve}ms`);

    const tStock = Date.now();
    const { problemas } = await this.precheckStockForShipment(items as any[], stockItems);
    this.logger.log(`[precheck] stockCheck em ${Date.now() - tStock}ms. TOTAL: ${Date.now() - tStart}ms`);
    // `ok` agora considera SO `unresolved` (SKU nao encontrado) como bloqueador.
    // Estoque divergente (problemas) e apenas AVISO - backend ja roda
    // closeAndSend com allowNegative, peca em maos prevalece.
    return {
      ok: unresolved.length === 0,
      totalItems: items.length,
      unresolved,
      problemas,
    };
  }

  async removeItemFromShipment(input: { transferOrderId: string; storeId: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferOrderId },
      select: {
        id: true,
        lojaOrigemCode: true,
        shipmentId: true,
        realignmentStatus: true,
      } as any,
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    const o = order as any;
    if (o.lojaOrigemCode !== (store as any).code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (!o.shipmentId) throw new BadRequestException('Item não está em remessa');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: o.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.status !== 'open')
      throw new BadRequestException('Remessa já foi fechada — não pode remover item');

    await this.prisma.transferOrder.update({
      where: { id: o.id },
      data: {
        realignmentStatus: 'pending',
        realignmentSentAt: null,
        realignmentSentByUserId: null,
        shipmentId: null,
      } as any,
    });

    return { ok: true };
  }

  /**
   * FECHA a remessa: status → in_transit, baixa Giga origem em batch,
   * emite socket pra loja destino mostrar alerta.
   *
   * NÃO permite fechar remessa vazia (precisa ter pelo menos 1 item).
   */
  async closeAndSend(input: { shipmentId: string; storeId: string; userId?: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.fromStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'open')
      throw new BadRequestException(`Remessa não está aberta (status=${shipment.status})`);

    // Itens da remessa. SÓ O QUE FOI SEPARADO (status 'sent') fecha e baixa
    // estoque — desde 04/08 a caixa também carrega o que ainda falta pegar
    // (a sobra herdada da caixa anterior), e essas peças não podem sair do
    // estoque sem alguém ter posto a mão nelas. Elas rolam pra caixa nova no
    // fim deste método.
    const todosDaCaixa = await this.prisma.transferOrder.findMany({
      // Peça CANCELADA (excluída do pedido) NÃO conta como conteúdo da caixa —
      // mesmo filtro do cartão da tela (listOpenShipmentsForOrigin). Sem isso a
      // caixa que só tinha peça excluída dizia "0 item(s)" no cartão e, ao
      // fechar, respondia "bipe ao menos uma" — a vendedora via peça verde na
      // pilha (que está em OUTRA caixa) e não tinha como sair do lugar.
      where: { shipmentId: shipment.id, realignmentStatus: { not: 'cancelled' } } as any,
      select: {
        id: true,
        refCode: true,
        codigoBipado: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        realignmentStatus: true,
      } as any,
    });
    const items = (todosDaCaixa as any[]).filter((i) => i.realignmentStatus === 'sent');
    if (!items.length) {
      const naCaixa = (todosDaCaixa as any[]).length;
      // Peça VERDE na pilha que está em OUTRA caixa: a vendedora vê "todas
      // bipadas" e o fechamento diz que não tem nada. A mensagem precisa dizer
      // ONDE elas estão, senão ela fica clicando Fechar sem saída.
      const verdesEmOutraCaixa = await this.prisma.transferOrder.count({
        where: {
          tipo: 'REALINHAMENTO',
          lojaOrigemCode: shipment.fromStoreCode,
          lojaDestinoCode: shipment.toStoreCode,
          realignmentStatus: 'sent',
          NOT: { shipmentId: shipment.id },
        } as any,
      }).catch(() => 0);
      const ondeEstao = verdesEmOutraCaixa > 0
        ? ` As ${verdesEmOutraCaixa} peça(s) já bipadas deste destino estão em OUTRA remessa — confira a aba Enviados.`
        : '';
      throw new BadRequestException(
        naCaixa
          ? `Nenhuma peça foi separada nesta caixa — bipe ao menos uma antes de fechar.${ondeEstao}`
          : `Esta caixa está vazia: não há peça nenhuma dentro dela.${ondeEstao} Use "Excluir remessa" e bipe as peças de novo — a caixa nasce sozinha no primeiro bipe.`,
      );
    }

    // Resolve SKU de cada item — OTIMIZADO: items com codigoBipado direto,
    // items sem fazem 1 ÚNICA query batch pra resolver todos de uma vez.
    //
    // ANTES (lento): loop sync com N queries MySQL serial pelo
    // findCodigoByRefCorTam — uma remessa com 114 itens fazia 114 queries
    // sequenciais, ~50ms cada = ~5-6 segundos só pra resolver SKUs.
    // AGORA (rápido): items com codigoBipado vão direto (zero query); items
    // sem usam batchFindCodigosByRefCorTam (1 query SQL com OR pra todos).
    const tStart = Date.now();
    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];

    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }

    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(
          `[closeAndSend] batchFindCodigosByRefCorTam falhou: ${(e as Error).message}. ` +
          `Caindo pra resolucao individual.`,
        );
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    // SKU resolvido aqui é PERSISTIDO na peça (04/08 — caso REM-838).
    // Antes ele era usado só pra baixa de estoque e jogado fora: a linha
    // continuava sem codigoBipado e, na hora da NF-e, era pulada em silêncio
    // — caixa de 57 peças saiu com nota de 2 itens. Gravando no fechamento,
    // a nota (que é emitida DEPOIS, no gerar-envio) enxerga todas as peças.
    const skusResolvidos: Array<{ id: string; sku: string }> = [];
    for (const it of items as any[]) {
      try {
        let sku: string | null = it.codigoBipado || null;
        if (!sku) {
          sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
          if (!sku) {
            sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
          }
          if (sku) skusResolvidos.push({ id: it.id, sku });
        }
        if (!sku) {
          unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
          continue;
        }
        stockItems.push({
          sku,
          qty: it.qtyOrigem || 1,
          storeCode: shipment.fromStoreCode,
          refCode: it.refCode,
        });
      } catch (e) {
        unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    if (skusResolvidos.length) {
      try {
        await Promise.all(
          skusResolvidos.map((r) =>
            this.prisma.transferOrder.update({
              where: { id: r.id },
              data: { codigoBipado: r.sku } as any,
            }),
          ),
        );
        this.logger.log(
          `[closeAndSend] ${skusResolvidos.length} codigoBipado resolvido(s) e gravado(s) na peça`,
        );
      } catch (e) {
        // Não bloqueia o fechamento — a NF-e vai recusar depois se faltar código.
        this.logger.warn(`[closeAndSend] falha gravando codigoBipado: ${(e as Error).message}`);
      }
    }
    this.logger.log(
      `[closeAndSend] resolveSku: ${items.length} items em ${Date.now() - tStart}ms ` +
      `(${itemsSemCodigoBipado.length} via batch, ${items.length - itemsSemCodigoBipado.length} via codigoBipado)`,
    );

    // POLITICA: itens unresolved (REF+COR+TAM nao casam no Giga) NAO bloqueiam mais
    // o fechamento. Vendedora ja confirmou peca em maos clicando FORCAR FECHAMENTO.
    // Esses itens passam adiante (status sent + shipment in_transit) MAS nao baixam
    // estoque Giga na origem (porque nao tem SKU pra baixar). Admin acompanha pelo
    // log e pode resolver depois.
    //
    // ANTES: bloqueava com BadRequestException -> vendedora nao conseguia fechar
    // remessas com cadastro divergente, pecas paravam de circular.
    if (unresolved.length) {
      this.logger.warn(
        `[closeAndSend] ${shipment.code}: ${unresolved.length} item(ns) sem SKU resolvido - ` +
        `seguem na remessa SEM baixa Giga. Itens: ` +
        unresolved.map((u) => `${u.refCode} ${u.cor || ''}/${u.tamanho || ''}`).join(', '),
      );
    }

    // Pré-verifica estoque antes de iniciar transação.
    const tPrecheck = Date.now();
    const precheck = await this.precheckStockForShipment(items as any[], stockItems);
    this.logger.log(`[closeAndSend] precheck: ${Date.now() - tPrecheck}ms`);
    if (precheck.problemas.length > 0) {
      this.logger.warn(
        `closeAndSend ${shipment.code}: ${precheck.problemas.length} item(ns) com estoque insuficiente no Giga - fechando mesmo assim (allowNegative). Detalhes: ${JSON.stringify(precheck.problemas).slice(0, 500)}`,
      );
    }

    // BAIXA estoque Giga origem em transação (todos ou nada).
    const tDecrease = Date.now();
    const result = await this.erp.decreaseStock(
      stockItems.map((s) => ({ sku: s.sku, qty: s.qty, storeCode: s.storeCode })),
      { allowNegative: true, skipNotFound: true },
    );
    const appliedCount = result.applied?.length || 0;
    this.logger.log(
      `[closeAndSend] decreaseStock: ${Date.now() - tDecrease}ms ` +
      `(${stockItems.length} SKUs solicitados, ${appliedCount} aplicados)`,
    );
    // ALERTA: se decreaseStock retornou success mas NENHUM SKU foi aplicado,
    // significa que o estoque não baixou (skipNotFound silenciou). Causa
    // comum: storeCode não bate com formato LOJA do Giga, ou todos SKUs
    // estavam zerados/inexistentes na tabela estoque.
    if (!result.success) {
      throw new BadRequestException(
        `Falha ao baixar estoque Giga origem: ${result.error}. Remessa NÃO foi fechada.`,
      );
    }
    if (stockItems.length > 0 && appliedCount === 0) {
      this.logger.error(
        `[closeAndSend] ${shipment.code}: decreaseStock retornou success mas 0 SKUs aplicados! ` +
        `Possível mismatch de storeCode. fromStoreCode=${shipment.fromStoreCode} ` +
        `SKUs=[${stockItems.slice(0, 5).map((s) => s.sku).join(',')}${stockItems.length > 5 ? '...' : ''}]. ` +
        `Use POST /realignment/shipments/:id/reprocess-stock pra reaplicar.`,
      );
    }

    // Atualiza shipment → in_transit + marca stockDecreasedAt apenas se aplicou
    const now = new Date();
    const totalQty = stockItems.reduce((s, x) => s + x.qty, 0);
    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: {
        status: 'in_transit',
        sentAt: now,
        sentByUserId: input.userId ?? null,
        totalItems: items.length,
        totalQty,
        // Só marca se realmente aplicou — assim reprocess sabe quem precisa
        stockDecreasedAt: appliedCount > 0 ? now : null,
      } as any,
    });

    // ── FINANCEIRO: cria obrigações p/ itens entre grupos diferentes (REDE↔FILIAL)
    // Captura preço Giga em batch (via SKU já resolvido acima) pra ser snapshot.
    try {
      await this.createObligationsForShipment(shipment, items, stockItems, now);
    } catch (e) {
      this.logger.warn(
        `[shipment] falha criando obrigações financeiras (não bloqueante): ${(e as Error).message}`,
      );
    }

    // Emite socket pra loja DESTINO
    try {
      const destStore = await this.prisma.store.findUnique({
        where: { code: shipment.toStoreCode },
        select: { id: true } as any,
      });
      if (destStore) {
        this.gateway.emitToStore((destStore as any).id, 'shipment:incoming', {
          shipmentId: shipment.id,
          code: shipment.code,
          fromStoreCode: shipment.fromStoreCode,
          fromStoreName: shipment.fromStoreName,
          totalItems: items.length,
          totalQty,
          sentAt: now.toISOString(),
        });
      }
    } catch (e) {
      this.logger.warn(`[shipment] falha emitindo socket: ${(e as Error).message}`);
    }

    this.logger.log(
      `[shipment] ${shipment.code} fechada e enviada: ${items.length} itens, ${totalQty} peças, ` +
        `Giga ${shipment.fromStoreCode} baixou ${result.applied.length} SKUs`,
    );

    // ── SOBRA VIRA CAIXA NOVA (04/08 — pedido do dono) ──────────────────
    // Fechou a caixa sem estar 100% verde? O que faltou não pode ficar solto:
    // abre AGORA uma remessa nova, com número próprio, já carregando as peças
    // que não foram achadas/clicadas. A loja continua de onde parou e a matriz
    // enxerga a pendência como caixa, não como lista solta.
    //
    // Entram: o que sobrou pendente pra este destino (com ou sem caixa) e as
    // marcadas como "não achei" — estas voltam pra 'pending', que é uma nova
    // chance de procurar a peça. Nada disso baixa estoque: só o verde baixou.
    let novaRemessa: { id: string; code: string; totalItens: number } | null = null;
    try {
      const sobra = await this.prisma.transferOrder.findMany({
        where: {
          tipo: 'REALINHAMENTO',
          lojaOrigemCode: shipment.fromStoreCode,
          lojaDestinoCode: shipment.toStoreCode,
          realignmentStatus: { in: ['pending', 'not_found'] },
        } as any,
        select: { id: true } as any,
      });
      if (sobra.length > 0) {
        // REAPROVEITA caixa aberta existente do par antes de fabricar outra.
        // Era uma das fontes da CAIXA DUPLICADA (05/08): a sobra criava uma
        // nova mesmo já havendo aberta, e o par ficava com duas — o bipe caía
        // numa e o cartão da tela mostrava a outra ("0 item(s)" com a grade
        // verde). Mesma regra de escolha do bipe: a mais recente.
        let nova = await (this.prisma as any).realignmentShipment.findFirst({
          where: {
            fromStoreCode: shipment.fromStoreCode,
            toStoreCode: shipment.toStoreCode,
            status: 'open',
            tipo: shipment.tipo,
            id: { not: shipment.id },
          },
          orderBy: [{ openedAt: 'desc' }, { code: 'desc' }],
        });
        if (!nova) {
          nova = await this.createShipmentWithRetry({
            fromStoreCode: shipment.fromStoreCode,
            fromStoreName: shipment.fromStoreName,
            toStoreCode: shipment.toStoreCode,
            toStoreName: shipment.toStoreName,
            tipo: shipment.tipo,
            openedByUserId: input.userId ?? null,
          });
        }
        await this.prisma.transferOrder.updateMany({
          where: { id: { in: sobra.map((s: any) => s.id) } },
          data: {
            shipmentId: nova.id,
            realignmentStatus: 'pending',
            realignmentNotFoundAt: null,
            realignmentNotFoundNote: null,
            realignmentNotFoundByUserId: null,
          } as any,
        });
        novaRemessa = { id: nova.id, code: nova.code, totalItens: sobra.length };
        this.logger.log(
          `[shipment] sobra de ${shipment.code}: ${sobra.length} peça(s) foram pra caixa nova ${nova.code}`,
        );
      }
    } catch (e) {
      // A caixa fechada já saiu — não pode falhar por causa da sobra.
      this.logger.warn(
        `[shipment] falha criando caixa da sobra de ${shipment.code}: ${(e as Error).message}`,
      );
    }

    // O cartão "recém-enviada" da tela precisa saber NA HORA se a caixa é da
    // rota do carro — sem isto ele oferecia "Gerar envio Correios" verde numa
    // caixa de Santos e o clique respondia o erro de transporte PRÓPRIO
    // (04/08). Best-effort: falha aqui não pode desfazer o fechamento.
    let rotaPropria = false;
    try {
      rotaPropria = (await this.envio.transporteEfetivo(shipment)) === 'proprio';
    } catch { /* segue como correios */ }

    return {
      ok: true,
      code: shipment.code,
      totalItems: items.length,
      totalQty,
      novaRemessa,
      rotaPropria,
      toStoreName: shipment.toStoreName || shipment.toStoreCode,
    };
  }

  /**
   * Cria obrigações financeiras pra todos os itens do shipment quando
   * as lojas envolvidas são de grupos diferentes (REDE↔FILIAL).
   *
   * Snapshot do preço Giga é capturado em batch. Mês de referência = mês
   * da data de envio. Convenção: TO (destino) paga FROM (origem).
   */
  private async createObligationsForShipment(
    shipment: any,
    items: any[],
    stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }>,
    sentAt: Date,
  ) {
    // Carrega tipo das 2 lojas (snapshot — preserva histórico)
    const [from, to] = await Promise.all([
      this.prisma.store.findUnique({
        where: { code: shipment.fromStoreCode },
        select: { code: true, name: true, tipo: true } as any,
      }),
      this.prisma.store.findUnique({
        where: { code: shipment.toStoreCode },
        select: { code: true, name: true, tipo: true } as any,
      }),
    ]);
    const fromTipo = (from as any)?.tipo || 'REDE';
    const toTipo = (to as any)?.tipo || 'REDE';

    // Mesmo grupo → sem cobrança
    if (fromTipo === toTipo) return;

    // Busca preços Giga em batch — VENDAUN em REAIS (RealignmentPricingService),
    // NÃO o getProductPricesBySkus (que divide VENDAUN por 100 e gerava
    // obrigações ÷100, ex.: R$ 1,90/peça em vez de R$ 190).
    const skus = stockItems.map((s) => s.sku);
    const refs = Array.from(new Set(stockItems.map((s) => s.refCode).filter(Boolean)));
    const priceMap = await this.pricing.getPricesByCodigos(skus);
    const refPriceMap = await this.pricing.getPricesByRefs(refs);

    // Mapa REF→SKU pra encontrar item correto
    const refToSku = new Map<string, string>();
    for (const s of stockItems) refToSku.set(s.refCode, s.sku);

    // Mês de referência
    const mesReferencia = `${sentAt.getFullYear()}-${String(sentAt.getMonth() + 1).padStart(2, '0')}`;

    for (const it of items as any[]) {
      const sku = refToSku.get(it.refCode);
      const preco = (sku ? priceMap.get(sku) || 0 : 0) || refPriceMap.get(it.refCode) || 0;
      // Preço não resolvido → a obrigação NASCE (a peça viajou, a dívida
      // existe) mas com R$ 0 — e isso não pode ser silencioso: some dinheiro
      // do acerto REDE↔FILIAL sem ninguém ver. Fica gritado no log.
      if (!preco) {
        this.logger.warn(
          `[shipment] ${shipment.code}: obrigação de ${it.refCode} ${it.cor || ''}/${it.tamanho || ''} ` +
          `criada com PREÇO ZERO (sem preço no Giga por SKU nem por REF) — corrigir no acerto do mês.`,
        );
      }
      const qty = it.qtyOrigem || 1;
      const precoTotal = preco * qty;
      const divisor = 2.5;
      const valorObrigacao = precoTotal / divisor;

      await (this.prisma as any).interStoreObligation.create({
        data: {
          transferOrderId: it.id,
          fromStoreCode: shipment.fromStoreCode,
          fromStoreName: shipment.fromStoreName,
          fromStoreTipo: fromTipo,
          toStoreCode: shipment.toStoreCode,
          toStoreName: shipment.toStoreName,
          toStoreTipo: toTipo,
          refCode: it.refCode,
          sku: sku || null,
          cor: it.cor,
          tamanho: it.tamanho,
          descricao: it.descricao,
          qty,
          precoUnitario: preco,
          precoTotal,
          divisor,
          valorObrigacao,
          mesReferencia,
          status: 'pending',
        },
      });
    }

    this.logger.log(
      `[shipment] ${shipment.code}: ${items.length} obrigações financeiras criadas ` +
        `(${fromTipo}→${toTipo}) mês=${mesReferencia}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOJA DESTINO — receber e dar entrada
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista remessas chegando na loja destino (status in_transit).
   * Inclui contagem de itens já bipados pra UI mostrar progresso.
   */
  async listIncomingShipments(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where: { toStoreCode: (store as any).code, status: 'in_transit' },
      orderBy: { sentAt: 'desc' },
    });

    return shipments;
  }

  /**
   * Detalhe completo de uma remessa (todos os itens com status individual).
   * Usado pela tela de recebimento — vendedora vê o que tem que conferir.
   */
  async getShipmentDetail(input: { shipmentId: string; storeId: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    // AS DUAS PONTAS enxergam o conteúdo. A checagem era só do destino (quem
    // confere ao receber), e isso barrava a loja de ORIGEM de olhar o que
    // colocou na própria caixa — que é o "Verificar conteúdo" da tela dela.
    // Ver a lista do que ela mesma separou não expõe nada de outra loja.
    const minha =
      shipment.toStoreCode === (store as any).code ||
      shipment.fromStoreCode === (store as any).code;
    if (!minha) throw new ForbiddenException('Essa remessa não é da sua loja');

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      orderBy: [{ refCode: 'asc' }],
      select: {
        id: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        descricao: true,
        realignmentStatus: true,
        realignmentReceivedAt: true,
        realignmentMissingAt: true,
        realignmentMissingNote: true,
      } as any,
    });

    return { ...shipment, items };
  }

  /**
   * Bipa um item da remessa pra marcar como conferido.
   *
   * A vendedora bipa o EAN/SKU. O sistema procura na lista de itens da
   * remessa um que case por SKU (resolvido via Giga REF+cor+tamanho).
   * Se achar, marca como `received`. Se não, retorna erro com sugestão.
   *
   * Itens já marcados como `received` ou `missing` não podem ser bipados de novo.
   */
  /**
   * RECONCILIAÇÃO: pra remessa em trânsito, percorre cada item e tenta
   * encontrar o CODIGO Wincred real pela DESCRIÇÃO + COR + TAMANHO.
   * Salva como codigoBipado no TransferOrder — fazendo bipe E1 (match direto)
   * funcionar instantaneamente, sem precisar do lookup REF+COR+TAM.
   *
   * Lida com zeros à esquerda via skuVariants no fallback E2.
   *
   * Usado quando vendedora reclama "bipe não acha" — admin roda esse e
   * a remessa volta a aceitar bipes.
   */
  async refreshSkusForShipment(shipmentId: string): Promise<{
    ok: boolean;
    code: string;
    total: number;
    updated: number;
    unresolved: number;
    details: Array<{
      transferOrderId: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      descricao: string | null;
      codigoAntes: string | null;
      codigoDepois: string | null;
      via: 'descricao' | 'ref-cor-tam' | 'sku-variants' | 'nao-encontrado';
    }>;
  }> {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId } as any,
      select: {
        id: true, refCode: true, cor: true, tamanho: true,
        descricao: true, codigoBipado: true,
      } as any,
    });

    const norm = (s: any) => String(s ?? '').trim().toUpperCase();
    const stripZeros = (s: string) => String(s || '').trim().replace(/^0+/, '') || '0';
    const details: any[] = [];
    let updated = 0;
    let unresolved = 0;

    for (const it of items as any[]) {
      let codigoNovo: string | null = null;
      let via: 'descricao' | 'ref-cor-tam' | 'sku-variants' | 'nao-encontrado' = 'nao-encontrado';

      // ESTRATÉGIA 1: busca por DESCRIÇÃO + COR + TAMANHO (priorizada por estoque)
      if (it.descricao) {
        try {
          const rows = await this.erp.searchByDescriptionPlusCorTam(
            it.descricao, it.cor, it.tamanho,
          );
          if (rows && rows.length > 0) {
            codigoNovo = String(rows[0].CODIGO).trim();
            via = 'descricao';
          }
        } catch (e) {
          this.logger.warn(`[refresh-skus] searchByDescription falhou pra ${it.refCode}: ${(e as Error).message}`);
        }
      }

      // ESTRATÉGIA 2: fallback REF + COR + TAM com variantes de zero-padding
      if (!codigoNovo) {
        try {
          codigoNovo = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
          if (codigoNovo) via = 'ref-cor-tam';
        } catch {}
      }

      // ESTRATÉGIA 3: se já tinha codigoBipado salvo, mantém (não força sobrescrever)
      if (!codigoNovo && it.codigoBipado) {
        codigoNovo = it.codigoBipado;
        via = 'sku-variants';
      }

      const codigoAntes = it.codigoBipado;
      const mudou = codigoNovo && codigoNovo !== codigoAntes;

      if (codigoNovo && mudou) {
        await this.prisma.transferOrder.update({
          where: { id: it.id },
          data: { codigoBipado: codigoNovo } as any,
        });
        updated++;
      }

      if (!codigoNovo) unresolved++;

      details.push({
        transferOrderId: it.id,
        refCode: it.refCode,
        cor: it.cor,
        tamanho: it.tamanho,
        descricao: it.descricao,
        codigoAntes,
        codigoDepois: codigoNovo,
        via,
      });
    }

    // Invalida cache pra forçar refresh no próximo bipe
    this.invalidateSkuCache(shipmentId);

    this.logger.log(
      `[refresh-skus] ${shipment.code}: ${items.length} items, ${updated} atualizados, ${unresolved} unresolved`,
    );

    return {
      ok: true,
      code: shipment.code,
      total: items.length,
      updated,
      unresolved,
      details,
    };
  }

  async scanItem(input: { shipmentId: string; sku: string; storeId: string; userId?: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.toStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'in_transit')
      throw new BadRequestException(`Remessa não está em trânsito (status=${shipment.status})`);

    const skuBipado = String(input.sku || '').trim();
    if (!skuBipado) throw new BadRequestException('SKU vazio');

    // ⚡ PARALELO: resolveSkuInfo (Wincred) + findMany items (Postgres) rodam
    // ao mesmo tempo — bipe mais rápido (~50-100ms a menos por bipe).
    const [info, items] = await Promise.all([
      this.erp.resolveSkuInfo(skuBipado),
      this.prisma.transferOrder.findMany({
        where: { shipmentId: shipment.id } as any,
        select: {
          id: true,
          refCode: true,
          cor: true,
          tamanho: true,
          realignmentStatus: true,
          codigoBipado: true,
        } as any,
      }),
    ]);
    const skuNormalizado = info?.codigo || skuBipado;

    const stripZeros = (s: string) => String(s || '').trim().replace(/^0+/, '') || '0';
    const norm = (s: any) => String(s ?? '').trim().toUpperCase();
    const skuBipadoStripped = stripZeros(skuNormalizado);

    // === MATCH EM MEMORIA — zero queries MySQL no loop ===
    let matchedItemId: string | null = null;
    let matchedRefCode: string | null = null;
    const pendingItems = (items as any[]).filter(
      (it) => it.realignmentStatus !== 'received' && it.realignmentStatus !== 'missing',
    );

    // E1: match direto via codigoBipado salvo (re-bipe / idempotencia)
    for (const it of pendingItems) {
      if (it.codigoBipado && stripZeros(it.codigoBipado) === skuBipadoStripped) {
        matchedItemId = it.id;
        matchedRefCode = it.refCode;
        break;
      }
    }

    // E2: BATCH lookup Wincred COM CACHE — 1 query no 1º bipe, próximos batem na memória.
    // Usa batchFindAllCodigos (não o que filtra por estoque) — bipagem precisa
    // comparar com TODOS os CODIGOs candidatos. Wincred costuma ter cadastro
    // duplicado (mesma REF+COR+TAM em 2 CODIGOs); a peça física pode ser
    // QUALQUER UM deles, não só o de maior estoque.
    if (!matchedItemId && pendingItems.length > 0) {
      let cached = this.skuCache.get(shipment.id);
      const nowMs = Date.now();
      if (!cached || cached.expiresAt < nowMs) {
        const allCodigosMap = await this.erp.batchFindAllCodigosByRefCorTam(
          (items as any[]).map((it) => ({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho })),
        );
        // Mantém compatibilidade do skuCache (Map<string, string>) gravando
        // todos os CODIGOs separados por vírgula. Match abaixo trata como Set.
        const flatMap = new Map<string, string>();
        for (const [k, set] of allCodigosMap.entries()) {
          flatMap.set(k, Array.from(set).join(','));
        }
        cached = { skuMap: flatMap, expiresAt: nowMs + this.CACHE_TTL_MS };
        this.skuCache.set(shipment.id, cached);
        this.logger.log(`[shipment] cache SKU populado pra ${shipment.code} (${flatMap.size} chaves, ${Array.from(allCodigosMap.values()).reduce((s, set) => s + set.size, 0)} CODIGOs totais)`);
      }
      for (const it of pendingItems) {
        const key = `${norm(it.refCode)}|${norm(it.cor)}|${norm(it.tamanho)}`;
        const allCodigosStr = cached.skuMap.get(key);
        if (!allCodigosStr) continue;
        // Compara com TODOS os CODIGOs candidatos (split por vírgula)
        const candidatos = allCodigosStr.split(',');
        const hit = candidatos.some((c) => stripZeros(c) === skuBipadoStripped);
        if (hit) {
          matchedItemId = it.id;
          matchedRefCode = it.refCode;
          break;
        }
      }
    }

    // E3 (antes da E4): match por REF BASE + COR + TAM — INSTANTÂNEO (sem query MySQL).
    // Usa o `info` já resolvido no Promise.all inicial. Cobre o caso clássico Lurd's:
    // Remessa tem REF "12608" (base), peça Wincred tem REF "12608V" (sufixo da cor).
    // Strip sufixo de letras em ambas REFs antes de comparar.
    if (!matchedItemId && info && info.ref) {
      const stripSufixoLetras = (s: string) => norm(s).replace(/[A-Z]+$/, '');
      const skuRefBase = stripSufixoLetras(info.ref);
      const skuCor = norm(info.cor);
      const skuTam = norm(info.tamanho);
      if (skuRefBase && skuCor && skuTam) {
        for (const it of pendingItems) {
          const itRefBase = stripSufixoLetras(it.refCode);
          if (
            itRefBase === skuRefBase &&
            norm(it.cor) === skuCor &&
            norm(it.tamanho) === skuTam
          ) {
            matchedItemId = it.id;
            matchedRefCode = it.refCode;
            this.logger.log(
              `[scanItem] E3 match por REF base: ${skuBipado} (${info.ref}/${info.cor}/${info.tamanho}) bateu com item ${it.refCode}/${it.cor}/${it.tamanho}`,
            );
            break;
          }
        }
      }
    }

    // E4: ÚLTIMO recurso — fallback LIKE/REF+TAM (cobre caso raro de cor com
    // grafia diferente, ex: "BEGE" vs "XADREZ BEGE"). LENTO porque faz 1 query
    // MySQL por item pendente — só roda se TODAS as outras 3 estratégias falharam.
    if (!matchedItemId) {
      for (const it of pendingItems) {
        try {
          const itemSku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
          if (itemSku && stripZeros(itemSku) === skuBipadoStripped) {
            matchedItemId = it.id;
            matchedRefCode = it.refCode;
            break;
          }
        } catch { /* segue */ }
      }
    }

    if (!matchedItemId) {
      // LOG DETALHADO pra debug — quando bipe não acha, manda TUDO pro Railway log
      this.logger.error(
        `[scanItem] FALHA shipment=${shipment.code} skuBipado=${skuBipado} skuNormalizado=${skuNormalizado} skuStripped=${skuBipadoStripped}`,
      );
      this.logger.error(
        `[scanItem] info Wincred: ${info ? JSON.stringify({ref: info.ref, cor: info.cor, tamanho: info.tamanho, codigo: info.codigo}) : 'NULL'}`,
      );
      this.logger.error(
        `[scanItem] items pendentes (${pendingItems.length}): ${pendingItems.map((it) => `${it.refCode}/${it.cor}/${it.tamanho}[codBip=${it.codigoBipado || '-'}]`).join('; ')}`,
      );
      const cached = this.skuCache.get(shipment.id);
      if (cached) {
        this.logger.error(
          `[scanItem] cache (${cached.skuMap.size} chaves): ${Array.from(cached.skuMap.entries()).slice(0, 10).map(([k, v]) => `${k}=>[${v}]`).join(' | ')}`,
        );
      } else {
        this.logger.error(`[scanItem] cache VAZIO`);
      }
      throw new BadRequestException(
        `SKU ${skuBipado} nao pertence a essa remessa (ou ja foi bipado). ` +
          (info?.ref ? `Resolvido como ${info.ref}/${info.cor || ''}/${info.tamanho || ''}.` : 'SKU nao encontrado no Wincred.'),
      );
    }

    // Salva codigoBipado junto com status — economiza re-resolucao na finalizacao
    await this.prisma.transferOrder.update({
      where: { id: matchedItemId },
      data: {
        realignmentStatus: 'received',
        realignmentReceivedAt: new Date(),
        realignmentReceivedByUserId: input.userId ?? null,
        codigoBipado: skuNormalizado,
      } as any,
    });

    return { ok: true, transferOrderId: matchedItemId, refCode: matchedRefCode };
  }

  /**
   * Marca um item da remessa como FALTANTE (extraviada na remessa).
   * Não dá entrada Giga e CANCELA a obrigação financeira correspondente.
   */
  async markItemMissing(input: {
    shipmentId: string;
    transferOrderId: string;
    storeId: string;
    note?: string;
    userId?: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferOrderId },
      select: { id: true, shipmentId: true, realignmentStatus: true } as any,
    });
    if (!order) throw new NotFoundException('Item não encontrado');
    const o = order as any;
    if (o.shipmentId !== input.shipmentId)
      throw new BadRequestException('Item não pertence a essa remessa');
    if (o.realignmentStatus === 'received')
      throw new BadRequestException('Item já foi recebido — não pode marcar como faltante');

    await this.prisma.transferOrder.update({
      where: { id: o.id },
      data: {
        realignmentStatus: 'missing',
        realignmentMissingAt: new Date(),
        realignmentMissingNote: input.note?.trim() || null,
        realignmentReceivedByUserId: input.userId ?? null,
      } as any,
    });

    // Cancela obrigação financeira correspondente automaticamente
    try {
      await (this.prisma as any).interStoreObligation.updateMany({
        where: { transferOrderId: o.id, status: { in: ['pending', 'closed'] } },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: 'Item faltante no recebimento da remessa',
        },
      });
    } catch (e) {
      this.logger.warn(`[shipment] falha cancelando obrigação de item missing: ${(e as Error).message}`);
    }

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — visão geral (matriz)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista TODAS as remessas com filtros opcionais (uso admin).
   * Inclui contagem de itens (total, recebidos, faltantes) já calculada
   * pra UI mostrar progresso sem precisar de N+1 queries no frontend.
   *
   * Filtros:
   *   - status: open | in_transit | received (opcional)
   *   - fromStoreCode (opcional)
   *   - toStoreCode (opcional)
   *   - search: substring no code da remessa (opcional)
   *   - daysAgo: filtra remessas abertas/enviadas nos últimos N dias (default 30)
   */
  // ═══════════════════════════════════════════════════════════════════════
  // REPROCESSAMENTO DE ESTOQUE — remessas fechadas que NÃO baixaram Giga
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Lista remessas FECHADAS recentes pra reprocessamento manual de estoque.
   * Inclui TODAS as in_transit/received do periodo — admin escolhe quais
   * reprocessar baseado no problema observado.
   *
   * O campo stockDecreasedAt eh exibido (se existir na migration); admin
   * usa pra saber se ja foi conciliada. Quando null, mostra alerta vermelho.
   */
  async listShipmentsNeedingStockReprocess(daysAgo: number = 30, forceAll: boolean = false) {
    // Estratégia robusta via RAW SQL — NÃO depende de stock_decreased_at /
    // stock_increased_at existirem (caso migration nao tenha rodado).
    // Filtra por opened_at (sempre presente) ao invés de sent_at (pode ser null).
    // Tenta enriquecer com os 2 campos novos via segundo query tolerante.

    let rows: any[] = [];
    try {
      // Query base — usa SOMENTE colunas que sempre existem
      const sql = `
        SELECT id, code, from_store_code, from_store_name, to_store_code, to_store_name,
               status, opened_at, sent_at, received_at, total_items, total_qty,
               received_qty, missing_qty
        FROM realignment_shipments
        WHERE status IN ('in_transit', 'received')
          AND opened_at >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY COALESCE(sent_at, opened_at) DESC
        LIMIT 500
      `;
      rows = await (this.prisma as any).$queryRawUnsafe(sql, daysAgo);
      this.logger.log(`[needs-reprocess] daysAgo=${daysAgo} forceAll=${forceAll} → ${rows.length} remessa(s) base`);
    } catch (e: any) {
      this.logger.error(`[needs-reprocess] RAW query falhou: ${e?.message}`);
      return [];
    }

    // Tenta carregar os marcadores stock_decreased_at / stock_increased_at
    // num segundo query. Se a coluna NÃO existir (migration pendente), seta tudo null.
    const markers = new Map<string, { stockDecreasedAt: Date | null; stockIncreasedAt: Date | null }>();
    try {
      const ids = rows.map((r: any) => r.id);
      if (ids.length) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const sql2 = `
          SELECT id, stock_decreased_at, stock_increased_at
          FROM realignment_shipments
          WHERE id IN (${placeholders})
        `;
        const mr: any[] = await (this.prisma as any).$queryRawUnsafe(sql2, ...ids);
        for (const m of mr) {
          markers.set(m.id, {
            stockDecreasedAt: m.stock_decreased_at || null,
            stockIncreasedAt: m.stock_increased_at || null,
          });
        }
      }
    } catch (e: any) {
      this.logger.warn(`[needs-reprocess] markers query falhou (migration pendente?): ${e?.message}`);
    }

    const result = await Promise.all(
      rows.map(async (s: any) => {
        const cnt = await this.prisma.transferOrder.count({
          where: { shipmentId: s.id } as any,
        });
        const mk = markers.get(s.id) || { stockDecreasedAt: null, stockIncreasedAt: null };
        const needsDecrease = !mk.stockDecreasedAt;
        const needsIncrease = s.status === 'received' && !mk.stockIncreasedAt;
        return {
          id: s.id,
          code: s.code,
          fromStoreCode: s.from_store_code,
          fromStoreName: s.from_store_name,
          toStoreCode: s.to_store_code,
          toStoreName: s.to_store_name,
          status: s.status,
          openedAt: s.opened_at,
          sentAt: s.sent_at,
          receivedAt: s.received_at,
          totalItems: s.total_items,
          totalQty: s.total_qty,
          receivedQty: s.received_qty,
          missingQty: s.missing_qty,
          stockDecreasedAt: mk.stockDecreasedAt,
          stockIncreasedAt: mk.stockIncreasedAt,
          totalItemsLive: cnt,
          needsDecrease,
          needsIncrease,
        };
      }),
    );

    // Se forceAll=true → retorna TUDO (admin pode forçar baixa em qualquer).
    // Caso contrario → filtra só quem PRECISA de algo (needsDecrease OU needsIncrease).
    const filtered = forceAll
      ? result
      : result.filter((r) => r.needsDecrease || r.needsIncrease);
    this.logger.log(`[needs-reprocess] retornando ${filtered.length} de ${result.length} (forceAll=${forceAll})`);
    return filtered;
  }

  /**
   * Reprocessa o AUMENTO de estoque Giga no destino pra uma remessa
   * recebida (status='received') que nao teve increaseStock aplicado.
   * Idempotente: recusa se ja tem stockIncreasedAt (a menos que force=true).
   *
   * Aplica apenas pros items que foram RECEBIDOS (realignmentStatus='received')
   * — os 'missing' ficam de fora (vendedora ja marcou como faltante).
   */
  async reprocessStockIncreaseForShipment(input: { shipmentId: string; force?: boolean; userId?: string }) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa nao encontrada');
    if (shipment.status !== 'received') {
      throw new BadRequestException(
        `Remessa esta com status=${shipment.status} — so reprocessa aumento em remessas com status=received`,
      );
    }
    if (shipment.stockIncreasedAt && !input.force) {
      throw new BadRequestException(
        `Remessa ${shipment.code} ja teve aumento Giga destino em ${new Date(shipment.stockIncreasedAt).toLocaleString('pt-BR')}. ` +
        `Use force=true se TEM CERTEZA que precisa reaplicar (cuidado: vai duplicar entrada).`,
      );
    }

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id, realignmentStatus: 'received' } as any,
      select: { id: true, refCode: true, codigoBipado: true, cor: true, tamanho: true, qtyOrigem: true } as any,
    });
    if (!items.length) {
      throw new BadRequestException('Remessa sem itens recebidos — nada pra reprocessar');
    }

    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(`[reprocess-increase] batchFind falhou: ${(e as Error).message}`);
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    const stockItems: Array<{ sku: string; qty: number; storeCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      let sku: string | null = it.codigoBipado || null;
      if (!sku) sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
      if (!sku) {
        try { sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho); } catch {}
      }
      if (!sku) {
        unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
        continue;
      }
      stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.toStoreCode });
    }

    if (stockItems.length === 0) {
      throw new BadRequestException(
        `Nenhum SKU resolvido. Unresolved: ${unresolved.map((u) => `${u.refCode}/${u.cor}/${u.tamanho}`).join(', ')}`,
      );
    }

    const result = await this.erp.increaseStock(stockItems);
    const appliedCount = result.applied?.length || 0;

    this.logger.log(
      `[reprocess-increase] ${shipment.code} (${shipment.fromStoreCode}->${shipment.toStoreCode}): ` +
      `${stockItems.length} SKUs solicitados, ${appliedCount} aplicados por user=${input.userId || 'unknown'}`,
    );

    if (!result.success) {
      throw new BadRequestException(`increaseStock falhou: ${result.error}`);
    }
    if (appliedCount === 0) {
      throw new BadRequestException(
        `increaseStock retornou success mas 0 SKUs aplicados. Possivel mismatch de storeCode "${shipment.toStoreCode}" com formato LOJA do Giga.`,
      );
    }

    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: { stockIncreasedAt: new Date() } as any,
    });

    return {
      ok: true,
      code: shipment.code,
      itemsTotal: items.length,
      stockItemsAttempted: stockItems.length,
      stockItemsApplied: appliedCount,
      unresolved: unresolved.length,
      message: `Entrada Giga reaplicada em ${shipment.toStoreCode}: ${appliedCount} SKUs.`,
    };
  }

  /**
   * Reprocessa a baixa de estoque Giga origem pra uma remessa específica.
   * Idempotente: se já tem stockDecreasedAt setado, recusa (a menos que force=true).
   *
   * Útil pra consertar remessas tipo "São José → Campinas" onde o decreaseStock
   * silenciosamente pulou (skipNotFound). Reaplica a baixa pelos itens da
   * remessa, atualiza stockDecreasedAt no sucesso.
   */
  /**
   * Lista TODAS as remessas de uma loja origem (opcionalmente filtrando por
   * loja destino) nos últimos N dias. RAW SQL — não depende de
   * stock_decreased_at existir. Pra rotina rápida "ver tudo que saiu de
   * SJOSE essa semana e baixar Giga".
   */
  async listShipmentsByRoute(input: {
    fromStoreCode: string;
    toStoreCode?: string | null;
    daysAgo: number;
  }) {
    const days = Math.max(1, Math.min(180, input.daysAgo || 7));
    let rows: any[] = [];
    try {
      const sql = `
        SELECT id, code, from_store_code, from_store_name, to_store_code, to_store_name,
               status, opened_at, sent_at, received_at, total_items, total_qty
        FROM realignment_shipments
        WHERE from_store_code = $1
          AND status IN ('in_transit', 'received')
          AND opened_at >= NOW() - ($2::int * INTERVAL '1 day')
          ${input.toStoreCode ? 'AND to_store_code = $3' : ''}
        ORDER BY COALESCE(sent_at, opened_at) DESC
        LIMIT 500
      `;
      const params: any[] = [input.fromStoreCode, days];
      if (input.toStoreCode) params.push(input.toStoreCode);
      rows = await (this.prisma as any).$queryRawUnsafe(sql, ...params);
    } catch (e: any) {
      this.logger.error(`[by-route] RAW falhou: ${e?.message}`);
      return [];
    }

    // Tenta enriquecer com marcador (tolerante)
    const markers = new Map<string, Date | null>();
    try {
      const ids = rows.map((r: any) => r.id);
      if (ids.length) {
        const ph = ids.map((_, i) => `$${i + 1}`).join(',');
        const mr: any[] = await (this.prisma as any).$queryRawUnsafe(
          `SELECT id, stock_decreased_at FROM realignment_shipments WHERE id IN (${ph})`,
          ...ids,
        );
        for (const m of mr) markers.set(m.id, m.stock_decreased_at || null);
      }
    } catch (e: any) {
      this.logger.warn(`[by-route] markers query falhou: ${e?.message}`);
    }

    return Promise.all(
      rows.map(async (s: any) => {
        const cnt = await this.prisma.transferOrder.count({ where: { shipmentId: s.id } as any });
        const stockDecreasedAt = markers.get(s.id) || null;
        return {
          id: s.id,
          code: s.code,
          fromStoreCode: s.from_store_code,
          fromStoreName: s.from_store_name,
          toStoreCode: s.to_store_code,
          toStoreName: s.to_store_name,
          status: s.status,
          openedAt: s.opened_at,
          sentAt: s.sent_at,
          receivedAt: s.received_at,
          totalItems: s.total_items,
          totalQty: s.total_qty,
          totalItemsLive: cnt,
          stockDecreasedAt,
          alreadyDecreased: !!stockDecreasedAt,
        };
      }),
    );
  }

  async reprocessStockForShipment(input: { shipmentId: string; force?: boolean; userId?: string }) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.status === 'open') {
      throw new BadRequestException('Remessa ainda aberta — use o fluxo normal de fechamento');
    }
    if (shipment.stockDecreasedAt && !input.force) {
      throw new BadRequestException(
        `Remessa ${shipment.code} já teve baixa Giga em ${new Date(shipment.stockDecreasedAt).toLocaleString('pt-BR')}. ` +
        `Use force=true se TEM CERTEZA que precisa reaplicar (cuidado: vai duplicar baixa).`,
      );
    }

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      select: { id: true, refCode: true, codigoBipado: true, cor: true, tamanho: true, qtyOrigem: true } as any,
    });
    if (!items.length) {
      throw new BadRequestException('Remessa sem items — nada pra reprocessar');
    }

    // Resolve SKU (igual closeAndSend) — usa codigoBipado direto, batch pro resto
    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(`[reprocess] batchFind falhou: ${(e as Error).message}`);
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      let sku: string | null = it.codigoBipado || null;
      if (!sku) sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
      if (!sku) {
        try { sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho); } catch {}
      }
      if (!sku) {
        unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
        continue;
      }
      stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.fromStoreCode, refCode: it.refCode });
    }

    if (stockItems.length === 0) {
      throw new BadRequestException(
        `Nenhum SKU resolvido pra reprocessar. Items unresolved: ${unresolved.map((u) => `${u.refCode}/${u.cor}/${u.tamanho}`).join(', ')}`,
      );
    }

    // Aplica baixa
    const result = await this.erp.decreaseStock(
      stockItems.map((s) => ({ sku: s.sku, qty: s.qty, storeCode: s.storeCode })),
      { allowNegative: true, skipNotFound: true },
    );
    const appliedCount = result.applied?.length || 0;

    this.logger.log(
      `[reprocess] ${shipment.code} (${shipment.fromStoreCode}→${shipment.toStoreCode}): ` +
      `${stockItems.length} SKUs solicitados, ${appliedCount} aplicados por user=${input.userId || 'unknown'}`,
    );

    if (!result.success) {
      throw new BadRequestException(
        `decreaseStock falhou: ${result.error}. Estoque não reaplicado.`,
      );
    }

    if (appliedCount === 0) {
      throw new BadRequestException(
        `decreaseStock retornou success mas 0 SKUs aplicados. Possível mismatch de storeCode "${shipment.fromStoreCode}" com formato LOJA do Giga (pode ser "01", "02", etc). Verifique no Giga e ajuste o mapping.`,
      );
    }

    // Marca stockDecreasedAt
    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: { stockDecreasedAt: new Date() } as any,
    });

    return {
      ok: true,
      code: shipment.code,
      itemsTotal: items.length,
      stockItemsAttempted: stockItems.length,
      stockItemsApplied: appliedCount,
      unresolved: unresolved.length,
      message: `Baixa Giga reaplicada em ${shipment.fromStoreCode}: ${appliedCount} SKUs.`,
    };
  }

  /** Define o meio de transporte da remessa (botão CORREIOS/PRÓPRIO na tela). */
  async setTransportMode(shipmentId: string, mode: string) {
    if (mode !== 'correios' && mode !== 'proprio') {
      throw new BadRequestException("Transporte deve ser 'correios' ou 'proprio'.");
    }
    const s = await (this.prisma as any).realignmentShipment.update({
      where: { id: shipmentId },
      data: { transportMode: mode },
    });
    return { ok: true, transportMode: s.transportMode };
  }

  async listAllShipmentsAdmin(input: {
    status?: string;
    fromStoreCode?: string;
    toStoreCode?: string;
    search?: string;
    daysAgo?: number;
    /** Período LIVRE De/Até em YYYY-MM-DD (dono 29/07). Sem de/ate/daysAgo = TUDO. */
    de?: string;
    ate?: string;
  }) {
    const where: any = {};
    if (input.status) where.status = input.status;
    if (input.fromStoreCode) where.fromStoreCode = input.fromStoreCode;
    if (input.toStoreCode) where.toStoreCode = input.toStoreCode;
    if (input.search) where.code = { contains: input.search.trim(), mode: 'insensitive' };

    // Período: De/Até livres têm prioridade; daysAgo segue como legado; sem
    // nenhum dos dois = SEM recorte (todo o histórico, limitado pelo take).
    const isoDia = /^\d{4}-\d{2}-\d{2}$/;
    const periodo: any = {};
    if (input.de && isoDia.test(input.de)) periodo.gte = new Date(`${input.de}T00:00:00-03:00`);
    if (input.ate && isoDia.test(input.ate)) periodo.lte = new Date(`${input.ate}T23:59:59.999-03:00`);
    if (periodo.gte || periodo.lte) {
      where.openedAt = periodo;
    } else if (Number.isFinite(input.daysAgo) && (input.daysAgo as number) > 0) {
      const since = new Date();
      since.setDate(since.getDate() - (input.daysAgo as number));
      where.openedAt = { gte: since };
    }

    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where,
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
      take: 200,
    });

    // Conta itens por shipment via groupBy (1 query só)
    const ids = shipments.map((s: any) => s.id);
    if (ids.length === 0) return [];

    const itemsRaw = await this.prisma.transferOrder.findMany({
      where: { shipmentId: { in: ids } } as any,
      select: { shipmentId: true, realignmentStatus: true, qtyOrigem: true } as any,
    });

    const summary = new Map<string, { totalItems: number; totalQty: number; received: number; missing: number; sent: number }>();
    for (const s of shipments) summary.set(s.id, { totalItems: 0, totalQty: 0, received: 0, missing: 0, sent: 0 });
    for (const it of itemsRaw as any[]) {
      const agg = summary.get(it.shipmentId);
      if (!agg) continue;
      agg.totalItems += 1;
      agg.totalQty += it.qtyOrigem || 1;
      if (it.realignmentStatus === 'received') agg.received += 1;
      else if (it.realignmentStatus === 'missing') agg.missing += 1;
      else if (it.realignmentStatus === 'sent') agg.sent += 1;
    }

    // NF-e AUTORIZADA por remessa (selo "nota emitida" na lista, dono 24/07).
    const nfeDocs = await (this.prisma as any).nfeDoc.findMany({
      where: { shipmentId: { in: ids }, status: 'authorized' },
      select: { shipmentId: true, numero: true, serie: true },
    });
    const nfeByShipment = new Map<string, { numero: number; serie: string }>();
    for (const d of nfeDocs as any[]) {
      if (d.shipmentId && !nfeByShipment.has(d.shipmentId)) {
        nfeByShipment.set(d.shipmentId, { numero: d.numero, serie: d.serie });
      }
    }

    return shipments.map((s: any) => {
      const agg = summary.get(s.id) || { totalItems: 0, totalQty: 0, received: 0, missing: 0, sent: 0 };
      // Tempo em trânsito (em horas) pra alertar remessas paradas
      let hoursInTransit: number | null = null;
      if (s.status === 'in_transit' && s.sentAt) {
        hoursInTransit = (Date.now() - new Date(s.sentAt).getTime()) / 1000 / 60 / 60;
      }
      const nfe = nfeByShipment.get(s.id);
      return {
        ...s,
        totalItemsLive: agg.totalItems,
        totalQtyLive: agg.totalQty,
        receivedCount: agg.received,
        missingCount: agg.missing,
        pendingScanCount: agg.sent,
        hoursInTransit,
        nfeEmitida: !!nfe,
        nfeNumero: nfe?.numero ?? null,
        nfeSerie: nfe?.serie ?? null,
        // Transporte EFETIVO: escolhido (transportMode) ou regra automática
        // (até 10 peças → correios; acima → próprio). Dono 29/07.
        transportEfetivo: (s.transportMode === 'correios' || s.transportMode === 'proprio')
          ? s.transportMode
          : (agg.totalQty <= 10 ? 'correios' : 'proprio'),
        transportManual: s.transportMode === 'correios' || s.transportMode === 'proprio',
      };
    });
  }

  /**
   * Detalhe de uma remessa qualquer (uso admin — sem filtro de loja).
   */
  async getShipmentDetailAdmin(shipmentId: string) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId } as any,
      orderBy: [{ refCode: 'asc' }],
      select: {
        id: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        descricao: true,
        realignmentStatus: true,
        realignmentReceivedAt: true,
        realignmentMissingAt: true,
        realignmentMissingNote: true,
      } as any,
    });
    return { ...shipment, items };
  }

  /**
   * KPIs agregados (cards do topo da tela admin).
   */
  async getShipmentsKPIs() {
    const all = await (this.prisma as any).realignmentShipment.findMany({
      where: { openedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      select: { id: true, status: true, sentAt: true, totalQty: true } as any,
    });
    const open = all.filter((s: any) => s.status === 'open').length;
    const inTransit = all.filter((s: any) => s.status === 'in_transit').length;
    const received = all.filter((s: any) => s.status === 'received').length;
    // Remessas paradas (in_transit há mais de 48h)
    const stuck = all.filter((s: any) => {
      if (s.status !== 'in_transit' || !s.sentAt) return false;
      const hours = (Date.now() - new Date(s.sentAt).getTime()) / 1000 / 60 / 60;
      return hours > 48;
    }).length;
    return { open, inTransit, received, stuck, total90d: all.length };
  }

  /**
   * "Dar entrada SEM bipar" — marca TODOS os itens pendentes da remessa como
   * recebidos (sem conferência peça a peça) e finaliza a entrada (estoque Giga).
   *
   * Usado quando a loja JÁ guardou a mercadoria e esqueceu de bipar no
   * recebimento. Bypassa a conferência física — confia que tudo chegou. Mantém o
   * codigoBipado que veio da ORIGEM (resolvido no bipe de envio), então a entrada
   * Giga funciona normal. Loga warning pra auditoria.
   */
  async receberTudoSemBipar(input: { shipmentId: string; storeId: string; userId?: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.toStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'in_transit')
      throw new BadRequestException(`Remessa não está em trânsito (status=${shipment.status})`);

    // Marca TODOS os itens ainda pendentes (sent) como recebidos. Mantém o
    // codigoBipado salvo na origem — a entrada Giga (confirmReceived) usa ele.
    const r = await this.prisma.transferOrder.updateMany({
      where: {
        shipmentId: shipment.id,
        realignmentStatus: { notIn: ['received', 'missing'] },
      } as any,
      data: {
        realignmentStatus: 'received',
        realignmentReceivedAt: new Date(),
        realignmentReceivedByUserId: input.userId ?? null,
      } as any,
    });
    this.logger.warn(
      `[shipment] ${shipment.code}: ENTRADA SEM BIPAR — ${r.count} item(ns) marcados 'received' SEM conferência (user=${input.userId || '-'})`,
    );

    // Finaliza: aplica entrada Giga de TODOS os recebidos + fecha a remessa.
    return this.confirmReceived(input);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MUTIRÃO DA MATRIZ — caixa parada em trânsito
  //
  // A remessa baixa o estoque da ORIGEM ao fechar e só entra no DESTINO
  // quando alguém clica "dar entrada". Entre um e outro a peça não está no
  // estoque de NINGUÉM: some da Consulta e não vende no site. Medição de
  // 11/08: 198 remessas / 1.057 peças nesse limbo, 6 delas com mais de 30
  // dias (a mais antiga de 15/05) — contra um ciclo normal de 4,1 dias.
  //
  // A loja destino sempre pôde resolver (tela Receber), mas quando ela não
  // resolve não existia ninguém acima dela pra fechar o ciclo. Estes três
  // métodos dão isso à matriz. Os dois de AÇÃO delegam pros mesmos métodos
  // da loja — mesmo efeito no estoque, mesmos sockets, mesmas travas — só
  // resolvendo a loja pela PRÓPRIA REMESSA em vez do JWT de quem clica.
  // ═══════════════════════════════════════════════════════════════════════

  /** Caixas em trânsito paradas há mais de `minDias` (rede toda). */
  async listStuckInTransit(minDias = 3) {
    const cutoff = new Date(Date.now() - minDias * 24 * 60 * 60 * 1000);
    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where: {
        status: 'in_transit',
        // sentAt é o marco do despacho; caixa antiga pode não ter (fechada
        // antes do campo existir) — aí vale a abertura.
        OR: [{ sentAt: { lte: cutoff } }, { sentAt: null, openedAt: { lte: cutoff } }],
      },
      orderBy: [{ sentAt: 'asc' }, { openedAt: 'asc' }],
      take: 300,
    });
    if (!shipments.length) return [];

    const ids = shipments.map((s: any) => s.id);
    const pendentes = await this.prisma.transferOrder.groupBy({
      by: ['shipmentId'],
      where: {
        shipmentId: { in: ids },
        realignmentStatus: { notIn: ['cancelled', 'received', 'missing'] },
      } as any,
      _count: { _all: true },
      _sum: { qtyOrigem: true },
    } as any);
    const porRemessa = new Map<string, { itens: number; pecas: number }>(
      (pendentes as any[]).map((p) => [
        p.shipmentId,
        { itens: p._count?._all ?? 0, pecas: Number(p._sum?.qtyOrigem ?? 0) },
      ]),
    );

    return shipments.map((s: any) => {
      const base = s.sentAt ?? s.openedAt;
      const p = porRemessa.get(s.id) ?? { itens: 0, pecas: 0 };
      return {
        id: s.id,
        code: s.code,
        fromStoreCode: s.fromStoreCode,
        fromStoreName: s.fromStoreName,
        toStoreCode: s.toStoreCode,
        toStoreName: s.toStoreName,
        sentAt: s.sentAt,
        openedAt: s.openedAt,
        diasParada: base ? Math.floor((Date.now() - new Date(base).getTime()) / 86400000) : null,
        itensPendentes: p.itens,
        pecasPendentes: p.pecas,
        trackingCode: s.trackingCode ?? null,
        envioGeneratedAt: s.envioGeneratedAt ?? null,
      };
    });
  }

  /** "Chegou": matriz dá a entrada pela loja destino (+estoque no destino). */
  async adminReceberTudo(shipmentId: string, userId?: string) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: shipmentId },
      select: { toStoreCode: true, code: true } as any,
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    const store = await this.prisma.store.findUnique({
      where: { code: (shipment as any).toStoreCode },
      select: { id: true } as any,
    });
    if (!store) {
      throw new BadRequestException(
        `Loja destino ${(shipment as any).toStoreCode} não encontrada no cadastro`,
      );
    }
    this.logger.warn(
      `[shipment] ${(shipment as any).code}: ENTRADA PELA MATRIZ (mutirão) — user=${userId || '-'}`,
    );
    return this.receberTudoSemBipar({ shipmentId, storeId: (store as any).id, userId });
  }

  /** "Nunca saiu": matriz devolve a caixa pra origem (peças voltam pra fila). */
  async adminReabrir(
    shipmentId: string,
    userId?: string,
    opts?: { descartarEtiqueta?: boolean; cancelarNota?: boolean; justificativa?: string },
  ) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: shipmentId },
      select: { fromStoreCode: true, code: true } as any,
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    const store = await this.prisma.store.findUnique({
      where: { code: (shipment as any).fromStoreCode },
      select: { id: true } as any,
    });
    if (!store) {
      throw new BadRequestException(
        `Loja origem ${(shipment as any).fromStoreCode} não encontrada no cadastro`,
      );
    }
    this.logger.warn(
      `[shipment] ${(shipment as any).code}: REABERTA PELA MATRIZ (mutirão) — user=${userId || '-'}`,
    );
    return this.reopenShipment({
      shipmentId,
      storeId: (store as any).id,
      userId,
      descartarEtiqueta: opts?.descartarEtiqueta ?? true,
      cancelarNota: opts?.cancelarNota ?? false,
      justificativa: opts?.justificativa,
    });
  }

  /**
   * "Dar Entrada" — finaliza o recebimento da remessa.
   *
   * Pré-condição: TODOS itens da remessa devem ter status final
   * (`received` ou `missing`). Itens ainda `sent` bloqueiam.
   *
   * Faz:
   *   1. Resolve SKU dos itens `received`
   *   2. Chama erp.increaseStock em batch (transação ACID)
   *   3. Marca shipment.status = 'received'
   *   4. Emite socket pra retaguarda
   */
  async confirmReceived(input: { shipmentId: string; storeId: string; userId?: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.toStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'in_transit')
      throw new BadRequestException(`Remessa não está em trânsito (status=${shipment.status})`);

    // Verifica que TODOS itens estão em status final.
    // ⚡ Inclui codigoBipado pra evitar refazer lookup no Giga na entrada
    // (codigoBipado já foi resolvido e salvo durante o bipe).
    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      select: {
        id: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        realignmentStatus: true,
        codigoBipado: true,
      } as any,
    });

    const pendingItems = (items as any[]).filter(
      (i) => i.realignmentStatus !== 'received' && i.realignmentStatus !== 'missing',
    );
    if (pendingItems.length > 0) {
      throw new BadRequestException(
        `Ainda há ${pendingItems.length} item(ns) sem conferir. ` +
          `Bipe todos ou marque como faltante antes de dar entrada.`,
      );
    }

    const receivedItems = (items as any[]).filter((i) => i.realignmentStatus === 'received');
    const missingItems = (items as any[]).filter((i) => i.realignmentStatus === 'missing');

    // ⚡ OTIMIZADO: usa codigoBipado salvo no scan (CODIGO real do Giga já
    //    resolvido durante a bipagem). Evita 1 query por peça no Wincred —
    //    pra remessa de 60 peças economiza ~6-10s. Fallback PARALELO pros
    //    raros casos sem codigoBipado (itens antigos ou marcados sem bipe).
    const stockItems: Array<{ sku: string; qty: number; storeCode: string }> = [];
    const naoResolvidos: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    const itensSemCodigo: any[] = [];
    for (const it of receivedItems as any[]) {
      if (it.codigoBipado) {
        stockItems.push({ sku: String(it.codigoBipado), qty: it.qtyOrigem || 1, storeCode: shipment.toStoreCode });
      } else {
        itensSemCodigo.push(it);
      }
    }
    if (itensSemCodigo.length > 0) {
      const results = await Promise.all(
        itensSemCodigo.map(async (it) => {
          try {
            const sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
            return { it, sku, err: null as string | null };
          } catch (e) {
            return { it, sku: null, err: (e as Error).message };
          }
        }),
      );
      for (const r of results) {
        if (r.sku) {
          stockItems.push({ sku: r.sku, qty: r.it.qtyOrigem || 1, storeCode: shipment.toStoreCode });
        } else {
          naoResolvidos.push({ refCode: r.it.refCode, cor: r.it.cor, tamanho: r.it.tamanho });
          this.logger.warn(`[shipment] confirmReceived: não resolveu SKU pra ${r.it.refCode}/${r.it.cor}/${r.it.tamanho}${r.err ? ` (${r.err})` : ''}`);
        }
      }
    }
    // Se algum item não resolveu, NÃO finaliza — força admin a corrigir o cadastro
    if (naoResolvidos.length > 0) {
      throw new BadRequestException(
        `Não consegui resolver SKU pra ${naoResolvidos.length} item(ns) (verifique cadastro Giga): ` +
          naoResolvidos
            .map((u) => `${u.refCode} ${u.cor || ''}/${u.tamanho || ''}`)
            .join(', '),
      );
    }

    let increaseResult: any = { success: true, applied: [] };
    if (stockItems.length > 0) {
      increaseResult = await this.erp.increaseStock(stockItems);
      if (!increaseResult.success) {
        throw new BadRequestException(
          `Falha ao dar entrada Giga: ${increaseResult.error}. Remessa NÃO foi finalizada.`,
        );
      }
    }
    const appliedIncreaseCount = increaseResult.applied?.length || 0;
    if (stockItems.length > 0 && appliedIncreaseCount === 0) {
      this.logger.error(
        `[confirmReceived] ${shipment.code}: increaseStock retornou success mas 0 SKUs aplicados! ` +
        `Possivel mismatch de storeCode. toStoreCode=${shipment.toStoreCode}. ` +
        `Use POST /realignment/shipments/admin/:id/reprocess-stock-increase pra reaplicar.`,
      );
    }

    // Atualiza shipment
    const now = new Date();
    const receivedQty = receivedItems.reduce((s, i: any) => s + (i.qtyOrigem || 1), 0);
    const missingQty = missingItems.reduce((s, i: any) => s + (i.qtyOrigem || 1), 0);

    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: {
        status: 'received',
        receivedAt: now,
        receivedByUserId: input.userId ?? null,
        receivedQty,
        missingQty,
        // So marca se realmente aplicou — pra reprocess saber quem precisa
        stockIncreasedAt: appliedIncreaseCount > 0 ? now : null,
      } as any,
    });

    this.invalidateSkuCache(shipment.id);

    this.logger.log(
      `[shipment] ${shipment.code} recebida: ${receivedItems.length} itens entrada (Giga aplicou ${increaseResult.applied?.length || 0}), ` +
        `${missingItems.length} faltantes`,
    );

    // Emite socket pra retaguarda atualizar dashboards
    try {
      this.gateway.emitToAdmins('shipment:received', {
        shipmentId: shipment.id,
        code: shipment.code,
        toStoreCode: shipment.toStoreCode,
        receivedItems: receivedItems.length,
        missingItems: missingItems.length,
      });
    } catch (e) {
      /* não bloqueia */
    }

    return {
      ok: true,
      code: shipment.code,
      receivedItems: receivedItems.length,
      missingItems: missingItems.length,
      gigaApplied: increaseResult.applied?.length || 0,
    };
  }
}
