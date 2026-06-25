import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RoutingEngine } from '../routing/routing.engine';
import { PagarmeService } from '../pagarme/pagarme.service';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly routing: RoutingEngine,
    private readonly pagarme: PagarmeService,
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

  // Remove cor/tamanho do nome do produto pro título genérico (igual Consulta).
  private cleanProductName(name: string): string {
    const KNOWN_COLORS = [
      'PRETO', 'BRANCO', 'VERMELHO', 'ROSA', 'AZUL', 'MARINHO', 'MARROM',
      'VINHO', 'VERDE', 'AMARELO', 'LARANJA', 'BEGE', 'CINZA', 'UVA',
      'PINK', 'NUDE', 'CREME', 'CAQUI', 'CARAMELO', 'OFF', 'MOSTARDA',
      'TERRACOTA', 'TIFANNY', 'SALMAO', 'SALMÃO', 'GRAFITE', 'PERVINCA', 'ROYAL', 'MUSGO',
    ];
    let n = String(name || '').trim();
    for (const c of KNOWN_COLORS) {
      n = n.replace(new RegExp(`\\s+${c}\\b`, 'gi'), '');
    }
    n = n.replace(/\s+\b(3[6-9]|[4-7]\d|80)\b/g, '');
    return n.replace(/\s{2,}/g, ' ').trim();
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
   * Estoque ERP por loja pra um item (REF+COR+TAM). Agrega todos os CODIGOs que
   * formam o item. Retorna o mapa loja→qty e o melhor CODIGO (mais estoque) pra
   * baixa futura sem ambiguidade.
   */
  private async erpStockByStoreForItem(
    refCode: string,
    cor: string | null,
    tam: string | null,
  ): Promise<{ byStore: Map<string, number>; codigos: string[]; bestCodigo: string | null }> {
    const rows = await this.erp.searchByRef(refCode);
    const matched = (rows as any[]).filter(
      (r) => this.norm(r.COR) === this.norm(cor) && this.norm(r.TAMANHO) === this.norm(tam),
    );
    const codigos = Array.from(
      new Set(matched.map((r) => String(r.CODIGO || '').trim()).filter(Boolean)),
    );
    const byStore = new Map<string, number>();
    if (codigos.length === 0) return { byStore, codigos, bestCodigo: null };
    const detailed = await this.erp.getStockBySkusDetailed(codigos);
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
   */
  async searchGrade(term: string, sessionId?: string) {
    const q = (term || '').trim();
    if (!q) throw new BadRequestException('Informe referência, código, SKU ou nome');

    // 1) Resolve linhas do produto. Tenta REF, depois CÓDIGO/EAN, depois nome.
    let rows: any[] = await this.erp.searchByRef(q);
    if (!rows.length) rows = await this.erp.searchByCodeAndExpandRef(q);
    if (!rows.length) rows = await this.erp.searchProductsLike(q);
    if (!rows.length) return { found: false, term: q };

    // searchByRef("VLM-222") também traz "VLM-222EST" (LIKE 'VLM-222%'), que é
    // OUTRO produto (estampado). Foco na REF que bate EXATO com o que foi
    // digitado e trago TODAS as cores dela (todas ficam sob a mesma REF no
    // Giga). Se nada bate exato (busca por nome/parcial), cai na 1ª REF.
    const qn = this.norm(q);
    const exact = rows.filter((r) => this.norm(r.REF) === qn);
    const productRows = exact.length
      ? exact
      : rows.filter((r) => this.norm(r.REF) === this.norm(rows[0].REF));
    const ref = String(productRows[0].REF).trim();
    const descricao = this.cleanProductName(productRows[0].DESCRICAOCOMPLETA || ref) || ref;

    // 2) Estoque por loja (1 query batch p/ todos os CODIGOs do produto).
    const codigos = Array.from(
      new Set(productRows.map((r) => String(r.CODIGO || '').trim()).filter(Boolean)),
    );
    const detailed = await this.erp.getStockBySkusDetailed(codigos);
    // Preço pelo serviço do relatório: trata VENDAUN como REAIS (correto p/ Lurd's).
    const prices = await this.pricing.getPricesByCodigos(codigos);
    const refPriceMap = await this.pricing.getPricesByRefs([ref]);
    const refPrice = refPriceMap.get(ref) || 0;
    const storesMap = await this.storesMap();

    // 3) Reservas ativas pra descontar.
    const itemKeys = productRows.map((r) => this.keyOf(ref, r.COR, r.TAMANHO));
    const { byKey, byKeyStore } = await this.committed(Array.from(new Set(itemKeys)));

    // 4) Monta células da grade (cor × tamanho), deduplicando por COR|TAM.
    const cellMap = new Map<string, any>();
    for (const r of productRows) {
      const cor = r.COR ? String(r.COR).trim() : null;
      const tam = r.TAMANHO ? String(r.TAMANHO).trim() : null;
      const itemKey = this.keyOf(ref, cor, tam);
      const codigo = String(r.CODIGO || '').trim();
      let cell = cellMap.get(itemKey);
      if (!cell) {
        cell = {
          itemKey,
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

    // 5) Foto principal (best-effort, por cor).
    const cors = Array.from(new Set(productRows.map((r) => r.COR).filter(Boolean)));
    const photoBatch = await this.photos
      .getBatch(cors.map((c: any) => ({ ref, cor: c })))
      .catch(() => ({} as Record<string, string>));
    const genericPhoto = await this.photos.getPhoto(ref).catch(() => null);

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
    };
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

    // Atualiza itens reservados desse REF (compara normalizado)
    const reserved = await (this.prisma as any).livePdvItem.findMany({
      where: { sessionId, status: 'reserved' },
    });
    const affected = (reserved as any[]).filter((i) => this.norm(i.refCode) === ref);
    const cartIds = new Set<string>();
    for (const it of affected) {
      const novo = promoOn ? Math.round(priceCents) : (it.basePriceCents || it.priceCents);
      if (novo !== it.priceCents) {
        await (this.prisma as any).livePdvItem.update({
          where: { id: it.id },
          data: { priceCents: novo },
        });
        cartIds.add(it.cartId);
      }
    }
    for (const cartId of cartIds) await this.recalcCart(cartId).catch(() => {});

    this.gateway.emitToAdmins('live-pdv:promo', {
      sessionId,
      refCode: ref,
      priceCents: promoOn ? Math.round(priceCents) : null,
      affected: affected.length,
    });

    return { ok: true, refCode: ref, priceCents: promoOn ? Math.round(priceCents) : null, affected: affected.length };
  }

  // ─── Cliente ──────────────────────────────────────────────────────────────
  async quickCustomer(input: {
    name: string;
    phone: string;
    instagram?: string;
    cpf?: string;
    email?: string;
  }) {
    const name = (input.name || '').trim();
    const phone = (input.phone || '').replace(/\D/g, '');
    if (!name) throw new BadRequestException('Nome é obrigatório');
    const ig = (input.instagram || '').trim().replace(/^@/, '') || null;

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
  }) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    const name = (input.name || '').trim();
    if (!name) throw new BadRequestException('Nome é obrigatório');
    const phone = (input.phone || '').replace(/\D/g, '');
    const ig = (input.instagram || '').trim().replace(/^@/, '') || null;
    const cpf = input.cpf ? input.cpf.replace(/\D/g, '') : null;
    const email = input.email?.trim() || null;

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

    const updated = await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: {
        customerId,
        customerName: name,
        customerPhone: phone,
        customerInstagram: ig,
        customerCpf: cpf,
        customerEmail: email,
      },
    });
    this.gateway.emitToAdmins('live-pdv:cart-updated', { cartId, sessionId: cart.sessionId });
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
    if (digits.length >= 3) OR.push({ customerPhone: { contains: digits } });
    const carts = await (this.prisma as any).livePdvCart.findMany({
      where: { customerId: { not: null }, OR },
      distinct: ['customerId'],
      orderBy: { createdAt: 'desc' },
      select: {
        customerId: true,
        customerName: true,
        customerPhone: true,
        customerInstagram: true,
      },
      take: 20,
    });
    return carts.map((c: any) => ({
      customerId: c.customerId,
      name: c.customerName,
      phone: c.customerPhone,
      instagram: c.customerInstagram,
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
    this.gateway.emitToAdmins('live-pdv:cart-updated', { cartId: cart.id, sessionId });
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
    // loja nova quando nenhuma loja já usada cobre. A 1ª peça do carrinho não
    // tem loja prévia → cai no roteamento normal (melhor loja por estoque).
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
      // loja já usada com mais peças primeiro; precisa cobrir a qty desta peça
      const ordered = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      for (const [storeCode] of ordered) {
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

    // Preço (VENDAUN em reais, via serviço do relatório) com fallback por REF
    const priceMap = bestCodigo
      ? await this.pricing.getPricesByCodigos([bestCodigo])
      : new Map<string, number>();
    let priceReais = bestCodigo ? priceMap.get(bestCodigo) || 0 : 0;
    if (priceReais === 0) {
      const refPriceMap = await this.pricing.getPricesByRefs([ref]);
      priceReais = refPriceMap.get(ref) || 0;
    }
    const basePriceCents = this.reaisToCents(priceReais);
    // Aplica preço promocional da live se houver pro REF nessa sessão
    const promo = await this.getPromo(session.id, ref);
    const priceCents = promo != null && promo > 0 ? promo : basePriceCents;

    // Descrição
    const rowsForDesc = await this.erp.searchByRef(ref);
    const descRow = (rowsForDesc as any[]).find(
      (r) => this.norm(r.COR) === this.norm(cor) && this.norm(r.TAMANHO) === this.norm(tam),
    );
    const descricao = descRow?.DESCRICAOCOMPLETA || ref;

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
    this.gateway.emitToAdmins('live-pdv:item-reserved', {
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
    this.gateway.emitToAdmins('live-pdv:item-cancelled', { itemId, cartId: item.cartId });
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
    this.gateway.emitToAdmins('live-pdv:cart-cancelled', { cartId, sessionId: cart.sessionId });
    return { ok: true };
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

    const charge = await this.pagarme.createPixCharge({
      saleId: cartId,
      valor,
      storeCode: session.liveStoreCode,
      storeName: session.liveStoreName,
      customerName: cart.customerName,
      customerCpf: cart.customerCpf || undefined,
      customerPhone: cart.customerPhone || undefined,
      customerEmail: cart.customerEmail || undefined,
      expiresInMinutes: session.reservationTtlMin,
    });

    const updated = await (this.prisma as any).livePdvCart.update({
      where: { id: cartId },
      data: {
        status: 'awaiting_payment',
        paymentMethod: 'pix',
        pagarmeOrderId: charge.pagarmeOrderId,
        qrCodeText: charge.qrCodeText,
        qrCodeImageUrl: charge.qrCodeImageUrl,
        paymentExpiresAt: charge.expiresAt,
      },
    });
    return {
      cart: updated,
      qrCodeText: charge.qrCodeText,
      qrCodeImageUrl: charge.qrCodeImageUrl,
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
   * Verifica o pagamento na Pagar.me. Se pago, dispara o pipeline pós-venda.
   * Chamado por polling do frontend enquanto o QR está na tela.
   */
  async checkPayment(cartId: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    if (cart.status === 'paid' || cart.status === 'separating' || cart.status === 'shipped' || cart.status === 'delivered') {
      return { paid: true, cart };
    }
    const payment = await this.pagarme.getPaymentBySale(cartId).catch(() => null);
    let isPaid = payment?.status === 'paid';
    // fallback: consulta ao vivo
    if (!isPaid && cart.pagarmeOrderId) {
      try {
        const live = await this.pagarme.checkOrderStatus(cart.pagarmeOrderId);
        isPaid = live.isPaid;
      } catch {}
    }
    if (!isPaid) return { paid: false, cart };
    const paidCart = await this.onCartPaid(cartId);
    return { paid: true, cart: paidCart };
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
    this.gateway.emitToAdmins('live-pdv:cart-paid', { sessionId: session.id, cartId });
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
    this.gateway.emitToAdmins('live-pdv:item-shipped', {
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
      this.gateway.emitToAdmins('live-pdv:cart-status', { cartId, status });
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
    this.gateway.emitToAdmins('live-pdv:reservations-expired', { count: expired.length, cartIds });
    this.logger.log(`[live-pdv] ${expired.length} reservas expiradas liberadas`);
    return expired.length;
  }
}
