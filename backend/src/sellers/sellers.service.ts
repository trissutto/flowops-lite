import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * SellersService — CRUD de vendedoras + atribuição de pedido + relatório.
 *
 * Regra de negócio:
 *   - Soft-delete via `active=false` (mantém histórico das vendas atribuídas)
 *   - Nome é UNIQUE (Prisma) — a service normaliza pra evitar "Karine" vs "KARINE"
 *   - Atribuir pedido: grava sellerId + sellerName (cache) + quem/quando
 *   - Relatório: agrupa pedidos por sellerId no período, soma totalAmount e conta
 */
@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Importa funcionarias diretamente do MySQL Wincred (tabela funcionarios).
   * Pega TODAS as funcionarias ativas de TODAS as lojas — diferente do
   * importFromPdvActive() que so pega quem tem whitelist no PDV.
   *
   * Cria como cargo=VENDEDORA por default. Admin ajusta depois.
   * Match por CODIGO (Wincred) — idempotente.
   */
  async importFromWincred(): Promise<{
    created: number;
    skipped: number;
    total: number;
    sample: Array<{ name: string; codigo: string; loja: string }>;
  }> {
    const pool: any = (this.erp as any).pool;
    if (!pool) {
      throw new BadRequestException('MySQL Wincred não conectado');
    }

    let funcionarios: any[] = [];
    try {
      // Tabela funcionarios do Wincred. Colunas variam — tentamos campos comuns.
      // CODIGO + NOME sao garantidos. APELIDO e LOJA variam.
      const [rows] = await pool.query(
        `SELECT CODIGO, NOME, APELIDO, LOJA
           FROM funcionarios
          WHERE NOME IS NOT NULL
            AND TRIM(NOME) <> ''
          ORDER BY LOJA, NOME`,
      );
      funcionarios = rows as any[];
    } catch (e: any) {
      // Fallback: sem APELIDO
      try {
        const [rows] = await pool.query(
          `SELECT CODIGO, NOME, LOJA FROM funcionarios WHERE NOME IS NOT NULL AND TRIM(NOME) <> '' ORDER BY LOJA, NOME`,
        );
        funcionarios = rows as any[];
      } catch (e2: any) {
        throw new BadRequestException(`Erro consultando funcionarios no Wincred: ${e2.message}`);
      }
    }

    if (!funcionarios.length) {
      return { created: 0, skipped: 0, total: 0, sample: [] };
    }

    // Sellers existentes por código pra dedup
    const existing: any[] = await (this.prisma as any).seller.findMany({
      where: { wincredCodigo: { not: null } },
      select: { wincredCodigo: true },
    });
    const existingCodes = new Set(existing.map((s) => String(s.wincredCodigo)));

    let created = 0;
    let skipped = 0;
    const sample: Array<{ name: string; codigo: string; loja: string }> = [];

    for (const f of funcionarios) {
      const codigo = String(f.CODIGO || '').trim();
      const nome = String(f.NOME || '').trim();
      const apelido = String(f.APELIDO || '').trim();
      const loja = String(f.LOJA || '').trim().padStart(2, '0');
      if (!codigo || !nome) {
        skipped++;
        continue;
      }
      if (existingCodes.has(codigo)) {
        skipped++;
        continue;
      }
      // Usa APELIDO se preenchido (mais curto no PDV); senao NOME
      const displayName = (apelido || nome)
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      try {
        await (this.prisma as any).seller.create({
          data: {
            name: displayName,
            wincredCodigo: codigo,
            storeCodeOrigin: loja || null,
            cargo: 'VENDEDORA',
            active: true,
          },
        });
        existingCodes.add(codigo);
        created++;
        if (sample.length < 15) {
          sample.push({ name: displayName, codigo, loja });
        }
      } catch (e: any) {
        // Conflito por nome unique — tenta linkar codigo via UPDATE
        if (e?.code === 'P2002') {
          try {
            await (this.prisma as any).seller.update({
              where: { name: displayName },
              data: { wincredCodigo: codigo, storeCodeOrigin: loja || null },
            });
            existingCodes.add(codigo);
            created++;
          } catch {
            skipped++;
          }
        } else {
          skipped++;
        }
      }
    }

    this.logger.log(
      `[sellers] import Wincred: criadas=${created}, puladas=${skipped}, total=${funcionarios.length}`,
    );
    return { created, skipped, total: funcionarios.length, sample };
  }

  /** Lista vendedoras — por default só ativas. `includeInactive=true` pra admin. */
  async list(includeInactive = false) {
    return this.prisma.seller.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
  }

  /** Detalhe completo do prontuario + documentos. */
  async getById(id: string) {
    const seller: any = await (this.prisma as any).seller.findUnique({
      where: { id },
      include: {
        documents: { orderBy: { uploadedAt: 'desc' } },
      },
    });
    if (!seller) throw new NotFoundException('Vendedora nao encontrada');

    // Resolve loja responsavel (nome) pra UI
    let responsibleStore: any = null;
    if (seller.responsibleStoreId) {
      responsibleStore = await (this.prisma as any).store.findUnique({
        where: { id: seller.responsibleStoreId },
        select: { id: true, code: true, name: true },
      });
    }

    return {
      ...seller,
      responsibleStore,
      horarioTrabalho: seller.horarioTrabalho ? this.tryParseJson(seller.horarioTrabalho) : null,
    };
  }

  private tryParseJson(s: string) {
    try { return JSON.parse(s); } catch { return s; }
  }

  /**
   * Importa funcionarias de PdvActiveSeller (whitelist do PDV das lojas) pra
   * Seller. Cria Sellers que ainda nao existem (match por wincredCodigo).
   * Idempotente: pula quem ja foi importada.
   *
   * Resultado: cria Seller com cargo=VENDEDORA por default. Admin depois
   * ajusta cargo + loja responsavel pra Lideres/Gerentes.
   */
  async importFromPdvActive(): Promise<{
    created: number;
    skipped: number;
    total: number;
    sample: Array<{ name: string; wincredCodigo: string; storeCode: string }>;
  }> {
    const actives: any[] = await (this.prisma as any).pdvActiveSeller.findMany({
      orderBy: [{ storeCode: 'asc' }, { nome: 'asc' }],
    });
    if (!actives.length) {
      return { created: 0, skipped: 0, total: 0, sample: [] };
    }

    // Sellers existentes — index por wincredCodigo pra dedup
    const existing: any[] = await (this.prisma as any).seller.findMany({
      where: { wincredCodigo: { not: null } },
      select: { wincredCodigo: true, name: true },
    });
    const existingCodes = new Set(existing.map((s) => String(s.wincredCodigo)));

    let created = 0;
    let skipped = 0;
    const sample: Array<{ name: string; wincredCodigo: string; storeCode: string }> = [];

    for (const a of actives) {
      const codigo = String(a.codigo || '').trim();
      const nome = String(a.nome || '').trim();
      if (!codigo || !nome) {
        skipped++;
        continue;
      }
      if (existingCodes.has(codigo)) {
        skipped++;
        continue;
      }
      // Normaliza nome (Title Case)
      const normalizedName = nome
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      try {
        await (this.prisma as any).seller.create({
          data: {
            name: normalizedName,
            wincredCodigo: codigo,
            storeCodeOrigin: a.storeCode,
            cargo: 'VENDEDORA',
            active: true,
          },
        });
        existingCodes.add(codigo);
        created++;
        if (sample.length < 10) {
          sample.push({ name: normalizedName, wincredCodigo: codigo, storeCode: a.storeCode });
        }
      } catch (e: any) {
        // Nome ja existe sem wincredCodigo? (caso Karine cadastrada manual e tambem
        // existir no PdvActiveSeller). Tenta UPDATE pra linkar o codigo.
        if (e?.code === 'P2002') {
          try {
            await (this.prisma as any).seller.update({
              where: { name: normalizedName },
              data: { wincredCodigo: codigo, storeCodeOrigin: a.storeCode },
            });
            existingCodes.add(codigo);
            created++;
          } catch {
            skipped++;
          }
        } else {
          skipped++;
        }
      }
    }

    this.logger.log(
      `[sellers] import PdvActive: criados=${created}, pulados=${skipped}, total=${actives.length}`,
    );
    return { created, skipped, total: actives.length, sample };
  }

  async create(input: {
    name: string;
    apelido?: string;
    whatsapp?: string;
    cargo?: string;
    responsibleStoreId?: string | null;
    cpf?: string;
    rg?: string;
    email?: string;
    dataNascimento?: string | null;
    endereco?: string;
    cidade?: string;
    uf?: string;
    cep?: string;
    dataAdmissao?: string | null;
    contratoTipo?: string;
    cargoFuncao?: string;
    salarioBase?: number;
    dataInicioFerias?: string | null;
    dataFimFerias?: string | null;
    horarioTrabalho?: any;
    observacoes?: string;
    storeCodeOrigin?: string;
  }) {
    const name = (input.name || '').trim();
    if (!name) throw new BadRequestException('Nome é obrigatório.');
    if (name.length > 60) throw new BadRequestException('Nome muito longo (máx 60).');

    // Normaliza: primeira letra maiúscula em cada palavra
    const normalized = name
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    // Valida cargo se enviado
    let cargo = 'VENDEDORA';
    if (input.cargo) {
      const valid = ['VENDEDORA', 'LIDER_B', 'LIDER_A', 'GERENTE_B', 'GERENTE_A'];
      if (!valid.includes(input.cargo)) {
        throw new BadRequestException(`cargo inválido. Use: ${valid.join(', ')}`);
      }
      cargo = input.cargo;
    }

    try {
      const created = await this.prisma.seller.create({
        data: {
          name: normalized,
          apelido: input.apelido?.trim().toUpperCase().slice(0, 40) || null,
          whatsapp: input.whatsapp?.trim() || null,
          cargo,
          responsibleStoreId: cargo !== 'VENDEDORA' ? input.responsibleStoreId || null : null,
          cpf: input.cpf?.replace(/\D/g, '') || null,
          rg: input.rg || null,
          email: input.email?.trim().toLowerCase() || null,
          dataNascimento: input.dataNascimento ? new Date(input.dataNascimento) : null,
          endereco: input.endereco || null,
          cidade: input.cidade || null,
          uf: input.uf?.toUpperCase().slice(0, 2) || null,
          cep: input.cep?.replace(/\D/g, '') || null,
          dataAdmissao: input.dataAdmissao ? new Date(input.dataAdmissao) : null,
          contratoTipo: input.contratoTipo || null,
          cargoFuncao: input.cargoFuncao || null,
          salarioBase: input.salarioBase != null ? input.salarioBase : null,
          dataInicioFerias: input.dataInicioFerias ? new Date(input.dataInicioFerias) : null,
          dataFimFerias: input.dataFimFerias ? new Date(input.dataFimFerias) : null,
          horarioTrabalho:
            input.horarioTrabalho != null
              ? typeof input.horarioTrabalho === 'string'
                ? input.horarioTrabalho
                : JSON.stringify(input.horarioTrabalho)
              : null,
          observacoes: input.observacoes || null,
          storeCodeOrigin: input.storeCodeOrigin || null,
        } as any,
      });
      // Loja onde trabalha → entra sozinha na escolha de vendedora do PDV
      await this.syncPdvWhitelist(created.id, null);
      return created;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException(`Já existe uma vendedora com o nome "${normalized}".`);
      }
      throw e;
    }
  }

  /**
   * LOJA ONDE TRABALHA → PDV (22/07): selecionar a loja no cadastro coloca a
   * funcionária AUTOMATICAMENTE na escolha de vendedora do PDV daquela loja
   * (whitelist pdv_active_sellers) — sem depender da tela vendedoras-ativas.
   * Trocou de loja → sai da anterior e entra na nova; inativou → sai de todas.
   * Entradas manuais em OUTRAS lojas (multi-loja via vendedoras-ativas) são
   * preservadas, exceto quando a funcionária é inativada.
   */
  private async syncPdvWhitelist(sellerId: string, prevStoreCode: string | null) {
    try {
      const s: any = await this.prisma.seller.findUnique({ where: { id: sellerId } });
      if (!s) return;
      const codigo = String(s.wincredCodigo || s.id).trim();
      const nome = String((s as any).apelido || s.name).trim();
      const alvo = s.active ? String(s.storeCodeOrigin || '').trim() || null : null;

      if (!s.active) {
        // BUG GRAVE (23/07): deleteMany({codigo}) apagava TODAS as lojas —
        // o código de funcionária REPETE entre lojas (igual cliente), então
        // desligar uma ficha varria vendedoras legítimas de outras lojas
        // (Jundiaí ficou com 2). Agora só remove linha que é DELA de verdade:
        // mesma loja da ficha OU mesmo nome/apelido.
        const normNome = (x: any) => String(x ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
        const linhas: any[] = await (this.prisma as any).pdvActiveSeller.findMany({
          where: { codigo },
        });
        const nomesDela = new Set([normNome(s.name), normNome((s as any).apelido)].filter(Boolean));
        const lojaDela = String(s.storeCodeOrigin || '').trim();
        const ids = linhas
          .filter((r) => (lojaDela && r.storeCode === lojaDela) || nomesDela.has(normNome(r.nome)))
          .map((r) => r.id);
        if (ids.length) {
          await (this.prisma as any).pdvActiveSeller.deleteMany({ where: { id: { in: ids } } });
        }
        return;
      }
      if (prevStoreCode && prevStoreCode !== alvo) {
        await (this.prisma as any).pdvActiveSeller.deleteMany({
          where: { codigo, storeCode: prevStoreCode },
        });
      }
      if (alvo) {
        await (this.prisma as any).pdvActiveSeller.upsert({
          where: { storeCode_codigo: { storeCode: alvo, codigo } },
          create: { storeCode: alvo, codigo, nome },
          update: { nome },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[sellers] syncPdvWhitelist falhou (${sellerId}): ${e?.message || e}`);
    }
  }

  async update(
    id: string,
    input: {
      name?: string;
      apelido?: string | null;
      whatsapp?: string | null;
      active?: boolean;
      cargo?: string;
      responsibleStoreId?: string | null;
      storeCodeOrigin?: string | null;
      // Prontuario RH
      cpf?: string | null;
      rg?: string | null;
      dataNascimento?: string | null;
      email?: string | null;
      endereco?: string | null;
      cidade?: string | null;
      uf?: string | null;
      cep?: string | null;
      dataAdmissao?: string | null;
      contratoTipo?: string | null;
      cargoFuncao?: string | null;
      salarioBase?: number | null;
      horarioTrabalho?: any;
      dataInicioFerias?: string | null;
      dataFimFerias?: string | null;
      observacoes?: string | null;
    },
  ) {
    const seller = await this.prisma.seller.findUnique({ where: { id } });
    if (!seller) throw new NotFoundException('Vendedora não encontrada.');

    const data: any = {};
    if (input.name != null) {
      const n = input.name.trim();
      if (!n) throw new BadRequestException('Nome vazio.');
      data.name = n
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    if (input.apelido !== undefined) data.apelido = input.apelido?.trim().toUpperCase().slice(0, 40) || null;
    if (input.whatsapp !== undefined) data.whatsapp = input.whatsapp?.trim() || null;
    if (input.active !== undefined) data.active = !!input.active;

    if (input.cargo !== undefined) {
      // CAIXA existe no motor de comissão (2% próprias on/off, ver
      // CommissionsService.seedDefaultCargoRules) e no dropdown das telas —
      // faltava aqui na validação (erro 400 "cargo inválido" de 11/07).
      const validCargos = ['VENDEDORA', 'CAIXA', 'LIDER_B', 'LIDER_A', 'GERENTE_B', 'GERENTE_A'];
      if (!validCargos.includes(input.cargo)) {
        throw new BadRequestException(`cargo inválido. Use: ${validCargos.join(', ')}`);
      }
      data.cargo = input.cargo;
      // VENDEDORA/CAIXA não respondem por loja → zera responsibleStoreId
      if ((input.cargo === 'VENDEDORA' || input.cargo === 'CAIXA') && input.responsibleStoreId === undefined) {
        data.responsibleStoreId = null;
      }
    }
    if (input.responsibleStoreId !== undefined) {
      data.responsibleStoreId = input.responsibleStoreId || null;
    }
    // Loja "de origem" (agrupamento/lista) — editável inline na lista de
    // funcionárias. É a loja mostrada pra VENDEDORA (que não tem responsibleStore).
    if (input.storeCodeOrigin !== undefined) {
      data.storeCodeOrigin = String(input.storeCodeOrigin || '').trim() || null;
    }

    // ── PRONTUARIO RH ──
    if (input.cpf !== undefined) data.cpf = input.cpf?.replace(/\D/g, '') || null;
    if (input.rg !== undefined) data.rg = input.rg || null;
    if (input.email !== undefined) data.email = input.email?.trim().toLowerCase() || null;
    if (input.endereco !== undefined) data.endereco = input.endereco || null;
    if (input.cidade !== undefined) data.cidade = input.cidade || null;
    if (input.uf !== undefined) data.uf = input.uf?.toUpperCase().slice(0, 2) || null;
    if (input.cep !== undefined) data.cep = input.cep?.replace(/\D/g, '') || null;
    if (input.contratoTipo !== undefined) data.contratoTipo = input.contratoTipo || null;
    if (input.cargoFuncao !== undefined) data.cargoFuncao = input.cargoFuncao || null;
    if (input.salarioBase !== undefined) data.salarioBase = input.salarioBase;
    if (input.observacoes !== undefined) data.observacoes = input.observacoes || null;
    if (input.dataNascimento !== undefined) data.dataNascimento = input.dataNascimento ? new Date(input.dataNascimento) : null;
    if (input.dataAdmissao !== undefined) data.dataAdmissao = input.dataAdmissao ? new Date(input.dataAdmissao) : null;
    if (input.dataInicioFerias !== undefined) data.dataInicioFerias = input.dataInicioFerias ? new Date(input.dataInicioFerias) : null;
    if (input.dataFimFerias !== undefined) data.dataFimFerias = input.dataFimFerias ? new Date(input.dataFimFerias) : null;
    if (input.horarioTrabalho !== undefined) {
      data.horarioTrabalho = input.horarioTrabalho
        ? typeof input.horarioTrabalho === 'string'
          ? input.horarioTrabalho
          : JSON.stringify(input.horarioTrabalho)
        : null;
    }

    try {
      const updated = await this.prisma.seller.update({ where: { id }, data });
      // Loja onde trabalha / apelido / ativo mudaram → reflete na escolha de
      // vendedora do PDV (whitelist), tirando da loja anterior se trocou.
      await this.syncPdvWhitelist(id, seller.storeCodeOrigin || null);
      return updated;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException('Já existe uma vendedora com esse nome.');
      }
      throw e;
    }
  }

  /**
   * Atribui uma vendedora a um pedido WC. `sellerId=null` desatribui.
   * Mantém um "cache" do nome em Order.sellerName pra relatórios não dependerem
   * de JOIN (e pra preservar histórico se a vendedora for renomeada depois).
   */
  async assignToOrder(wcOrderId: number, sellerId: string | null, assignedBy?: string) {
    const order = await this.prisma.order.findUnique({ where: { wcOrderId } });
    if (!order) throw new NotFoundException(`Pedido WC #${wcOrderId} não encontrado no sistema.`);

    if (sellerId === null) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          sellerId: null,
          sellerName: null,
          sellerAssignedAt: null,
          sellerAssignedBy: null,
        },
      });
      this.logger.log(`[seller] pedido #${wcOrderId} DESATRIBUIDO por ${assignedBy || '?'}`);
      return { ok: true, seller: null };
    }

    const seller = await this.prisma.seller.findUnique({ where: { id: sellerId } });
    if (!seller) throw new NotFoundException('Vendedora não encontrada.');
    if (!seller.active) throw new BadRequestException('Vendedora está desativada.');

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        sellerId: seller.id,
        sellerName: seller.name,
        sellerAssignedAt: new Date(),
        sellerAssignedBy: assignedBy || null,
      },
    });

    this.logger.log(`[seller] pedido #${wcOrderId} → ${seller.name} (por ${assignedBy || '?'})`);

    return { ok: true, seller: { id: seller.id, name: seller.name } };
  }

  /**
   * Relatório: pedidos atribuídos no período.
   *
   * Critério de "venda": pedido com status em ['processing','separacao','separated','shipped','completed']
   * — ou seja, não conta pedido cancelado/reembolsado. Período é sobre `wcDateCreated`
   * (data real da venda no site), não sobre `sellerAssignedAt`.
   *
   * Retorna lista agrupada:
   *   [ { sellerId, sellerName, orderCount, totalAmount } ]
   *
   * Inclui linha "Sem atribuição" com pedidos do período que não tem sellerId.
   */
  async report(from: Date, to: Date) {
    const VALID_STATUSES = ['processing', 'separacao', 'separated', 'shipped', 'completed'];

    // Pedidos do período com status válido
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: VALID_STATUSES },
        OR: [
          { wcDateCreated: { gte: from, lte: to } },
          // fallback: se wcDateCreated for null, usa createdAt
          { AND: [{ wcDateCreated: null }, { createdAt: { gte: from, lte: to } }] },
        ],
      },
      select: {
        id: true,
        wcOrderNumber: true,
        sellerId: true,
        sellerName: true,
        totalAmount: true,
        wcDateCreated: true,
        createdAt: true,
        customerName: true,
      },
      orderBy: { wcDateCreated: 'desc' },
    });

    // Agrupa
    const bucket = new Map<string, { sellerId: string | null; sellerName: string; orderCount: number; totalAmount: number }>();
    for (const o of orders) {
      const key = o.sellerId || '__none__';
      const name = o.sellerName || 'Sem atribuição';
      const cur = bucket.get(key) || { sellerId: o.sellerId, sellerName: name, orderCount: 0, totalAmount: 0 };
      cur.orderCount += 1;
      cur.totalAmount += Number(o.totalAmount || 0);
      bucket.set(key, cur);
    }

    const sellers = Array.from(bucket.values()).sort((a, b) => b.totalAmount - a.totalAmount);

    const totals = {
      orderCount: orders.length,
      totalAmount: orders.reduce((a, o) => a + Number(o.totalAmount || 0), 0),
    };

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totals,
      sellers,
      orders: orders.map((o) => ({
        wcOrderNumber: o.wcOrderNumber,
        customerName: o.customerName,
        sellerId: o.sellerId,
        sellerName: o.sellerName,
        totalAmount: Number(o.totalAmount || 0),
        date: o.wcDateCreated || o.createdAt,
      })),
    };
  }
}
