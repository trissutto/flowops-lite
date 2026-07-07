import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RoutingEngine } from '../routing/routing.engine';
import { PagarmeService } from '../pagarme/pagarme.service';
import { PagbankService } from '../pagbank/pagbank.service';
import { ProductPhotosService } from '../product-photos/product-photos.service';
import { RealignmentPricingService } from '../realignment/realignment-pricing.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import type { StoreInput, StockEntry } from '../routing/types';

/**
 * LivePdvService — coração do módulo de Live Commerce operado pela apresentadora.
 *
 * Reusa a infra existente:
 *   - ErpService            → grade + estoque consolidado por loja + preço
 *   - RoutingEngine         → escolha automática da loja de origem (4 critérios)
 *   - PagarmeService        → PIX dinâmico com confirmação por webhook
 *   - ProductPhotosService  → foto principal do produto
 *   - RealtimeGateway       → eventos em tempo real (dashboard + painel da loja)
 *
 * Estoque: a reserva é contra o ESTOQUE REAL CONSOLIDADO (ERP) menos as
 * reservas ativas da própria live (reserved | paid | separating). Não toca o
 * Giga — quem baixa o Giga é a loja de origem no seu fluxo normal. A
 * transferência interna + obrigação intercompany (÷2,5) são geradas no DESPACHO.
 */
@Injectable()
export class LivePdvService {
  private readonly logger = new Logger(LivePdvService.name);
  private readonly DIVISOR_CUSTO = 2.5;
  /** Status que "seguram" estoque durante a live (contam contra disponibilidade). */
  private readonly COMMITTED = ['reserved', 'paid', 'separating'];
  /** Throttle da checagem AO VIVO no gateway por carrinho (anti-flood de polling). */
  private readonly lastLiveCheck = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly routing: RoutingEngine,
    private readonly pagarme: PagarmeService,
    private readonly pagbank: PagbankService,
    private readonly photos: ProductPhotosService,
    private readonly pricing: RealignmentPricingService,
    private readonly gateway: RealtimeGateway,
  ) {}

  // ─── helpers ──────────────────────────────────────────────────────────────
  private norm(s: any): string {
    return String(s ?? '').trim().toUpperCase();
  }
  private keyOf(ref: string, cor: any, tam: any): string {
    return `${this.norm(ref)}|${this.norm(cor)}|${this.norm(tam)}`;
  }

  // Preço por CODIGO — SÓ ESPELHO (giga_produto.vendaUn no Postgres). A Live NÃO
  // toca o Giga ao vivo (que trava quando o firewall derruba o IP do Railway).
  private async pricesWithMirror(codigos: string[]): Promise<Map<string, number>> {
    const uniq = Array.from(new Set(codigos.map((c) => String(c).trim()).filter(Boolean)));
    const out = new Map<string, number>();
    if (!uniq.length) return out;
    try {
      const rows = await (this.prisma as any).gigaProduto.findMany({
        where: { codigo: { in: uniq }, vendaUn: { gt: 0 } },
        select: { codigo: true, vendaUn: true },
      });
      for (const r of rows as any[]) {
        out.set(String(r.codigo).trim(), Number(r.vendaUn) || 0);
      }
    } catch {
      /* espelho indisponível */
    }
    return out;
  }

  // Preço por REF — SÓ ESPELHO, ref EXATO (usa índice; ref já vem canônico).
  private async refPriceWithMirror(ref: string): Promise<number> {
    try {
      const row = await (this.prisma as any).gigaProduto.findFirst({
        where: { ref, vendaUn: { gt: 0 } },
        orderBy: { vendaUn: 'desc' },
        select: { vendaUn: true },
      });
      if (row && Number(row.vendaUn) > 0) return Number(row.vendaUn);
    } catch {
      /* espelho indisponível */
    }
    return 0;
  }

  // Resolve as linhas do produto (REF/código/nome) — SÓ ESPELHO (giga_produto no
  // Postgres). Em CAMADAS pra usar os índices (@@index codigo/ref) e NÃO varrer a
  // tabela toda: código exato → ref exato/prefixo → (só se nada) insensitive/nome.
  private async resolveRowsWithMirror(q: string): Promise<{ rows: any[]; fromMirror: boolean }> {
    const mk = (rows: any[]) =>
      (rows as any[]).map((r) => ({
        CODIGO: r.codigo,
        REF: r.ref,
        DESCRICAOCOMPLETA: r.descricao,
        COR: r.cor,
        TAMANHO: r.tamanho,
      }));
    const find = (where: any, take = 1000) =>
      (this.prisma as any).gigaProduto.findMany({ where, take }).catch(() => []);

    // 1) Código exato (índice) — cobre bipar código/EAN.
    let rows = await find({ codigo: q });
    if (rows.length) return { rows: mk(rows), fromMirror: true };

    // 2) REF pelo índice: exato/prefixo em MAIÚSCULA (padrão Giga) e como digitado.
    const up = q.toUpperCase();
    rows = await find({
      OR: [{ ref: up }, { ref: q }, { ref: { startsWith: up } }, { ref: { startsWith: q } }],
    });
    if (rows.length) return { rows: mk(rows), fromMirror: true };

    // 3) Fallback (raro) — ref/nome case-insensitive (varredura). Só quando 1 e 2
    //    não acharam: busca por nome/descrição ou ref gravada em minúscula.
    if (q.length >= 2) {
      rows = await find(
        {
          OR: [
            { ref: { startsWith: q, mode: 'insensitive' } },
            { descricao: { contains: q, mode: 'insensitive' } },
          ],
        },
        300,
      );
    }
    return { rows: mk(rows), fromMirror: true };
  }

  // Estoque por loja — ESPELHO PRIMEIRO (giga_estoque no Postgres). Só encosta no
  // Giga ao vivo se o espelho não trouxer NADA pra nenhum código (produto novo
  // ainda não sincronizado). No caso comum, não toca o Giga → não trava.
  private async stockWithMirror(
    codigos: string[],
  ): Promise<{ detailed: Record<string, Array<{ storeCode: string; qty: number }>>; fromMirror: boolean }> {
    const uniq = Array.from(new Set(codigos.map((c) => String(c).trim()).filter(Boolean)));
    const detailed: Record<string, Array<{ storeCode: string; qty: number }>> = {};
    let fromMirror = false;
    if (uniq.length) {
      try {
        const rows = await (this.prisma as any).gigaEstoque.findMany({
          where: { codigo: { in: uniq }, estoque: { gt: 0 } },
          select: { codigo: true, loja: true, estoque: true },
        });
        for (const r of rows as any[]) {
          const c = String(r.codigo).trim();
          if (!detailed[c]) detailed[c] = [];
          detailed[c].push({ storeCode: String(r.loja).trim(), qty: Number(r.estoque) || 0 });
        }
        if ((rows as any[]).length) fromMirror = true;
      } catch {
        /* espelho indisponível */
      }
    }
    // SÓ ESPELHO — a Live não toca o Giga ao vivo.
    return { detailed, fromMirror };
  }

  private reaisToCents(v: number): number {
    return Math.round((Number(v) || 0) * 100);
  }
  private custoCents(priceCents: number): number {
    return Math.round(priceCents / this.DIVISOR_CUSTO);
  }

  private async storesMap(): Promise<Map<string, any>> {
    const stores = await (this.prisma as any).store.findMany({ where: { active: true } });
    return new Map<string, any>(stores.map((s: any) => [s.code, s]));
  }

  /**
   * Reservas ATIVAS por itemKey e por (itemKey, loja). Usado pra calcular
   * disponibilidade real durante a live (ERP − reservas em andamento).
   */
  private async committed(itemKeys: string[]): Promise<{
    byKey: Map<string, number>;
    byKeyStore: Map<string, number>;
  }> {
    const byKey = new Map<string, number>();
    const byKeyStore = new Map<string, number>();
    if (itemKeys.length === 0) return { byKey, byKeyStore };
    const rows = await (this.prisma as any).livePdvItem.findMany({
      where: { itemKey: { in: itemKeys }, status: { in: this.COMMITTED } },
      select: { itemKey: true, originStoreCode: true, qty: true },
    });
    for (const r of rows as any[]) {
      const q = r.qty || 0;
      byKey.set(r.itemKey, (byKey.get(r.itemKey) || 0) + q);
      const ks = `${r.itemKey}::${r.originStoreCode}`;
      byKeyStore.set(ks, (byKeyStore.get(ks) || 0) + q);
    }
    return { byKey, byKeyStore };
  }

  /**
   * Estoque por loja pra um item (REF+COR+TAM) — SÓ ESPELHO (giga_produto +
   * giga_estoque no Postgres). A reserva NÃO toca o Giga ao vivo. Agrega todos
   * os CODIGOs do item; retorna loja→qty e o melhor CODIGO (mais estoque).
   */
  private async erpStockByStoreForItem(
    refCode: string,
    cor: string | null,
    tam: string | null,
  ): Promise<{ byStore: Map<string, number>; codigos: string[]; bestCodigo: string | null }> {
    // ref EXATO (sem insensitive) → usa o índice @@index([ref]) do espelho.
    // O refCode já vem canônico da busca (é o ref gravado no espelho).
    const prods = await (this.prisma as any).gigaProduto
      .findMany({
        where: { ref: refCode },
        select: { codigo: true, cor: true, tamanho: true },
      })
      .catch(() => []);
    const matched = (prods as any[]).filter(
      (r) => this.norm(r.cor) === this.norm(cor) && this.norm(r.tamanho) === this.norm(tam),
    );
    const codigos = Array.from(
      new Set(matched.map((r) => String(r.codigo || '').trim()).filter(Boolean)),
    );
    const byStore = new Map<string, number>();
    if (codigos.length === 0) return { byStore, codigos, bestCodigo: null };
    // Estoque por loja do espelho, e por codigo pra achar o bestCodigo.
    const est = await (this.prisma as any).gigaEstoque
      .findMany({
        where: { codigo: { in: codigos }, estoque: { gt: 0 } },
        select: { codigo: true, loja: true, estoque: true },
      })
      .catch(() => []);
    const detailed: Record<string, Array<{ storeCode: string; qty: number }>> = {};
    for (const r of est as any[]) {
      const codigo = String(r.codigo).trim();
      if (!detailed[codigo]) detailed[codigo] = [];
      detailed[codigo].push({ storeCode: String(r.loja).trim(), qty: Number(r.estoque) || 0 });
    }
    for (const codigo of codigos) {
      const arr = detailed[codigo] || [];
      for (const e of arr) {
        byStore.set(e.storeCode, (byStore.get(e.storeCode) || 0) + (e.qty || 0));
      }
    }
    // bestCodigo = o de maior estoque consolidado
    let bestCodigo: string | null = null;
    let bestQty = -1;
    for (const codigo of codigos) {
      const total = (detailed[codigo] || []).reduce((s, e) => s + (e.qty || 0), 0);
      if (total > bestQty) {
        bestQty = total;
        bestCodigo = codigo;
      }
    }
    return { byStore, codigos, bestCodigo };
  }

  // ─── Sessões ────────────────────────────────────────────────────────────────
  async createSession(input: {
    title?: string;
    liveStoreCode?: string;
    reservationTtlMin?: number;
    userId?: string | null;
  }) {
    const code = input.liveStoreCode || (await this.defaultLiveStoreCode());
    const store = await (this.prisma as any).store.findUnique({ where: { code } });
    if (!store) throw new BadRequestException(`Loja da live (${code}) não encontrada`);
    // UMA LIVE ATIVA POR VEZ: encerra qualquer live ainda aberta antes de abrir
    // a nova. Os carrinhos ficam guardados na sessão encerrada (sessionId),
    // então não vazam pra live nova.
    await (this.prisma as any).livePdvSession.updateMany({
      where: { status: 'live' },
      data: { status: 'ended', endedAt: new Date() },
    });
    const session = await (this.prisma as any).livePdvSession.create({
      data: {
        title: input.title?.trim() || `Live ${new Date().toLocaleDateString('pt-BR')}`,
        status: 'live',
        liveStoreCode: store.code,
        liveStoreName: store.name,
        reservationTtlMin: Math.max(1, input.reservationTtlMin || 30),
        startedAt: new Date(),
        createdByUserId: input.userId || null,
      },
    });
    return session;
  }

  /** Loja da live padrão: procura "Anália Franco" pelo nome, senão a 1ª ativa. */
  private async defaultLiveStoreCode(): Promise<string> {
    const stores = await (this.prisma as any).store.findMany({ where: { active: true } });
    const analia = (stores as any[]).find((s) =>
      this.norm(s.name).includes('ANALIA') || this.norm(s.name).includes('ANÁLIA'),
    );
    if (analia) return analia.code;
    if (stores.length) return stores[0].code;
    throw new BadRequestException('Nenhuma loja ativa cadastrada');
  }

  async listSessions() {
    return (this.prisma as any).livePdvSession.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getSession(id: string) {
    const s = await (this.prisma as any).livePdvSession.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Sessão não encontrada');
    return s;
  }

  async endSession(id: string) {
    await this.getSession(id);
    return (this.prisma as any).livePdvSession.update({
      where: { id },
      data: { status: 'ended', endedAt: new Date() },
    });
  }

  // ─── Busca + Grade ──────────────────────────────────────────────────────────
  /**
   * Busca produto e devolve a grade com estoque consolidado + por loja
   * (já descontando reservas ativas da live).
   *
   * ATALHOS DA LEGENDA (04/07): se o termo bate com um atalho cadastrado na
   * legenda desta sessão ("01", "02"...), converte pra referência completa e
   * segue EXATAMENTE a mesma busca — 1 lookup indexado no Postgres (~ms),
   * o operador não percebe a conversão. `skipAtalho` é usado pela VALIDAÇÃO
   * da legenda (valida a referência em si, sem risco de recursão).
   */
  async searchGrade(term: string, sessionId?: string, opts?: { skipAtalho?: boolean }) {
    let q = (term || '').trim();
    if (!q) throw new BadRequestException('Informe referência, código, SKU ou nome');

    let viaAtalho: { atalho: string; refCode: string } | null = null;
    if (sessionId && !opts?.skipAtalho) {
      const key = this.normAtalho(q);
      // Tolerância de digitação: "1" acha o atalho "01" e vice-versa.
      const candidates = new Set<string>([key]);
      if (/^\d+$/.test(key)) {
        const semZeros = key.replace(/^0+/, '');
        if (semZeros) candidates.add(semZeros);
        candidates.add(key.padStart(2, '0'));
      }
      const at = await (this.prisma as any).livePdvAtalho.findFirst({
        where: { sessionId, atalho: { in: Array.from(candidates) } },
      });
      if (at) {
        viaAtalho = { atalho: at.atalho, refCode: at.refCode };
        q = String(at.refCode).trim();
      }
    }

    // 1) Resolve linhas do produto (REF/código/nome) COM FALLBACK no espelho
    // giga_produto quando o Giga ao vivo não responde.
    const resolved = await this.resolveRowsWithMirror(q);
    const rows = resolved.rows;
    if (!rows.length) return { found: false, term: q, viaAtalho, matchedRefs: [], exactMatch: false };

    // "JUNTAR POR PREFIXO" (decisão do dono, 06/07): variantes de cor cadastradas
    // com sufixo na REF (ex.: 900658 = OFF WHITE, 900658M = MOSTARDA) entram na
    // MESMA grade. Antes o código ficava só com a REF EXATA e a mostarda sumia.
    //
    // GUARD anti-explosão: só agrega as irmãs quando existe MATCH EXATO (a REF
    // base foi digitada inteira). Assim um prefixo curto ("900") — que não bate
    // exato com nenhuma REF — NÃO arrasta centenas de produtos pra grade no meio
    // da live; cai no comportamento antigo (1ª REF). Efeito colateral aceito pelo
    // dono: buscar "VLM-222" agora também traz "VLM-222EST" (estampado).
    const qn = this.norm(q);
    const exact = rows.filter((r) => this.norm(r.REF) === qn);
    const productRows = exact.length
      ? rows.filter((r) => this.norm(r.REF).startsWith(qn))
      : rows.filter((r) => this.norm(r.REF) === this.norm(rows[0].REF));
    // Metadados pra VALIDAÇÃO da legenda: quais REFs distintas o termo trouxe
    // e se houve match exato. Campos ADITIVOS — não mudam o comportamento.
    const matchedRefs = Array.from(new Set(rows.map((r) => String(r.REF || '').trim()).filter(Boolean)));
    const exactMatch = exact.length > 0;
    // Cabeçalho/foto/preço-base/promo usam a REF BASE exata (ex.: 900658), não a
    // variante de cor (900658M) — que pode vir antes na ordem do Giga. As células
    // da grade continuam agrupadas sob a base; cada uma guarda seu próprio código.
    const headRow = exact[0] || productRows[0];
    const ref = String(headRow.REF).trim();
    const descricao = headRow.DESCRICAOCOMPLETA || ref;

    // 2) Estoque por loja (1 query batch p/ todos os CODIGOs do produto).
    const codigos = Array.from(
      new Set(productRows.map((r) => String(r.CODIGO || '').trim()).filter(Boolean)),
    );
    const stockRes = await this.stockWithMirror(codigos);
    const detailed = stockRes.detailed;
    const fromMirror = resolved.fromMirror || stockRes.fromMirror;
    // Preço (VENDAUN em reais) COM FALLBACK no espelho — nunca mostra R$0 por
    // causa de hiccup no Giga ao vivo.
    const prices = await this.pricesWithMirror(codigos);
    const refPrice = await this.refPriceWithMirror(ref);
    const storesMap = await this.storesMap();

    // 3) Reservas ativas pra descontar. itemKey usa a REF DA PRÓPRIA LINHA (não a
    // base) — variantes de cor com sufixo (900658M) têm reserva/estoque próprios,
    // e assim VLM-222 × VLM-222EST nunca colidem numa mesma célula.
    const itemKeys = productRows.map((r) =>
      this.keyOf(String(r.REF || ref).trim(), r.COR, r.TAMANHO),
    );
    const { byKey, byKeyStore } = await this.committed(Array.from(new Set(itemKeys)));

    // 4) Monta células da grade (cor × tamanho), deduplicando por REF|COR|TAM.
    const cellMap = new Map<string, any>();
    for (const r of productRows) {
      const rowRef = String(r.REF || ref).trim();
      const cor = r.COR ? String(r.COR).trim() : null;
      const tam = r.TAMANHO ? String(r.TAMANHO).trim() : null;
      const itemKey = this.keyOf(rowRef, cor, tam);
      const codigo = String(r.CODIGO || '').trim();
      let cell = cellMap.get(itemKey);
      if (!cell) {
        cell = {
          itemKey,
          // REF real da célula — o front manda ela no addItem pra resolver o
          // estoque certo (a variante de cor pode ter REF própria, ex.: 900658M).
          ref: rowRef,
          cor,
          tamanho: tam,
          codigos: [] as string[],
          priceCents: 0,
          perStoreRaw: new Map<string, number>(),
        };
        cellMap.set(itemKey, cell);
      }
      if (codigo) cell.codigos.push(codigo);
      // preço: pega o 1º preço encontrado entre os codigos
      const p = prices.get(codigo) || 0;
      if (p > 0 && cell.priceCents === 0) cell.priceCents = this.reaisToCents(p);
      // estoque por loja
      for (const e of detailed[codigo] || []) {
        cell.perStoreRaw.set(e.storeCode, (cell.perStoreRaw.get(e.storeCode) || 0) + (e.qty || 0));
      }
    }

    // 5) Foto principal (best-effort). PERF: só a 1ª cor é usada no photoUrl —
    // buscar as N cores travava a busca (servidor de fotos externo/instável).
    // Busca SÓ a 1ª cor + a genérica, em paralelo.
    const cors = Array.from(new Set(productRows.map((r) => r.COR).filter(Boolean)));
    const [photoBatch, genericPhoto] = await Promise.all([
      cors.length
        ? this.photos.getBatch([{ ref, cor: cors[0] }]).catch(() => ({} as Record<string, string>))
        : Promise.resolve({} as Record<string, string>),
      this.photos.getPhoto(ref).catch(() => null),
    ]);

    let totalRede = 0;
    const cells = Array.from(cellMap.values()).map((c: any) => {
      const committedKey = byKey.get(c.itemKey) || 0;
      const perStore: Array<{ storeCode: string; storeName: string; qty: number }> = [];
      let rawTotal = 0;
      for (const [storeCode, qty] of c.perStoreRaw.entries()) {
        const committedStore = byKeyStore.get(`${c.itemKey}::${storeCode}`) || 0;
        const avail = Math.max(0, qty - committedStore);
        rawTotal += qty;
        if (avail > 0) {
          perStore.push({
            storeCode,
            storeName: storesMap.get(storeCode)?.name || storeCode,
            qty: avail,
          });
        }
      }
      perStore.sort((a, b) => b.qty - a.qty);
      const available = Math.max(0, rawTotal - committedKey);
      totalRede += available;
      return {
        itemKey: c.itemKey,
        ref: c.ref,
        cor: c.cor,
        tamanho: c.tamanho,
        codigos: c.codigos,
        priceCents: c.priceCents || this.reaisToCents(refPrice),
        available,
        perStore,
      };
    });

    cells.sort((a, b) => {
      const cc = this.norm(a.cor).localeCompare(this.norm(b.cor));
      if (cc !== 0) return cc;
      return this.norm(a.tamanho).localeCompare(this.norm(b.tamanho), undefined, { numeric: true });
    });

    const basePriceCents = cells.find((c) => c.priceCents > 0)?.priceCents || this.reaisToCents(refPrice);

    // Preço promocional da live (se a atendente definiu pra esse REF nessa sessão)
    const promoCents = sessionId ? await this.getPromo(sessionId, ref) : null;
    const promoActive = promoCents != null && promoCents > 0;
    const priceCents = promoActive ? promoCents! : basePriceCents;
    // Reflete a promo nas células (preço por REF)
    if (promoActive) for (const c of cells) c.priceCents = promoCents!;

    const photoUrl =
      (cors.length ? photoBatch[`${this.norm(ref)}|${this.norm(cors[0])}`] : null) ||
      genericPhoto?.url ||
      null;

    return {
      found: true,
      ref,
      descricao,
      priceCents,
      basePriceCents,
      promoActive,
      photoUrl,
      totalRede,
      cells,
      // true = produto/estoque vieram do ESPELHO (Giga ao vivo estava fora);
      // o número pode estar desatualizado — frontend mostra aviso.
      fromMirror,
      // Metadados da legenda/atalhos (aditivos — UI da live ignora)
      matchedRefs,
      exactMatch,
      viaAtalho,
    };
  }

  // ─── Legenda da Live (atalhos) ───────────────────────────────────────────────
  /** Normaliza o código de atalho: trim + MAIÚSCULA. */
  private normAtalho(s: string): string {
    return String(s || '').trim().toUpperCase();
  }

  async listAtalhos(sessionId: string) {
    await this.getSession(sessionId);
    return (this.prisma as any).livePdvAtalho.findMany({
      where: { sessionId },
      orderBy: [{ position: 'asc' }, { atalho: 'asc' }],
    });
  }

  /**
   * Cria/atualiza uma linha da legenda (atalho → referência).
   *
   * VALIDAÇÃO OBRIGATÓRIA: roda a MESMA rotina da live (searchGrade) na
   * referência — nada de lógica de busca paralela. Só salva se:
   *   - a busca ACHOU o produto; e
   *   - o termo não é AMBÍGUO (várias REFs sem match exato).
   * Retorna a grade da validação pro front exibir a prévia idêntica à live.
   */
  async saveAtalho(sessionId: string, input: { id?: string | null; atalho: string; refCode: string }) {
    await this.getSession(sessionId);
    const atalho = this.normAtalho(input.atalho);
    const refCode = String(input.refCode || '').trim();
    if (!atalho) throw new BadRequestException('Informe o atalho (ex: 01)');
    if (atalho.length > 10) throw new BadRequestException('Atalho muito longo (máx 10 caracteres)');
    if (!refCode) throw new BadRequestException('Informe a referência');

    // MESMA rotina da live. skipAtalho: valida a referência em si (e evita
    // recursão se alguém digitar um atalho no campo de referência).
    const grade: any = await this.searchGrade(refCode, sessionId, { skipAtalho: true });
    if (!grade.found) {
      throw new BadRequestException('Referência não encontrada. Confira a referência informada.');
    }
    if (!grade.exactMatch && (grade.matchedRefs?.length || 0) > 1) {
      throw new BadRequestException(
        'Referência possui mais de um resultado. Informe a referência completa.',
      );
    }

    // Atalho duplicado na mesma live (em OUTRA linha) — erro amigável
    const dup = await (this.prisma as any).livePdvAtalho.findUnique({
      where: { sessionId_atalho: { sessionId, atalho } },
    });
    if (dup && dup.id !== input.id) {
      throw new BadRequestException(`Atalho "${atalho}" já usado pra ${dup.refCode} nesta live`);
    }

    let row;
    if (input.id) {
      row = await (this.prisma as any).livePdvAtalho.update({
        where: { id: input.id },
        data: { atalho, refCode, descricao: grade.descricao || null },
      });
    } else {
      const count = await (this.prisma as any).livePdvAtalho.count({ where: { sessionId } });
      row = await (this.prisma as any).livePdvAtalho.create({
        data: { sessionId, atalho, refCode, descricao: grade.descricao || null, position: count },
      });
    }
    return { ok: true, atalho: row, grade };
  }

  async deleteAtalho(sessionId: string, id: string) {
    const row = await (this.prisma as any).livePdvAtalho.findUnique({ where: { id } });
    if (!row || row.sessionId !== sessionId) throw new NotFoundException('Atalho não encontrado');
    await (this.prisma as any).livePdvAtalho.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Preço promocional da live ───────────────────────────────────────────────
  /** Retorna o preço promo (centavos) de um REF na sessão, ou null. */
  private async getPromo(sessionId: string, refCode: string): Promise<number | null> {
    const promo = await (this.prisma as any).livePdvPromo.findUnique({
      where: { sessionId_refCode: { sessionId, refCode: this.norm(refCode) } },
    });
    return promo && promo.priceCents > 0 ? promo.priceCents : null;
  }

  async listPromos(sessionId: string) {
    return (this.prisma as any).livePdvPromo.findMany({ where: { sessionId } });
  }

  /**
   * Define (ou remove, se priceCents<=0) o preço promo de um REF na sessão.
   * Aplica em TEMPO REAL aos itens ainda RESERVADOS desse REF (não pagos):
   * troca o priceCents pelo promo (ou volta ao basePriceCents se removido) e
   * recalcula os carrinhos afetados. O custo (÷2,5) NÃO muda — fica preso ao
   * preço cheio (basePriceCents), pra conciliação intercompany não distorcer.
   */
  async setPromoPrice(sessionId: string, refCode: string, priceCents: number, userId?: string | null) {
    await this.getSession(sessionId);
    const ref = this.norm(refCode);
    if (!ref) throw new BadRequestException('REF obrigatória');

    const promoOn = priceCents && priceCents > 0;
    if (promoOn) {
      await (this.prisma as any).livePdvPromo.upsert({
        where: { sessionId_refCode: { sessionId, refCode: ref } },
        create: { sessionId, refCode: ref, priceCents: Math.round(priceCents), createdByUserId: userId || null },
        update: { priceCents: Math.round(priceCents) },
      });
    } else {
      await (this.prisma as any).livePdvPromo.deleteMany({ where: { sessionId, refCode: ref } });
    }

    // "COMPROU COMPROU": a Promo Live vale SÓ pras próximas peças bipadas. Itens
    // que JÁ estão no carrinho ficam TRAVADOS no preço que pegaram — NÃO
    // re-precificamos nada (nem ao mudar, nem ao remover a promo). O custo (÷2,5)
    // do intercompany continua preso ao basePriceCents (preço cheio).
    this.gateway.emitToLiveOps('live-pdv:promo', {
      sessionId,
      refCode: ref,
      priceCents: promoOn ? Math.round(priceCents) : null,
      affected: 0,
    });

    return { ok: true, refCode: ref, priceCents: promoOn ? Math.round(priceCents) : null, affected: 0 };
  }

  // ─── Cliente ──────────────────────────────────────────────────────────────
  async quickCustomer(input: {
    name: string;
    phone: string;
    instagram?: string;
    cpf?: string;
    email?: string;
    // Cadastro veio do link da live (ManyChat)? Carimba liveRegisteredAt pra
    // entrar na fila "Cadastradas na live" — mesmo se a cliente já existir.
    markLiveRegistration?: boolean;
  }) {
    const name = (input.name || '').trim();
    const phone = (input.phone || '').replace(/\D/g, '');
    if (!name) throw new BadRequestException('Nome é obrigatório');
    const ig = (input.instagram || '').trim().replace(/^@/, '') || null;
    const liveStamp = input.markLiveRegistration ? new Date() : null;

    // Tenta achar cliente existente por telefone ou instagram (evita duplicar).
    // Só busca se houver alguma chave — telefone vazio não pode casar com outros.
    const orConds: any[] = [];
    if (phone) orConds.push({ phone });
    if (ig) orConds.push({ igUsername: ig });
    const existing = orConds.length
      ? await (this.prisma as any).customer.findFirst({ where: { OR: orConds } })
      : null;
    if (existing) {
      // Atualiza dados faltantes sem sobrescrever o que já tem
      const patch: any = {};
      if (!existing.name && name) patch.name = name;
      if (!existing.igUsername && ig) patch.igUsername = ig;
      if (!existing.email && input.email) patch.email = input.email.trim();
      if (!existing.cpf && input.cpf) patch.cpf = input.cpf.replace(/\D/g, '');
      if (liveStamp) patch.liveRegisteredAt = liveStamp; // sempre carimba, mesmo sem outro patch
      if (Object.keys(patch).length) {
        await (this.prisma as any).customer.update({ where: { id: existing.id }, data: patch });
      }
      return { id: existing.id, name: existing.name || name, phone, instagram: ig };
    }

    const created = await (this.prisma as any).customer.create({
      data: {
        name,
        phone,
        igUsername: ig,
        email: input.email?.trim() || null,
        cpf: input.cpf ? input.cpf.replace(/\D/g, '') : null,
        originSource: 'live',
        liveRegisteredAt: liveStamp,
      },
    });
    return { id: created.id, name, phone, instagram: ig };
  }

  /**
   * Edita os dados do cliente de um carrinho a QUALQUER MOMENTO da live.
   * Atualiza tanto o cadastro mestre (Customer, mantendo originSource='live')
   * quanto o snapshot do carrinho. Só o nome é obrigatório.
   */
  async updateCartCustomer(cartId: string, input: {
    name: string;
    phone?: string;
    instagram?: string;
    cpf?: string;
    email?: string;
    cep?: string;
    endereco?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
  }) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    const name = (input.name || '').trim();
    if (!name) throw new BadRequestException('Nome é obrigatório');
    const phone = (input.phone || '').replace(/\D/g, '');
    const ig = (input.instagram || '').trim().replace(/^@/, '') || null;
    const cpf = input.cpf ? input.cpf.replace(/\D/g, '') : null;
    const email = input.email?.trim() || null;
    // Endereço de entrega (opcional — capturado no PIX; CEP puxa via ViaCEP).
    const cep = input.cep ? input.cep.replace(/\D/g, '') : null;
    const endereco = input.endereco?.trim() || null;
    const numero = input.numero?.trim() || null;
    const complemento = input.complemento?.trim() || null;
    const bairro = input.bairro?.trim() || null;
    const cidade = input.cidade?.trim() || null;
    const uf = input.uf?.trim().toUpperCase().slice(0, 2) || null;

    // Atualiza o cliente mestre (cria se o carrinho ainda não tinha vínculo).
    let customerId: string | null = cart.customerId || null;
    try {
      if (customerId) {
        await (this.prisma as any).customer.update({
          where: { id: customerId },
          data: { name, phone: phone || null, igUsername: ig, cpf, email, originSource: 'live' },
        });
      } else {
        const created = await (this.prisma as any).customer.create({
          data: { name, phone: phone || null, igUsername: ig, cpf, email, originSource: 'live' },
        });
        customerId = created.id;
      }
    } catch (e) {
      // Conflito (ex.: e-mail único já usado por outro cliente) não pode travar
      // a live — o snapshot do carrinho continua sendo a fonte pra venda.
      this.logger.warn(`updateCartCustomer: falha ao salvar Customer: ${(e as Error).message}`);
    }

    // Upsert do endereço mestre (CustomerAddress) — só se veio algo de endereço.
    if (customerId && (cep || endereco || cidade)) {
      try {
        const addrData = {
          cep,
          street: endereco,
          number: numero,
          complement: complemento,
          district: bairro,
          city: cidade,
          state: uf,
        };
        const existing = await (this.prisma as any).customerAddress.findFirst({
          where: { customerId },
        });
        if (existing) {
          await (this.prisma as any).customerAddress.update({
            where: { id: existing.id },
            data: addrData,
          });
        } else {
          await (this.prisma as any).customerAddress.create({
            data: { customerId, type: 'entrega', isPrimary: true, ...addrData },
          });
        }
      } catch (e) {
        this.logger.warn(`updateCartCustomer: falha ao salvar endereço: ${(e as Error).message}`);
      }
    }

    const updated = await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: {
        customerId,
        customerName: name,
        customerPhone: phone,
        customerInstagram: ig,
        customerCpf: cpf,
        customerEmail: email,
        customerCep: cep,
        customerEndereco: endereco,
        customerNumero: numero,
        customerComplemento: complemento,
        customerBairro: bairro,
        customerCidade: cidade,
        customerUf: uf,
      },
    });
    this.gateway.emitToLiveOps('live-pdv:cart-updated', { cartId, sessionId: cart.sessionId });
    return this.getCart(updated.id);
  }

  // ─── Carrinho / Itens ───────────────────────────────────────────────────────
  private async ensureCart(sessionId: string, customer: {
    id?: string | null;
    name: string;
    phone: string;
    instagram?: string | null;
    cpf?: string | null;
    email?: string | null;
    cep?: string | null;
  }) {
    if (customer.id) {
      const open = await (this.prisma as any).livePdvCart.findFirst({
        where: { sessionId, customerId: customer.id, status: { in: ['open', 'awaiting_payment'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (open) return open;
    }
    return (this.prisma as any).livePdvCart.create({
      data: {
        sessionId,
        customerId: customer.id || null,
        customerName: customer.name,
        customerPhone: (customer.phone || '').replace(/\D/g, ''),
        customerInstagram: customer.instagram || null,
        customerCpf: customer.cpf || null,
        customerEmail: customer.email || null,
        customerCep: customer.cep || null,
        status: 'open',
      },
    });
  }

  /**
   * Busca clientes que JÁ participaram de alguma live (têm carrinho em
   * LivePdvCart), por nome / telefone / @. Busca direto no snapshot do carrinho
   * (distinct por customerId) — naturalmente restrito a participantes de live.
   * Não expõe a base geral de loja/site.
   */
  async searchLiveCustomers(term: string) {
    const t = (term || '').trim();
    if (t.length < 2) return [];
    const digits = t.replace(/\D/g, '');
    const ig = t.replace(/^@/, '');
    const OR: any[] = [
      { customerName: { contains: t, mode: 'insensitive' } },
      { customerInstagram: { contains: ig, mode: 'insensitive' } },
    ];
    if (digits.length >= 3) {
      OR.push({ customerPhone: { contains: digits } });
      OR.push({ customerCpf: { contains: digits } }); // CPF é chave de busca
    }
    const carts = await (this.prisma as any).livePdvCart.findMany({
      where: { customerId: { not: null }, OR },
      distinct: ['customerId'],
      orderBy: { createdAt: 'desc' },
      select: {
        customerId: true,
        customerName: true,
        customerPhone: true,
        customerInstagram: true,
        customerCpf: true,
      },
      take: 20,
    });
    return carts.map((c: any) => ({
      customerId: c.customerId,
      name: c.customerName,
      phone: c.customerPhone,
      instagram: c.customerInstagram,
      cpf: c.customerCpf,
    }));
  }

  /**
   * Autocomplete por @ na hora de identificar a cliente que vai receber a peça.
   * Busca clientes que TÊM @ (igUsername) por @/nome/telefone — quem se cadastrou
   * pela live (liveRegisteredAt) vem primeiro. Só clientes com @ (não expõe a
   * base geral de loja, que não tem Instagram).
   */
  async searchCustomersByAt(term: string) {
    const t = (term || '').trim().replace(/^@/, '');
    if (t.length < 2) return [];
    const digits = t.replace(/\D/g, '');
    const OR: any[] = [
      { igUsername: { contains: t, mode: 'insensitive' } },
      { name: { contains: t, mode: 'insensitive' } },
    ];
    if (digits.length >= 3) OR.push({ phone: { contains: digits } });
    const rows = await (this.prisma as any).customer.findMany({
      where: { igUsername: { not: null }, OR },
      orderBy: [{ liveRegisteredAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
      select: { id: true, name: true, igUsername: true, phone: true, liveRegisteredAt: true },
      take: 12,
    });
    return (rows as any[]).map((r) => ({
      customerId: r.id,
      name: r.name,
      instagram: r.igUsername,
      phone: r.phone,
      registered: !!r.liveRegisteredAt,
    }));
  }

  /**
   * Clientes que se CADASTRARAM na live (origem 'live') nas últimas 24h e que
   * ainda NÃO têm carrinho na sessão atual. É a fila de "aguardando" que a
   * apresentadora vê pra puxar quem chegou pelo cadastro do ManyChat.
   * (Só origem 'live' — não expõe a base geral de loja/site.)
   */
  async pendingLiveRegistrations(sessionId: string) {
    if (!sessionId) return [];
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const carts = await (this.prisma as any).livePdvCart.findMany({
      where: { sessionId, customerId: { not: null } },
      select: { customerId: true },
    });
    const already = new Set((carts as any[]).map((c) => c.customerId));
    const custs = await (this.prisma as any).customer.findMany({
      where: { liveRegisteredAt: { gte: since } },
      orderBy: { liveRegisteredAt: 'desc' },
      select: { id: true, name: true, phone: true, igUsername: true, liveRegisteredAt: true },
      take: 80,
    });
    return (custs as any[])
      .filter((c) => !already.has(c.id))
      .slice(0, 40)
      .map((c) => ({
        customerId: c.id,
        name: c.name,
        phone: c.phone,
        instagram: c.igUsername,
        createdAt: c.liveRegisteredAt,
      }));
  }

  /**
   * Puxa uma cliente já existente (de live anterior) para a sessão de live
   * ATUAL: cria (ou reusa) o carrinho aberto dela na sessão. Usa os dados mais
   * frescos do cadastro mestre, com fallback no snapshot do último carrinho.
   */
  async addCustomerToSession(sessionId: string, customerId: string) {
    if (!customerId) throw new BadRequestException('customerId obrigatório');
    const cust = await (this.prisma as any).customer.findUnique({ where: { id: customerId } });
    let name = (cust?.name || '').trim();
    let phone = cust?.phone || '';
    let instagram = cust?.igUsername || null;
    if (!name) {
      // fallback: snapshot do carrinho mais recente dessa cliente
      const last = await (this.prisma as any).livePdvCart.findFirst({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        select: { customerName: true, customerPhone: true, customerInstagram: true },
      });
      if (last) {
        name = last.customerName;
        phone = phone || last.customerPhone;
        instagram = instagram || last.customerInstagram;
      }
    }
    if (!name) throw new NotFoundException('Cliente não encontrada');
    const cart = await this.ensureCart(sessionId, { id: customerId, name, phone, instagram });
    this.gateway.emitToLiveOps('live-pdv:cart-updated', { cartId: cart.id, sessionId });
    return cart;
  }

  /**
   * Adiciona um item ao carrinho da cliente. Escolhe a loja de origem
   * automaticamente (RoutingEngine) e cria a reserva com TTL.
   */
  async addItem(input: {
    sessionId: string;
    cartId?: string;
    customer?: {
      id?: string | null;
      name: string;
      phone: string;
      instagram?: string | null;
      cpf?: string | null;
      email?: string | null;
      cep?: string | null;
    };
    refCode: string;
    cor?: string | null;
    tamanho?: string | null;
    qty?: number;
  }) {
    const session = await this.getSession(input.sessionId);
    if (session.status === 'ended') throw new BadRequestException('Sessão da live encerrada');

    const qty = Math.max(1, input.qty || 1);
    const ref = (input.refCode || '').trim();
    if (!ref) throw new BadRequestException('Referência obrigatória');
    const cor = input.cor ? String(input.cor).trim() : null;
    const tam = input.tamanho ? String(input.tamanho).trim() : null;
    const itemKey = this.keyOf(ref, cor, tam);

    // Carrinho (existente ou novo via cliente)
    let cart: any;
    if (input.cartId) {
      cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: input.cartId } });
      if (!cart) throw new NotFoundException('Carrinho não encontrado');
    } else if (input.customer) {
      cart = await this.ensureCart(input.sessionId, input.customer);
    } else {
      throw new BadRequestException('Informe cartId ou dados da cliente');
    }
    if (['paid', 'separating', 'shipped', 'delivered', 'cancelled'].includes(cart.status)) {
      throw new BadRequestException('Carrinho já fechado/pago — abra um novo');
    }

    // Estoque por loja + reservas ativas → disponibilidade real
    const { byStore, bestCodigo } = await this.erpStockByStoreForItem(ref, cor, tam);
    if (byStore.size === 0) throw new BadRequestException('Produto sem estoque em nenhuma loja');
    const { byKeyStore } = await this.committed([itemKey]);

    // Monta entradas pro RoutingEngine (sku sintético = itemKey)
    const storesMap = await this.storesMap();
    const storeInputs: StoreInput[] = [];
    const stock: StockEntry[] = [];
    for (const [storeCode, raw] of byStore.entries()) {
      const st = storesMap.get(storeCode);
      if (!st) continue; // loja inativa/desconhecida
      const reserved = byKeyStore.get(`${itemKey}::${storeCode}`) || 0;
      const avail = Math.max(0, raw - reserved);
      storeInputs.push({
        id: st.id,
        code: st.code,
        name: st.name,
        cep: st.cep,
        priorityScore: st.priorityScore ?? 50,
        active: true,
      });
      stock.push({ storeCode, sku: itemKey, availableQty: avail });
    }
    if (storeInputs.length === 0) throw new BadRequestException('Sem loja ativa com estoque');

    // FASE A — AGRUPAR FRETE: se o carrinho JÁ usa uma loja que tem estoque
    // pra esta peça, prefere ela (concentra o envio, paga menos frete). Só abre
    // loja nova quando nenhuma já usada cobre. 1ª peça do carrinho → roteia normal.
    let preferStoreCode: string | undefined;
    const existingItems = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId: cart.id, status: { in: this.COMMITTED } },
      select: { originStoreCode: true },
    });
    if (existingItems.length) {
      const freq = new Map<string, number>();
      for (const it of existingItems as any[]) {
        if (it.originStoreCode) freq.set(it.originStoreCode, (freq.get(it.originStoreCode) || 0) + 1);
      }
      const availByStore = new Map(stock.map((s) => [s.storeCode, s.availableQty]));
      for (const [storeCode] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
        if ((availByStore.get(storeCode) || 0) >= qty) {
          preferStoreCode = storeCode;
          break;
        }
      }
    }

    // RoutingEngine escolhe a melhor loja de origem (respeitando preferStoreCode)
    const result = this.routing.route({
      items: [{ sku: itemKey, quantity: qty }],
      stores: storeInputs,
      stock,
      shippingCep: cart.customerCep || session.liveStoreCode || null,
      preferStoreCode,
    });
    if (!result.success || !result.assignments.length) {
      throw new BadRequestException(
        `Sem estoque disponível pra ${ref} ${cor || ''} ${tam || ''} (já reservado na live)`,
      );
    }
    const chosen = result.assignments[0];

    // Preço (VENDAUN em reais) COM FALLBACK no espelho — nunca reserva a R$0.
    const priceMap = bestCodigo ? await this.pricesWithMirror([bestCodigo]) : new Map<string, number>();
    let priceReais = bestCodigo ? priceMap.get(bestCodigo) || 0 : 0;
    if (priceReais === 0) priceReais = await this.refPriceWithMirror(ref);
    const basePriceCents = this.reaisToCents(priceReais);
    // Aplica preço promocional da live se houver pro REF nessa sessão
    const promo = await this.getPromo(session.id, ref);
    const priceCents = promo != null && promo > 0 ? promo : basePriceCents;

    // Descrição — SÓ ESPELHO, ref EXATO (usa índice).
    const rowsForDesc = await (this.prisma as any).gigaProduto
      .findMany({
        where: { ref: ref },
        select: { cor: true, tamanho: true, descricao: true },
      })
      .catch(() => []);
    const descRow = (rowsForDesc as any[]).find(
      (r) => this.norm(r.cor) === this.norm(cor) && this.norm(r.tamanho) === this.norm(tam),
    );
    const descricao = descRow?.descricao || ref;

    // Cria item + atualiza carrinho (transação)
    const expiresAt = new Date(Date.now() + session.reservationTtlMin * 60 * 1000);
    const item = await (this.prisma as any).livePdvItem.create({
      data: {
        cartId: cart.id,
        sessionId: session.id,
        refCode: ref,
        itemKey,
        codigoBipado: bestCodigo,
        descricao,
        cor,
        tamanho: tam,
        qty,
        priceCents,
        basePriceCents,
        custoCents: this.custoCents(basePriceCents),
        originStoreCode: chosen.storeCode,
        originStoreName: chosen.storeName,
        status: 'reserved',
        expiresAt,
      },
    });

    await this.recalcCart(cart.id);
    const fullCart = await this.getCart(cart.id);

    // Eventos realtime
    this.gateway.emitToLiveOps('live-pdv:item-reserved', {
      sessionId: session.id,
      cartId: cart.id,
      itemId: item.id,
      ref,
      cor,
      tamanho: tam,
      originStoreCode: chosen.storeCode,
    });

    return { item, cart: fullCart };
  }

  private async recalcCart(cartId: string) {
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: { in: [...this.COMMITTED, 'shipped', 'delivered'] } },
    });
    const subtotal = (items as any[]).reduce((s, i) => s + i.priceCents * i.qty, 0);
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    const frete = cart?.freteCents || 0;
    const newTotal = subtotal + frete;
    const data: any = { subtotalCents: subtotal, totalCents: newTotal };
    // INVALIDA cobrança pendente quando o total muda (ex.: promo aplicada
    // depois do PIX gerado). Sem isso, o QR/link fica com o valor antigo
    // (oficial) enquanto o carrinho já está no promo. Derruba o pagamento
    // velho → operadora gera um novo com o valor correto.
    if (cart && cart.status === 'awaiting_payment' && newTotal !== cart.totalCents) {
      data.status = 'open';
      data.pagarmeOrderId = null;
      data.qrCodeText = null;
      data.qrCodeImageUrl = null;
      data.paymentExpiresAt = null;
      data.paymentMethod = null;
    }
    await (this.prisma as any).livePdvCart.update({ where: { id: cartId }, data });
  }

  async getCart(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: { notIn: ['cancelled', 'expired'] } },
      orderBy: { createdAt: 'asc' },
    });
    return { ...cart, items };
  }

  // Statuses que contam como "já pago" (não deixa cobrar de novo).
  static PAID_STATES = ['paid', 'separating', 'shipped', 'delivered'];

  /**
   * Resumo PÚBLICO do carrinho pra página de fechamento da cliente
   * (/pagar/<cartId>). Só dados necessários — NÃO expõe CPF/telefone/custo.
   */
  async publicCheckoutSummary(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Compra não encontrada');
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: { notIn: ['cancelled', 'expired'] } },
      orderBy: { createdAt: 'asc' },
      select: { refCode: true, descricao: true, cor: true, tamanho: true, qty: true, priceCents: true },
    });
    let storeName: string | null = null;
    let pixAvailable = true; // PIX automático (PagBank) — falso se a loja é "externo"
    try {
      const s = await this.getSession(cart.sessionId);
      storeName = (s as any)?.liveStoreName || null;
      const store = await (this.prisma as any).store.findUnique({
        where: { code: (s as any)?.liveStoreCode },
        select: { pixProvider: true },
      });
      pixAvailable = (store as any)?.pixProvider !== 'externo';
    } catch { /* sessão/loja indisponível — segue com defaults */ }
    return {
      cartId: cart.id,
      firstName: String(cart.customerName || 'Cliente').trim().split(/\s+/)[0] || 'Cliente',
      status: cart.status,
      paymentMethod: cart.paymentMethod || null,
      subtotalCents: cart.subtotalCents || 0,
      freteCents: cart.freteCents || 0,
      totalCents: cart.totalCents || 0,
      cep: cart.customerCep || null,
      storeName,
      pixAvailable,
      paid: LivePdvService.PAID_STATES.includes(cart.status),
      items: (items as any[]).map((it) => ({
        descricao: it.descricao || it.refCode,
        ref: it.refCode,
        cor: it.cor,
        tamanho: it.tamanho,
        qty: it.qty,
        priceCents: it.priceCents,
      })),
      // pagamento já iniciado nesse carrinho?
      pix: cart.paymentMethod === 'pix'
        ? { qrCodeText: cart.qrCodeText, qrCodeImageUrl: cart.qrCodeImageUrl }
        : null,
      paymentUrl: cart.paymentMethod === 'link' ? cart.qrCodeText : null,
    };
  }

  async listCarts(sessionId: string) {
    const carts = await (this.prisma as any).livePdvCart.findMany({
      where: { sessionId, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' },
    });
    const ids = carts.map((c: any) => c.id);
    const items = ids.length
      ? await (this.prisma as any).livePdvItem.findMany({
          where: { cartId: { in: ids }, status: { notIn: ['cancelled', 'expired'] } },
        })
      : [];
    const byCart = new Map<string, any[]>();
    for (const it of items as any[]) {
      if (!byCart.has(it.cartId)) byCart.set(it.cartId, []);
      byCart.get(it.cartId)!.push(it);
    }
    return carts.map((c: any) => ({ ...c, items: byCart.get(c.id) || [] }));
  }

  async cancelItem(itemId: string, reason?: string) {
    const item = await (this.prisma as any).livePdvItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item não encontrado');
    if (['shipped', 'delivered'].includes(item.status)) {
      throw new BadRequestException('Item já despachado — não pode cancelar aqui');
    }
    await (this.prisma as any).livePdvItem.update({
      where: { id: itemId },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason || 'manual' },
    });
    await this.recalcCart(item.cartId);
    this.gateway.emitToLiveOps('live-pdv:item-cancelled', { itemId, cartId: item.cartId });
    return this.getCart(item.cartId);
  }

  /**
   * Exclui (cancela) o carrinho INTEIRO de uma cliente — cancela todos os
   * itens não-terminais (libera as reservas) e marca o carrinho como cancelado.
   * Bloqueado se já pago/em separação (aí não é "excluir cliente", é estorno).
   */
  async cancelCart(cartId: string, reason?: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    if (['paid', 'separating', 'shipped', 'delivered'].includes(cart.status)) {
      throw new BadRequestException('Carrinho já pago/em separação — não pode ser excluído aqui');
    }
    const now = new Date();
    await (this.prisma as any).livePdvItem.updateMany({
      where: { cartId, status: { in: ['reserved', 'awaiting_payment'] } },
      data: { status: 'cancelled', cancelledAt: now, cancelReason: reason || 'carrinho excluído' },
    });
    await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: { status: 'cancelled' },
    });
    this.gateway.emitToLiveOps('live-pdv:cart-cancelled', { cartId, sessionId: cart.sessionId });
    return { ok: true };
  }

  /**
   * RECUPERAÇÃO: re-reserva os itens que EXPIRARAM (TTL) numa sessão, com novo
   * prazo (default 24h). Pra remontar carrinhos quando reservas venceram por
   * incidente. Não duplica itemKey que já foi re-bipado. Recalcula os carrinhos.
   */
  async recoverExpiredReservations(sessionId: string, ttlHours = 24) {
    await this.getSession(sessionId);
    const carts = await (this.prisma as any).livePdvCart.findMany({
      where: { sessionId, status: { not: 'cancelled' } },
      select: { id: true },
    });
    const cartIds = (carts as any[]).map((c) => c.id);
    if (!cartIds.length) return { recovered: 0, carts: 0 };

    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId: { in: cartIds } },
      select: { id: true, cartId: true, itemKey: true, status: true },
    });

    // Por carrinho, conjunto de itemKeys JÁ ativos (não recupera duplicado).
    const ACTIVE = ['reserved', 'paid', 'separating', 'shipped', 'delivered', 'awaiting_payment'];
    const activeByCart = new Map<string, Set<string>>();
    for (const it of items as any[]) {
      if (ACTIVE.includes(it.status)) {
        if (!activeByCart.has(it.cartId)) activeByCart.set(it.cartId, new Set());
        activeByCart.get(it.cartId)!.add(it.itemKey);
      }
    }

    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const affected = new Set<string>();
    let recovered = 0;
    for (const it of items as any[]) {
      if (it.status !== 'expired') continue;
      let set = activeByCart.get(it.cartId);
      if (set && set.has(it.itemKey)) continue; // já re-bipado — não duplica
      await (this.prisma as any).livePdvItem.update({
        where: { id: it.id },
        data: { status: 'reserved', expiresAt },
      });
      if (!set) { set = new Set(); activeByCart.set(it.cartId, set); }
      set.add(it.itemKey);
      affected.add(it.cartId);
      recovered++;
    }
    for (const cid of affected) await this.recalcCart(cid).catch(() => {});
    if (recovered > 0) {
      this.gateway.emitToLiveOps('live-pdv:recovered', { sessionId, recovered, carts: affected.size });
    }
    return { recovered, carts: affected.size, expiresAt };
  }

  /** Troca manual da loja de origem (supervisor). */
  async changeItemOrigin(itemId: string, storeCode: string) {
    const item = await (this.prisma as any).livePdvItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item não encontrado');
    if (item.status !== 'reserved') {
      throw new BadRequestException('Só dá pra trocar a loja antes do pagamento');
    }
    const store = await (this.prisma as any).store.findUnique({ where: { code: storeCode } });
    if (!store) throw new BadRequestException('Loja não encontrada');
    // Valida estoque disponível na nova loja
    const { byStore } = await this.erpStockByStoreForItem(item.refCode, item.cor, item.tamanho);
    const { byKeyStore } = await this.committed([item.itemKey]);
    const raw = byStore.get(storeCode) || 0;
    const reserved = byKeyStore.get(`${item.itemKey}::${storeCode}`) || 0;
    // desconta a própria reserva atual se já era nessa loja (não é o caso, mas seguro)
    const avail = Math.max(0, raw - reserved);
    if (avail < item.qty) {
      throw new BadRequestException(`Loja ${store.name} sem estoque disponível (${avail})`);
    }
    return (this.prisma as any).livePdvItem.update({
      where: { id: itemId },
      data: { originStoreCode: store.code, originStoreName: store.name, originManual: true },
    });
  }

  async setFrete(cartId: string, freteCents: number) {
    await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: { freteCents: Math.max(0, Math.round(freteCents || 0)) },
    });
    await this.recalcCart(cartId);
    return this.getCart(cartId);
  }

  /**
   * Frete FIXO por CEP (regra Lurd's):
   *   - SP (CEP 01000-19999)                         → SEDEX R$  9,99
   *   - Sul + Sudeste exceto SP (RJ/ES/MG/PR/SC/RS)  → PAC   R$ 19,99
   *   - Demais estados (Norte/Nordeste/Centro-Oeste) → PAC   R$ 39,99
   * Faixas por prefixo de CEP (5 primeiros dígitos):
   *   SP 01000-19999 · RJ/ES/MG 20000-39999 · PR/SC/RS 80000-99999 · resto 40000-79999.
   * Retorna null se o CEP não tiver 8 dígitos.
   */
  private freteFromCep(
    cepRaw?: string | null,
  ): { cents: number; servico: 'SEDEX' | 'PAC'; regiao: string } | null {
    const cep = String(cepRaw || '').replace(/\D/g, '');
    if (cep.length !== 8) return null;
    const prefixo = parseInt(cep.slice(0, 5), 10); // 5 primeiros dígitos
    if (prefixo >= 1000 && prefixo <= 19999) {
      return { cents: 999, servico: 'SEDEX', regiao: 'São Paulo' };
    }
    // Sudeste (exceto SP): RJ/ES/MG · Sul: PR/SC/RS
    if ((prefixo >= 20000 && prefixo <= 39999) || (prefixo >= 80000 && prefixo <= 99999)) {
      return { cents: 1999, servico: 'PAC', regiao: 'Sul/Sudeste' };
    }
    return { cents: 3999, servico: 'PAC', regiao: 'Demais estados' }; // N/NE/CO
  }

  /**
   * Calcula e aplica o frete do carrinho DERIVANDO do CEP da cliente.
   * Usado pelo botão "Calcular frete pelo CEP" na tela da live.
   */
  async computeFreteFromCep(cartId: string, cepOverride?: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({
      where: { id: cartId },
    });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    // Usa o CEP digitado na hora (se veio válido) ou o que está no carrinho.
    const overrideDigits = (cepOverride || '').replace(/\D/g, '');
    const cepToUse = overrideDigits.length === 8 ? overrideDigits : cart.customerCep;
    const calc = this.freteFromCep(cepToUse);
    if (!calc) {
      throw new BadRequestException(
        'Cliente sem CEP válido — informe o CEP pra calcular o frete.',
      );
    }
    const data: any = { freteCents: calc.cents };
    // Se o operador digitou o CEP na hora, guarda no carrinho.
    if (overrideDigits.length === 8) data.customerCep = overrideDigits;
    await (this.prisma as any).livePdvCart.update({ where: { id: cartId }, data });
    await this.recalcCart(cartId);
    const fresh = await this.getCart(cartId);
    return { ...(fresh as any), freteServico: calc.servico, freteRegiao: calc.regiao };
  }

  // ─── Pagamento (PIX) ─────────────────────────────────────────────────────────
  async startPayment(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: 'reserved' },
    });
    if (!items.length) throw new BadRequestException('Carrinho sem itens reservados');
    const session = await this.getSession(cart.sessionId);
    await this.recalcCart(cartId);
    const fresh = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    const valor = (fresh.totalCents || 0) / 100;
    if (valor <= 0) throw new BadRequestException('Total inválido');
    await this.assertGatewayAllowed(session.liveStoreCode);

    // PIX da Live via PAGBANK (gateway oficial da loja). Reusa o campo
    // pagarmeOrderId do carrinho pra guardar o pagbankOrderId (é só um id de
    // order — o checkPayment resolve o gateway pelo paymentMethod='pix').
    const charge = await this.pagbank.createPixCharge({
      saleId: cartId,
      valor,
      storeCode: session.liveStoreCode,
      customerName: cart.customerName,
      customerCpf: cart.customerCpf || undefined,
      customerEmail: cart.customerEmail || undefined,
      expiresInMinutes: session.reservationTtlMin,
    });
    // PagBank devolve a imagem em base64 puro; o frontend usa como <img src>.
    const qrImg = charge.qrCodeImageB64 ? `data:image/png;base64,${charge.qrCodeImageB64}` : '';

    const updated = await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: {
        status: 'awaiting_payment',
        paymentMethod: 'pix',
        pagarmeOrderId: charge.pagbankOrderId,
        qrCodeText: charge.qrCodeText,
        qrCodeImageUrl: qrImg,
        paymentExpiresAt: charge.expiresAt,
      },
    });
    return {
      cart: updated,
      qrCodeText: charge.qrCodeText,
      qrCodeImageUrl: qrImg,
      expiresAt: charge.expiresAt,
      valor,
    };
  }

  /**
   * Gera um LINK DE PAGAMENTO (checkout Pagar.me) pra cliente pagar por fora
   * (WhatsApp/Instagram), com PIX ou cartão. Mesma confirmação automática do
   * PIX (o checkPayment já detecta pago independente do método).
   */
  async startPaymentLink(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: 'reserved' },
    });
    if (!items.length) throw new BadRequestException('Carrinho sem itens reservados');
    const session = await this.getSession(cart.sessionId);
    await this.recalcCart(cartId);
    const fresh = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    const valor = (fresh.totalCents || 0) / 100;
    if (valor <= 0) throw new BadRequestException('Total inválido');
    // NÃO passa pelo assertGatewayAllowed: o cartão usa o Pagar.me da MATRIZ,
    // independente do PIX da loja (franquia com PIX externo também gera cartão).

    const link = await this.pagarme.createCheckoutLink({
      saleId: cartId,
      valor,
      storeCode: session.liveStoreCode,
      storeName: session.liveStoreName,
      customerName: cart.customerName,
      customerCpf: cart.customerCpf || undefined,
      customerPhone: cart.customerPhone || undefined,
      customerEmail: cart.customerEmail || undefined,
      expiresInMinutes: 1440, // 24h pra cliente pagar
      maxInstallments: 12, // até 12x sem juros no cartão
    });

    const updated = await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: {
        status: 'awaiting_payment',
        paymentMethod: 'link',
        pagarmeOrderId: link.pagarmeOrderId,
        qrCodeText: link.paymentUrl, // reusa o campo pra guardar a URL do link
        paymentExpiresAt: link.expiresAt,
      },
    });
    return {
      cart: updated,
      paymentUrl: link.paymentUrl,
      expiresAt: link.expiresAt,
      valor,
    };
  }

  /**
   * Lojas com pixProvider='externo' (ex.: franquias sem chave Pagar.me) NÃO
   * geram cobrança de gateway. Bloqueia startPayment/startPaymentLink com uma
   * mensagem clara e manda usar a confirmação manual (pay-external).
   */
  private async assertGatewayAllowed(storeCode: string): Promise<void> {
    const store = await (this.prisma as any).store.findUnique({
      where: { code: storeCode },
      select: { pixProvider: true },
    });
    if ((store as any)?.pixProvider === 'externo') {
      throw new BadRequestException(
        'Esta loja usa PIX externo (maquininha própria) — o sistema não gera QR. ' +
          'Confirme o pagamento manualmente quando a cliente pagar.',
      );
    }
  }

  /**
   * Confirmação MANUAL de pagamento pra lojas com pixProvider='externo'
   * (franquias sem gateway). A cliente pagou o PIX por fora (chave da própria
   * loja) e a operadora confirma na mão → marca pago e dispara a separação.
   * NÃO consulta gateway nenhum.
   *
   * Guard: só permitido em loja 'externo'. Numa loja COM gateway isso seria
   * marcar pago "no escuro" — lá a confirmação tem que vir do PagBank/Pagar.me.
   */
  async confirmExternalPayment(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    const session = await this.getSession(cart.sessionId);
    const store = await (this.prisma as any).store.findUnique({
      where: { code: session.liveStoreCode },
      select: { pixProvider: true },
    });
    if ((store as any)?.pixProvider !== 'externo') {
      throw new BadRequestException(
        'Confirmação manual só vale em loja com PIX externo. Esta loja tem gateway — ' +
          'a confirmação tem que vir do pagamento real.',
      );
    }
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: 'reserved' },
    });
    if (!items.length) throw new BadRequestException('Carrinho sem itens reservados');
    // Marca o método pra relatório e dispara o MESMO pipeline pós-pago do
    // gateway (onCartPaid → separação por loja de origem + socket).
    await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: { paymentMethod: 'externo' },
    });
    const paidCart = await this.onCartPaid(cartId);
    return { paid: true, cart: paidCart };
  }

  /**
   * Verifica o pagamento na Pagar.me. Se pago, dispara o pipeline pós-venda.
   * Chamado por polling do frontend enquanto o QR está na tela.
   */
  async checkPayment(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    if (cart.status === 'paid' || cart.status === 'separating' || cart.status === 'shipped' || cart.status === 'delivered') {
      return { paid: true, cart };
    }
    // ANTI-FLOOD: a checagem AO VIVO no gateway (HTTP, cara — PagBank/Pagar.me)
    // roda no MÁXIMO 1x a cada 8s por carrinho. O resto responde do DB (rápido).
    // Blinda o backend do flood de polling (abas antigas). O status vira 'paid'
    // no DB quando a checagem ao vivo detecta → confirma em até ~8s.
    const now = Date.now();
    const allowLive = now - (this.lastLiveCheck.get(cartId) || 0) >= 8000;

    // PIX = PagBank; Link de pagamento = Pagar.me. Consulta o gateway certo.
    let isPaid = false;
    if (cart.paymentMethod === 'link') {
      const payment = await this.pagarme.getPaymentBySale(cartId).catch(() => null);
      isPaid = payment?.status === 'paid';
      if (!isPaid && allowLive && cart.pagarmeOrderId) {
        this.lastLiveCheck.set(cartId, now);
        try {
          const live = await this.pagarme.checkOrderStatus(cart.pagarmeOrderId);
          isPaid = live.isPaid;
        } catch {}
      }
    } else {
      // pix (padrão) → PagBank
      const payment = await this.pagbank.getPaymentBySale(cartId).catch(() => null);
      isPaid = payment?.status === 'paid';
      if (!isPaid && allowLive && cart.pagarmeOrderId) {
        this.lastLiveCheck.set(cartId, now);
        try {
          const live = await this.pagbank.checkOrderStatus(cart.pagarmeOrderId);
          isPaid = live.isPaid;
        } catch {}
      }
    }
    if (!isPaid) return { paid: false, cart };
    const paidCart = await this.onCartPaid(cartId);
    return { paid: true, cart: paidCart };
  }

  /**
   * COBRANÇA MORTA (02/07): QR PIX vence (TTL da sessão) mas o carrinho
   * ficava em 'awaiting_payment' PRA SEMPRE — a cliente tentava pagar um QR
   * recusado pelo banco e ninguém do nosso lado sabia. Este método (cron de
   * 1min) volta a COBRANÇA pra 'open' com aviso em tempo real.
   *
   * RESPEITA a política do dono (25/06): itens/reservas ficam INTACTOS — só
   * o status de cobrança reseta. Quem decide recobrar ou excluir é humano.
   *
   * Segurança: 5min de folga após o vencimento + checkPayment antes de
   * resetar (webhook atrasado de quem pagou no último segundo → vira PAGO
   * normalmente em vez de resetar).
   */
  async expireDeadCharges(): Promise<{ resetados: number }> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    const zumbis: any[] = await (this.prisma as any).livePdvCart.findMany({
      where: { status: 'awaiting_payment', paymentExpiresAt: { lt: cutoff } },
      select: { id: true, sessionId: true, customerName: true },
      take: 50,
    });
    let resetados = 0;
    for (const c of zumbis) {
      try {
        // Última chance: pagou e o webhook atrasou? checkPayment resolve e
        // dispara o pipeline de pago — não reseta.
        const r = await this.checkPayment(c.id).catch(() => ({ paid: false }));
        if ((r as any).paid) continue;
        await (this.prisma as any).livePdvCart.update({
          where: { id: c.id },
          data: {
            status: 'open',
            qrCodeText: null,
            qrCodeImageUrl: null,
            paymentExpiresAt: null,
          },
        });
        resetados++;
        this.gateway.emitToLiveOps('live-pdv:charge-expired', {
          cartId: c.id,
          sessionId: c.sessionId,
          customerName: c.customerName || null,
        });
        this.logger.log(`[charge-expired] carrinho ${c.id} (${c.customerName || 's/nome'}): QR venceu — cobrança resetada pra 'open' (itens intactos)`);
      } catch (e: any) {
        this.logger.warn(`[charge-expired] carrinho ${c.id}: ${e?.message || e}`);
      }
    }
    return { resetados };
  }

  /**
   * Pipeline pós-pagamento: marca pago, gera ordens de separação por loja de
   * origem e avisa cada loja em tempo real.
   */
  async onCartPaid(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    if (['paid', 'separating', 'shipped', 'delivered'].includes(cart.status)) {
      return this.getCart(cartId);
    }
    const now = new Date();
    await (this.prisma as any).livePdvItem.updateMany({
      where: { cartId, status: 'reserved' },
      data: { status: 'paid', paidAt: now },
    });
    await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: { status: 'paid', paidAt: now },
    });

    // Ordem de separação por loja de origem → emite pra cada loja
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: 'paid' },
    });
    const byStore = new Map<string, any[]>();
    for (const it of items as any[]) {
      if (!byStore.has(it.originStoreCode)) byStore.set(it.originStoreCode, []);
      byStore.get(it.originStoreCode)!.push(it);
    }
    const session = await this.getSession(cart.sessionId);
    for (const [storeCode, storeItems] of byStore.entries()) {
      const store = await (this.prisma as any).store.findUnique({ where: { code: storeCode } });
      // marca como em separação
      await (this.prisma as any).livePdvItem.updateMany({
        where: { id: { in: storeItems.map((i: any) => i.id) } },
        data: { status: 'separating' },
      });
      if (store?.id) {
        this.gateway.emitToStore(store.id, 'live-pdv:separation-new', {
          sessionId: session.id,
          cartId,
          storeCode,
          liveStoreCode: session.liveStoreCode,
          liveStoreName: session.liveStoreName,
          customerName: cart.customerName,
          customerPhone: cart.customerPhone,
          count: storeItems.length,
          items: storeItems.map((i: any) => ({
            id: i.id,
            ref: i.refCode,
            descricao: i.descricao,
            cor: i.cor,
            tamanho: i.tamanho,
            qty: i.qty,
          })),
        });
      }
    }
    await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: { status: 'separating' },
    });
    this.gateway.emitToLiveOps('live-pdv:cart-paid', { sessionId: session.id, cartId });
    return this.getCart(cartId);
  }

  // ─── Painel da loja de origem (separação/expedição) ───────────────────────────
  async storeQueue(storeCode: string) {
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { originStoreCode: storeCode, status: { in: ['separating', 'shipped'] } },
      orderBy: { paidAt: 'asc' },
    });
    const cartIds = Array.from(new Set(items.map((i: any) => i.cartId)));
    const carts = cartIds.length
      ? await (this.prisma as any).livePdvCart.findMany({ where: { id: { in: cartIds } } })
      : [];
    const cartById = new Map<string, any>(carts.map((c: any) => [c.id, c]));
    // agrupa por carrinho
    const groups = new Map<string, any>();
    for (const it of items as any[]) {
      const c = cartById.get(it.cartId);
      if (!groups.has(it.cartId)) {
        groups.set(it.cartId, {
          cartId: it.cartId,
          customerName: c?.customerName,
          customerPhone: c?.customerPhone,
          customerInstagram: c?.customerInstagram,
          customerCpf: c?.customerCpf || null,
          paidAt: c?.paidAt,
          items: [],
        });
      }
      groups.get(it.cartId).items.push(it);
    }
    return Array.from(groups.values());
  }

  async markSeparated(itemId: string) {
    const item = await (this.prisma as any).livePdvItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item não encontrado');
    return (this.prisma as any).livePdvItem.update({
      where: { id: itemId },
      data: { separatedAt: new Date() },
    });
  }

  /**
   * Despacho pela loja de origem: marca shipped, gera transferência interna
   * (origem → loja da live) e a obrigação intercompany (÷2,5) p/ conciliação.
   */
  async markShipped(input: { itemId: string; trackingCode?: string; userId?: string | null }) {
    const item = await (this.prisma as any).livePdvItem.findUnique({ where: { id: input.itemId } });
    if (!item) throw new NotFoundException('Item não encontrado');
    if (item.status === 'shipped' || item.status === 'delivered') {
      return item;
    }
    const session = await this.getSession(item.sessionId);
    const fromStore = await (this.prisma as any).store.findUnique({ where: { code: item.originStoreCode } });
    const toStore = await (this.prisma as any).store.findUnique({ where: { code: session.liveStoreCode } });

    // 1) Transferência interna (registro contábil origem → loja da live)
    const transfer = await (this.prisma as any).transferOrder.create({
      data: {
        tipo: 'LIVE',
        refCode: item.refCode,
        codigoBipado: item.codigoBipado,
        descricao: item.descricao,
        cor: item.cor,
        tamanho: item.tamanho,
        qtyOrigem: item.qty,
        lojaOrigemCode: fromStore?.code || item.originStoreCode,
        lojaOrigemName: fromStore?.name || item.originStoreName,
        lojaDestinoCode: toStore?.code || session.liveStoreCode,
        lojaDestinoName: toStore?.name || session.liveStoreName,
        solicitanteNome: 'LIVE COMMERCE',
        mensagem: `Live ${session.title} — venda expedida${input.trackingCode ? ` (rastreio ${input.trackingCode})` : ''}`,
        createdByUserId: input.userId || null,
      },
    });

    // 2) Obrigação intercompany (÷2,5) — só quando tipos diferem (REDE↔FILIAL),
    //    seguindo a mesma regra do módulo financeiro.
    let obligationId: string | null = null;
    const fromTipo = fromStore?.tipo === 'FILIAL' ? 'FILIAL' : 'REDE';
    const toTipo = toStore?.tipo === 'FILIAL' ? 'FILIAL' : 'REDE';
    if (fromTipo !== toTipo) {
      // Conciliação usa o preço CHEIO (base), não o promocional da live.
      const baseCents = item.basePriceCents || item.priceCents;
      const precoTotal = (baseCents * item.qty) / 100;
      const valorObrigacao = precoTotal / this.DIVISOR_CUSTO;
      const mesReferencia = new Date().toISOString().slice(0, 7); // YYYY-MM
      const obl = await (this.prisma as any).interStoreObligation.create({
        data: {
          transferOrderId: transfer.id,
          fromStoreCode: fromStore?.code || item.originStoreCode,
          fromStoreName: fromStore?.name || item.originStoreName,
          fromStoreTipo: fromTipo,
          toStoreCode: toStore?.code || session.liveStoreCode,
          toStoreName: toStore?.name || session.liveStoreName,
          toStoreTipo: toTipo,
          refCode: item.refCode,
          sku: item.codigoBipado,
          cor: item.cor,
          tamanho: item.tamanho,
          descricao: item.descricao,
          qty: item.qty,
          precoUnitario: baseCents / 100,
          precoTotal,
          divisor: this.DIVISOR_CUSTO,
          valorObrigacao,
          mesReferencia,
          status: 'pending',
        },
      });
      obligationId = obl.id;
    }

    const updated = await (this.prisma as any).livePdvItem.update({
      where: { id: input.itemId },
      data: {
        status: 'shipped',
        shippedAt: new Date(),
        trackingCode: input.trackingCode || null,
        transferOrderId: transfer.id,
        obligationId,
      },
    });

    await this.maybeAdvanceCart(item.cartId);
    this.gateway.emitToLiveOps('live-pdv:item-shipped', {
      cartId: item.cartId,
      itemId: input.itemId,
      transferOrderId: transfer.id,
    });
    return updated;
  }

  async markDelivered(itemId: string) {
    const item = await (this.prisma as any).livePdvItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item não encontrado');
    const updated = await (this.prisma as any).livePdvItem.update({
      where: { id: itemId },
      data: { status: 'delivered', deliveredAt: new Date() },
    });
    await this.maybeAdvanceCart(item.cartId);
    return updated;
  }

  /** Avança o status do carrinho quando todos os itens chegam no mesmo estágio. */
  private async maybeAdvanceCart(cartId: string) {
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { cartId, status: { notIn: ['cancelled', 'expired'] } },
    });
    if (!items.length) return;
    const allShipped = (items as any[]).every((i) => ['shipped', 'delivered'].includes(i.status));
    const allDelivered = (items as any[]).every((i) => i.status === 'delivered');
    let status: string | null = null;
    if (allDelivered) status = 'delivered';
    else if (allShipped) status = 'shipped';
    if (status) {
      await (this.prisma as any).livePdvCart.update({ where: { id: cartId }, data: { status } });
      this.gateway.emitToLiveOps('live-pdv:cart-status', { cartId, status });
    }
  }

  // ─── Dashboard ──────────────────────────────────────────────────────────────
  async dashboard(sessionId: string) {
    const session = await this.getSession(sessionId);
    const carts = await (this.prisma as any).livePdvCart.findMany({
      where: { sessionId, status: { not: 'cancelled' } },
    });
    const items = await (this.prisma as any).livePdvItem.findMany({
      where: { sessionId, status: { notIn: ['cancelled', 'expired'] } },
    });
    const paidStatuses = ['paid', 'separating', 'shipped', 'delivered'];
    const paidCarts = (carts as any[]).filter((c) => paidStatuses.includes(c.status));
    const paidItems = (items as any[]).filter((i) => paidStatuses.includes(i.status));

    const faturamentoCents = paidCarts.reduce((s, c) => s + (c.totalCents || 0), 0);
    const pecasVendidas = paidItems.reduce((s, i) => s + (i.qty || 0), 0);
    const clientesAtendidas = new Set((carts as any[]).map((c) => c.customerId || c.id)).size;

    // produtos mais vendidos
    const prodMap = new Map<string, { ref: string; descricao: string; qty: number; valorCents: number }>();
    for (const i of paidItems) {
      const cur = prodMap.get(i.refCode) || { ref: i.refCode, descricao: i.descricao || i.refCode, qty: 0, valorCents: 0 };
      cur.qty += i.qty || 0;
      cur.valorCents += (i.priceCents || 0) * (i.qty || 0);
      prodMap.set(i.refCode, cur);
    }
    const topProducts = Array.from(prodMap.values()).sort((a, b) => b.qty - a.qty).slice(0, 10);

    return {
      session,
      kpis: {
        clientesAtendidas,
        pedidosCriados: carts.length,
        pedidosPagos: paidCarts.length,
        faturamentoCents,
        ticketMedioCents: paidCarts.length ? Math.round(faturamentoCents / paidCarts.length) : 0,
        pecasVendidas,
        reservasAtivas: (items as any[]).filter((i) => i.status === 'reserved').length,
        conversao: carts.length ? Math.round((paidCarts.length / carts.length) * 100) : 0,
      },
      topProducts,
    };
  }

  // ─── Expiração de reservas (chamado pelo cron) ────────────────────────────────
  async expireReservations(): Promise<number> {
    const now = new Date();
    const expired = await (this.prisma as any).livePdvItem.findMany({
      where: { status: 'reserved', expiresAt: { lt: now } },
      select: { id: true, cartId: true },
    });
    if (!expired.length) return 0;
    await (this.prisma as any).livePdvItem.updateMany({
      where: { id: { in: expired.map((e: any) => e.id) } },
      data: { status: 'expired', cancelledAt: now, cancelReason: 'TTL expirado' },
    });
    const cartIds = Array.from(new Set<string>(expired.map((e: any) => e.cartId as string)));
    for (const cartId of cartIds) {
      await this.recalcCart(cartId).catch(() => {});
    }
    this.gateway.emitToLiveOps('live-pdv:reservations-expired', { count: expired.length, cartIds });
    this.logger.log(`[live-pdv] ${expired.length} reservas expiradas liberadas`);
    return expired.length;
  }
}
