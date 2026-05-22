import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductRegistrationService } from '../product-registration/product-registration.service';

/**
 * PurchaseOrdersService — pedidos de compra do fornecedor.
 *
 * Fluxo:
 *   1) Cria pedido (header + items REF×COR×grade-tamanhos com QTYs)
 *   2) Pedido fica status='rascunho' ou 'aguardando' (vendedora pode editar)
 *   3) Mercadoria chega → tela de conferência
 *      - Modo rápido: "Recebi tudo igual ao pedido" (copia tamanhosQty pra tamanhosQtyRecebida)
 *      - Modo detalhado: ajusta qty por tamanho
 *   4) Confirma recebimento → AUTO-CADASTRA no Wincred:
 *      - Pra cada item: pra cada (cor, tamanho) com qty > 0:
 *        - Gera EAN-13 (prefixo 8 sequencial)
 *        - Insere produto no Wincred (descricao gerada: GRUPO + SUBGRUPO + PLUS SIZE + REF + COR + TAM + MARCA)
 *        - Já entra com estoque inicial = qty recebida
 *      - Guarda CODIGOs gerados em skusGerados (JSON) pra rastreabilidade + etiquetas
 *   5) Etiquetas: 1 por peça física (qty × etiquetas) com EAN + REF + COR + TAM + preço
 */
@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly productReg: ProductRegistrationService,
  ) {}

  // ── Categorias (mapeamento descrição → grupo/subgrupo) ──

  async listarCategorias() {
    return (this.prisma as any).categoriaProduto.findMany({
      orderBy: { descricaoBase: 'asc' },
    });
  }

  // Diagnostico dos lookups — util quando o dropdown vem vazio
  async diagnoseLookups() {
    const out: any = {
      timestamp: new Date().toISOString(),
      grupos: null, gruposCount: 0, gruposError: null,
      subgrupos: null, subgruposCount: 0, subgruposError: null,
      fornecedores: null, fornecedoresCount: 0, fornecedoresError: null,
    };
    try {
      const g = await this.erp.listarGrupos();
      out.grupos = g.slice(0, 5);
      out.gruposCount = g.length;
    } catch (e: any) {
      out.gruposError = e?.message || String(e);
    }
    try {
      if (out.grupos && out.grupos.length > 0) {
        const sg = await this.erp.listarSubgrupos(out.grupos[0].codigo);
        out.subgrupos = sg.slice(0, 5);
        out.subgruposCount = sg.length;
        out.subgruposGrupoTestado = out.grupos[0].codigo;
      }
    } catch (e: any) {
      out.subgruposError = e?.message || String(e);
    }
    try {
      const f = await this.erp.listarFornecedores(10);
      out.fornecedores = f.slice(0, 5);
      out.fornecedoresCount = f.length;
    } catch (e: any) {
      out.fornecedoresError = e?.message || String(e);
    }
    return out;
  }

  async upsertCategoria(input: {
    descricaoBase: string;
    grupoCode: number;
    grupoNome: string;
    subgrupoCode: number;
    subgrupoNome: string;
    ncmDefault?: string;
    cfopDefault?: string;
    plusSizeDefault?: boolean;
    userId?: string;
  }) {
    const desc = (input.descricaoBase || '').trim().toUpperCase();
    if (!desc) throw new BadRequestException('Descrição obrigatória');
    if (!input.grupoCode || !input.subgrupoCode) {
      throw new BadRequestException('Grupo e Subgrupo obrigatórios');
    }
    return (this.prisma as any).categoriaProduto.upsert({
      where: { descricaoBase: desc },
      create: {
        descricaoBase: desc,
        grupoCode: input.grupoCode,
        grupoNome: input.grupoNome,
        subgrupoCode: input.subgrupoCode,
        subgrupoNome: input.subgrupoNome,
        ncmDefault: input.ncmDefault || null,
        cfopDefault: input.cfopDefault || '5102',
        plusSizeDefault: input.plusSizeDefault ?? true,
        createdByUserId: input.userId || null,
      },
      update: {
        grupoCode: input.grupoCode,
        grupoNome: input.grupoNome,
        subgrupoCode: input.subgrupoCode,
        subgrupoNome: input.subgrupoNome,
        ncmDefault: input.ncmDefault || null,
        cfopDefault: input.cfopDefault || '5102',
        plusSizeDefault: input.plusSizeDefault ?? true,
      },
    });
  }

  async deleteCategoria(descricaoBase: string) {
    const desc = (descricaoBase || '').trim().toUpperCase();
    await (this.prisma as any).categoriaProduto.delete({
      where: { descricaoBase: desc },
    });
    return { ok: true };
  }

  // ── CRUD pedido ──

  async list(filters: { status?: string; fornecedor?: string; search?: string } = {}) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.fornecedor?.trim()) {
      where.fornecedorNome = { contains: filters.fornecedor.trim(), mode: 'insensitive' };
    }
    if (filters.search?.trim()) {
      const q = filters.search.trim();
      where.OR = [
        { fornecedorNome: { contains: q, mode: 'insensitive' } },
        { nfNumero: { contains: q, mode: 'insensitive' } },
        { marca: { contains: q, mode: 'insensitive' } },
      ];
    }
    return (this.prisma as any).purchaseOrder.findMany({
      where,
      orderBy: { dataPedido: 'desc' },
      include: {
        _count: { select: { items: true } },
      },
    });
  }

  async getById(id: string) {
    const o = await (this.prisma as any).purchaseOrder.findUnique({
      where: { id },
      include: {
        items: { orderBy: [{ ref: 'asc' }, { cor: 'asc' }] },
      },
    });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    // Parse tamanhosQty JSON → object pra facilitar no front
    o.items = (o.items as any[]).map((it: any) => ({
      ...it,
      tamanhosQty: it.tamanhosQty ? JSON.parse(it.tamanhosQty) : {},
      tamanhosQtyRecebida: it.tamanhosQtyRecebida ? JSON.parse(it.tamanhosQtyRecebida) : null,
      skusGerados: it.skusGerados ? JSON.parse(it.skusGerados) : null,
    }));
    return o;
  }

  async create(input: {
    fornecedorNome: string;
    fornecedorCnpj?: string;
    marca?: string;
    dataPrevista?: string;
    nfNumero?: string;
    observacoes?: string;
    items?: Array<{
      ref: string;
      descricaoBase: string;
      cor: string;
      grupoCode?: number;
      grupoNome?: string;
      subgrupoCode?: number;
      subgrupoNome?: string;
      ncm?: string;
      cfop?: string;
      plusSize?: boolean;
      custoUnit: number;
      precoUnit: number;
      tributoPct?: number;
      descontoPct?: number;
      tamanhosQty: Record<string, number>;
    }>;
  }, userId?: string) {
    if (!input.fornecedorNome?.trim()) {
      throw new BadRequestException('Fornecedor obrigatório');
    }
    const order = await (this.prisma as any).purchaseOrder.create({
      data: {
        fornecedorNome: input.fornecedorNome.trim().toUpperCase(),
        fornecedorCnpj: input.fornecedorCnpj?.replace(/\D/g, '') || null,
        marca: input.marca?.trim().toUpperCase() || null,
        dataPrevista: input.dataPrevista ? new Date(input.dataPrevista) : null,
        nfNumero: input.nfNumero?.trim() || null,
        observacoes: input.observacoes?.trim() || null,
        status: 'rascunho',
        createdByUserId: userId || null,
      },
    });
    if (input.items?.length) {
      for (const it of input.items) {
        await this.addItem(order.id, it);
      }
    }
    return this.getById(order.id);
  }

  async update(id: string, input: any) {
    await this.getById(id);
    const data: any = {};
    if (input.fornecedorNome !== undefined) data.fornecedorNome = input.fornecedorNome.trim().toUpperCase();
    if (input.fornecedorCnpj !== undefined) data.fornecedorCnpj = input.fornecedorCnpj?.replace(/\D/g, '') || null;
    if (input.marca !== undefined) data.marca = input.marca?.trim().toUpperCase() || null;
    if (input.dataPrevista !== undefined) data.dataPrevista = input.dataPrevista ? new Date(input.dataPrevista) : null;
    if (input.nfNumero !== undefined) data.nfNumero = input.nfNumero?.trim() || null;
    if (input.observacoes !== undefined) data.observacoes = input.observacoes?.trim() || null;
    if (input.status !== undefined) data.status = input.status;
    await (this.prisma as any).purchaseOrder.update({ where: { id }, data });
    return this.getById(id);
  }

  async delete(id: string, force = false) {
    const o = await this.getById(id);
    if (o.status === 'recebido' && !force) {
      throw new BadRequestException('Não dá pra excluir pedido já recebido. Cancele em vez disso, ou passe ?force=true.');
    }
    await (this.prisma as any).purchaseOrder.delete({ where: { id } });
    return { ok: true };
  }

  // ── Items ──

  async addItem(orderId: string, input: {
    ref: string;
    descricaoBase: string;
    cor: string;
    grupoCode?: number;
    grupoNome?: string;
    subgrupoCode?: number;
    subgrupoNome?: string;
    ncm?: string;
    cfop?: string;
    plusSize?: boolean;
    custoUnit: number;
    precoUnit: number;
    tributoPct?: number;
    descontoPct?: number;
    tamanhosQty: Record<string, number>;
  }) {
    if (!input.ref?.trim()) throw new BadRequestException('REF obrigatória');
    if (!input.cor?.trim()) throw new BadRequestException('COR obrigatória');
    if (!input.custoUnit || !input.precoUnit) {
      throw new BadRequestException('Custo e Preço obrigatórios');
    }
    if (!input.tamanhosQty || Object.keys(input.tamanhosQty).length === 0) {
      throw new BadRequestException('Informe ao menos 1 tamanho com qty');
    }
    const it = await (this.prisma as any).purchaseOrderItem.create({
      data: {
        orderId,
        ref: input.ref.trim().toUpperCase(),
        descricaoBase: input.descricaoBase.trim().toUpperCase(),
        cor: input.cor.trim().toUpperCase(),
        grupoCode: input.grupoCode || null,
        grupoNome: input.grupoNome?.trim().toUpperCase() || null,
        subgrupoCode: input.subgrupoCode || null,
        subgrupoNome: input.subgrupoNome?.trim().toUpperCase() || null,
        ncm: input.ncm?.trim() || null,
        cfop: input.cfop?.trim() || '5102',
        plusSize: input.plusSize ?? true,
        custoUnit: Number(input.custoUnit),
        precoUnit: Number(input.precoUnit),
        tributoPct: Number(input.tributoPct || 0),
        descontoPct: Number(input.descontoPct || 0),
        tamanhosQty: JSON.stringify(input.tamanhosQty),
      },
    });
    await this.recalcOrderTotals(orderId);
    return it;
  }

  async updateItem(itemId: string, input: any) {
    const existing = await (this.prisma as any).purchaseOrderItem.findUnique({
      where: { id: itemId },
    });
    if (!existing) throw new NotFoundException('Item não encontrado');
    const data: any = {};
    if (input.ref !== undefined) data.ref = input.ref.trim().toUpperCase();
    if (input.descricaoBase !== undefined) data.descricaoBase = input.descricaoBase.trim().toUpperCase();
    if (input.cor !== undefined) data.cor = input.cor.trim().toUpperCase();
    if (input.grupoCode !== undefined) data.grupoCode = input.grupoCode || null;
    if (input.grupoNome !== undefined) data.grupoNome = input.grupoNome?.trim().toUpperCase() || null;
    if (input.subgrupoCode !== undefined) data.subgrupoCode = input.subgrupoCode || null;
    if (input.subgrupoNome !== undefined) data.subgrupoNome = input.subgrupoNome?.trim().toUpperCase() || null;
    if (input.ncm !== undefined) data.ncm = input.ncm?.trim() || null;
    if (input.cfop !== undefined) data.cfop = input.cfop?.trim() || '5102';
    if (input.plusSize !== undefined) data.plusSize = input.plusSize;
    if (input.custoUnit !== undefined) data.custoUnit = Number(input.custoUnit);
    if (input.precoUnit !== undefined) data.precoUnit = Number(input.precoUnit);
    if (input.tributoPct !== undefined) data.tributoPct = Number(input.tributoPct);
    if (input.descontoPct !== undefined) data.descontoPct = Number(input.descontoPct);
    if (input.tamanhosQty !== undefined) data.tamanhosQty = JSON.stringify(input.tamanhosQty);
    const updated = await (this.prisma as any).purchaseOrderItem.update({
      where: { id: itemId },
      data,
    });
    await this.recalcOrderTotals(existing.orderId);
    return updated;
  }

  async deleteItem(itemId: string) {
    const existing = await (this.prisma as any).purchaseOrderItem.findUnique({
      where: { id: itemId },
    });
    if (!existing) throw new NotFoundException('Item não encontrado');
    await (this.prisma as any).purchaseOrderItem.delete({ where: { id: itemId } });
    await this.recalcOrderTotals(existing.orderId);
    return { ok: true };
  }

  // ── Recalcula totais do pedido ──

  private async recalcOrderTotals(orderId: string) {
    const items = await (this.prisma as any).purchaseOrderItem.findMany({
      where: { orderId },
    });
    let totalPecas = 0;
    let totalCusto = 0;
    let totalLiquido = 0;
    let totalVenda = 0;
    for (const it of items) {
      const tams = it.tamanhosQty ? JSON.parse(it.tamanhosQty) : {};
      const qty = Object.values(tams).reduce<number>((s: number, v: any) => s + (Number(v) || 0), 0);
      totalPecas += qty;
      const bruto = qty * (Number(it.custoUnit) || 0);
      const desconto = bruto * (Number(it.descontoPct || 0) / 100);
      const liquido = bruto - desconto;
      totalCusto += bruto;
      totalLiquido += liquido;
      totalVenda += qty * (Number(it.precoUnit) || 0);
    }
    await (this.prisma as any).purchaseOrder.update({
      where: { id: orderId },
      data: { totalPecas, totalCusto, totalLiquido, totalVenda },
    });
  }

  // ── Recebimento + Auto-cadastro ──

  /**
   * Confirma recebimento da mercadoria. Modos:
   *  - Sem `itemsRecebidos`: assume qty recebida = qty pedida (tudo igual)
   *  - Com `itemsRecebidos`: aceita qty ajustada por item (ex: chegou menos)
   *
   * Após marcar como recebido, dispara AUTO-CADASTRO no Wincred via
   * ProductRegistrationService.processar() pra CADA item.
   */
  async receive(
    orderId: string,
    input: {
      itemsRecebidos?: Array<{
        itemId: string;
        tamanhosQty: Record<string, number>;
      }>;
    },
    userId?: string,
  ) {
    const order = await this.getById(orderId);
    if (order.status === 'recebido') {
      throw new BadRequestException('Pedido já foi recebido');
    }
    if (order.status === 'cancelado') {
      throw new BadRequestException('Pedido cancelado — não pode receber');
    }

    const itemsRecebidosMap = new Map<string, Record<string, number>>();
    for (const ir of input.itemsRecebidos || []) {
      itemsRecebidosMap.set(ir.itemId, ir.tamanhosQty);
    }

    // Atualiza qty recebida em cada item (fallback: qty pedida)
    const log: any[] = [];
    let totalSkusInseridos = 0;
    let totalSkusJaExistiam = 0;
    let totalPecas = 0;
    const errors: string[] = [];

    for (const it of order.items as any[]) {
      const qtdRecebida = itemsRecebidosMap.get(it.id) || it.tamanhosQty;
      const cores = [it.cor];
      const tamanhos = Object.keys(qtdRecebida).filter((t) => Number(qtdRecebida[t]) > 0);
      const qtdTotal = Object.values(qtdRecebida).reduce<number>(
        (s: number, v: any) => s + (Number(v) || 0),
        0,
      );
      totalPecas += qtdTotal;

      // Atualiza item no banco
      await (this.prisma as any).purchaseOrderItem.update({
        where: { id: it.id },
        data: {
          tamanhosQtyRecebida: JSON.stringify(qtdRecebida),
          itemStatus: 'recebido',
        },
      });

      if (tamanhos.length === 0) {
        log.push({ itemId: it.id, ref: it.ref, cor: it.cor, status: 'sem_qty', skipped: true });
        continue;
      }

      // Validação: precisa de grupo+subgrupo pra cadastrar
      if (!it.grupoCode || !it.grupoNome || !it.subgrupoCode) {
        const err = `Item ${it.ref} ${it.cor}: faltando Grupo/Subgrupo — não cadastrado no Wincred`;
        errors.push(err);
        log.push({ itemId: it.id, ref: it.ref, cor: it.cor, status: 'erro', error: err });
        continue;
      }

      // AUTO-CADASTRA via ProductRegistrationService.processar()
      // OBS: interface PreviewInput tem tipos específicos:
      //   - cfop: number (não string)
      //   - tributo: string (alíquota como texto, ex: "6")
      //   - NÃO tem campo descricao (a descrição é gerada por concatenação dentro do processar)
      try {
        const r = await this.productReg.processar({
          ref: it.ref,
          grupoCodigo: it.grupoCode,
          grupoNome: it.grupoNome,
          subgrupoCodigo: it.subgrupoCode,
          subgrupoNome: it.subgrupoNome,
          fornecedorCnpj: order.fornecedorCnpj || '',
          fornecedorNome: order.marca || order.fornecedorNome,
          cores,
          tamanhos,
          custo: it.custoUnit,
          precoVenda: it.precoUnit,
          tributo: it.tributoPct != null ? String(it.tributoPct) : undefined,
          plusSize: it.plusSize,
          ncm: it.ncm || undefined,
          cfop: it.cfop ? Number(it.cfop) : 5102,
          marca: order.marca || order.fornecedorNome,
        });

        // Estende com qtd recebida + atualiza estoque inicial via increaseStock
        const skusGerados: any[] = [];
        for (const item of r.itens) {
          const qty = Number(qtdRecebida[item.tamanho] || 0);
          skusGerados.push({
            codigo: item.codigo,
            cor: item.cor,
            tamanho: item.tamanho,
            descricao: item.descricaoCompleta,
            qty,
          });
        }

        // Aumenta estoque no Wincred — loja matriz (definida em env PRIMARY_STORE_CODE
        // ou 01 como default). As pecas entram diretamente nessa loja.
        const lojaMatriz = process.env.PRIMARY_STORE_CODE || '01';
        const itemsParaEstoque = skusGerados
          .filter((s) => s.qty > 0)
          .map((s) => ({ sku: s.codigo, qty: s.qty, storeCode: lojaMatriz }));
        if (itemsParaEstoque.length > 0) {
          try {
            const inc = await (this.erp as any).increaseStock?.(itemsParaEstoque);
            if (inc && !inc.success) {
              this.logger.warn(`[purchase-orders] estoque inicial nao aplicado: ${inc.error}`);
            } else {
              this.logger.log(`[purchase-orders] estoque inicial: ${itemsParaEstoque.length} SKUs na loja ${lojaMatriz}`);
            }
          } catch (e: any) {
            this.logger.warn(`[purchase-orders] increaseStock falhou: ${e?.message}`);
          }
        }

        totalSkusInseridos += r.inseridos;
        totalSkusJaExistiam += r.ignorados;

        await (this.prisma as any).purchaseOrderItem.update({
          where: { id: it.id },
          data: { skusGerados: JSON.stringify(skusGerados) },
        });

        log.push({
          itemId: it.id,
          ref: it.ref,
          cor: it.cor,
          status: 'ok',
          inseridos: r.inseridos,
          ignorados: r.ignorados,
          total: r.total,
        });
      } catch (e: any) {
        const err = `Item ${it.ref} ${it.cor}: ${e?.message || e}`;
        errors.push(err);
        log.push({ itemId: it.id, ref: it.ref, cor: it.cor, status: 'erro', error: err });
        this.logger.error(`[purchase-orders] erro ao processar item ${it.id}: ${e?.message}`);
      }
    }

    // Atualiza pedido como recebido
    await (this.prisma as any).purchaseOrder.update({
      where: { id: orderId },
      data: {
        status: errors.length === 0 ? 'recebido' : 'recebido_com_erro',
        recebidoAt: new Date(),
        recebidoByUserId: userId || null,
        cadastroLog: JSON.stringify({
          totalPecas,
          totalSkusInseridos,
          totalSkusJaExistiam,
          errors,
          items: log,
          ts: new Date().toISOString(),
        }),
      },
    });

    this.logger.log(
      `[purchase-orders] Pedido ${orderId} recebido: ${totalSkusInseridos} SKUs novos, ` +
      `${totalSkusJaExistiam} já existiam, ${totalPecas} peças totais, ${errors.length} erros`,
    );

    return {
      ok: errors.length === 0,
      totalPecas,
      totalSkusInseridos,
      totalSkusJaExistiam,
      errors,
      log,
    };
  }

  // ── Etiquetas ──

  /**
   * Gera lista de etiquetas pra imprimir.
   * Cada (REF + COR + TAM) com qty=N vira N entradas iguais (1 etiqueta por peça).
   */
  async listLabels(orderId: string) {
    const order = await this.getById(orderId);
    if (order.status !== 'recebido' && order.status !== 'recebido_com_erro') {
      throw new BadRequestException('Pedido ainda não foi recebido');
    }
    const labels: Array<{
      ref: string;
      cor: string;
      tamanho: string;
      codigo: string;
      preco: number;
      marca: string | null;
      descricao: string;
    }> = [];
    for (const it of order.items as any[]) {
      if (!it.skusGerados) continue;
      for (const sku of it.skusGerados as any[]) {
        for (let i = 0; i < (sku.qty || 0); i++) {
          labels.push({
            ref: it.ref,
            cor: sku.cor,
            tamanho: sku.tamanho,
            codigo: sku.codigo,
            preco: it.precoUnit,
            marca: order.marca,
            descricao: sku.descricao,
          });
        }
      }
    }
    return { total: labels.length, labels };
  }

  /**
   * Busca produtos no Wincred por EAN/REF/SKU pra imprimir etiquetas avulsas.
   */
  async buscarEtiquetasAvulsas(codigos: string[]) {
    const limpos = (codigos || [])
      .map((c) => (c || '').trim().toUpperCase())
      .filter(Boolean);
    if (limpos.length === 0) {
      return { labels: [], notFound: [] };
    }
    const labels: Array<{
      ref: string;
      cor: string;
      tamanho: string;
      codigo: string;
      preco: number;
      marca: string | null;
      descricao: string;
    }> = [];
    const notFound: string[] = [];
    for (const cod of limpos) {
      try {
        const found = await (this.erp as any).buscarProdutoPorCodigo?.(cod);
        if (found && Array.isArray(found) && found.length > 0) {
          for (const p of found) {
            labels.push({
              ref: String(p.referencia || '').trim(),
              cor: String(p.cor || '').trim(),
              tamanho: String(p.tamanho || '').trim(),
              codigo: String(p.codigo || '').trim(),
              preco: Number(p.preco || 0),
              marca: p.marca || null,
              descricao: String(p.descricao || '').trim(),
            });
          }
        } else {
          notFound.push(cod);
        }
      } catch {
        notFound.push(cod);
      }
    }
    return { labels, notFound };
  }

  /**
   * Busca produtos no Wincred por REF ou DESCRICAO (LIKE). Limit 100.
   */
  async reposicaoBuscar(q: string) {
    const termo = (q || '').trim();
    if (termo.length < 2) return [];
    try {
      const pool = (this.erp as any).pool;
      if (!pool) return [];
      // Normaliza: remove hifens, espacos e UPPERCASE pra busca tolerante
      const normalizado = termo.toUpperCase().replace(/[\s\-]/g, '');
      const likeOrig = `%${termo.toUpperCase()}%`;
      const likeNorm = `%${normalizado}%`;
      // Tenta variacoes: campo original (com hifen) E campo normalizado (sem hifen)
      const [rows] = await pool.query(
        `SELECT CODIGO AS codigo, REFERENCIA AS referencia, COR AS cor,
                TAMANHO AS tamanho, PRECOVENDA AS preco, DESCRICAO AS descricao
           FROM produtos
          WHERE REFERENCIA LIKE ?
             OR DESCRICAO LIKE ?
             OR CODIGO = ?
             OR REPLACE(REPLACE(REFERENCIA, '-', ''), ' ', '') LIKE ?
             OR REPLACE(REPLACE(DESCRICAO, '-', ''), ' ', '') LIKE ?
          ORDER BY REFERENCIA, COR, TAMANHO
          LIMIT 100`,
        [likeOrig, likeOrig, termo, likeNorm, likeNorm],
      );
      return (rows as any[]).map((r) => ({
        codigo: String(r.codigo || '').trim(),
        ref: String(r.referencia || '').trim(),
        cor: String(r.cor || '').trim(),
        tamanho: String(r.tamanho || '').trim(),
        preco: Number(r.preco || 0),
        descricao: String(r.descricao || '').trim(),
      }));
    } catch (e: any) {
      this.logger.warn(`reposicaoBuscar falhou: ${e?.message}`);
      return [];
    }
  }

  /**
   * Confirma reposicao: increaseStock + retorna labels pra impressao.
   */
  async reposicaoConfirmar(
    items: Array<{ codigo: string; qty: number; lojaCode?: string }>,
  ) {
    const validos = (items || []).filter((i) => i.codigo && i.qty > 0);
    if (validos.length === 0) {
      return { ok: false, error: 'Nenhum item valido', labels: [] };
    }
    const lojaMatriz = process.env.PRIMARY_STORE_CODE || '01';
    const itemsParaEstoque = validos.map((i) => ({
      sku: i.codigo,
      qty: i.qty,
      storeCode: i.lojaCode || lojaMatriz,
    }));

    let stockResult: any = { success: false, applied: [] };
    try {
      stockResult = await (this.erp as any).increaseStock?.(itemsParaEstoque);
    } catch (e: any) {
      this.logger.error(`reposicao increaseStock falhou: ${e?.message}`);
      return { ok: false, error: e?.message || 'Erro estoque', labels: [] };
    }

    const labels: any[] = [];
    for (const i of validos) {
      try {
        const found = await (this.erp as any).buscarProdutoPorCodigo?.(i.codigo);
        if (found && found.length > 0) {
          const p = found[0];
          for (let n = 0; n < i.qty; n++) {
            labels.push({
              ref: String(p.referencia || '').trim(),
              cor: String(p.cor || '').trim(),
              tamanho: String(p.tamanho || '').trim(),
              codigo: String(p.codigo || '').trim(),
              preco: Number(p.preco || 0),
              marca: p.marca || null,
              descricao: String(p.descricao || '').trim(),
            });
          }
        }
      } catch { /* skip */ }
    }

    return {
      ok: stockResult?.success ?? false,
      stockResult,
      labels,
      total: labels.length,
    };
  }
}
