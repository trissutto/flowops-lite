import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface StoreInput {
  code?: string;
  name?: string;
  cep?: string;
  city?: string;
  state?: string;
  whatsapp?: string;
  contactName?: string;
  active?: boolean;
  priorityScore?: number;
  /**
   * REDE   = loja própria (sem cobrança intercompany entre si)
   * FILIAL = franquia (paga preço/2.5 + 8% royalties + 4% marketing)
   * Default: REDE.
   */
  tipo?: 'REDE' | 'FILIAL';
  /**
   * CNPJ esperado pra essa loja emitir NFC-e. Quando o grupo tem múltiplas
   * empresas (ex: SOROCABA emite por T.O. RISSUTTO, demais por LURDS PLUS SIZE),
   * cadastrar aqui o CNPJ correto evita que a loja emita pela empresa errada.
   * Validação: PDV bloqueia finalize se config.cnpj não bater.
   */
  expectedCnpj?: string | null;
  expectedRazaoSocial?: string | null;
}

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.store.findMany({ orderBy: { code: 'asc' } });
  }

  /**
   * Lista lojas com config de realinhamento (campos canSendRealign + canReceiveRealign).
   * Usado pela aba Config da tela de Distribuição de Estoque.
   */
  async listRealignConfig() {
    const stores = await this.prisma.store.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        city: true,
        tipo: true,
        priorityScore: true,
        canSendRealign: true,
        canReceiveRealign: true,
      },
    });
    return stores;
  }

  /**
   * Atualiza config de realinhamento em batch (vários toggles de uma vez).
   * Atomicidade: tudo numa transaction — se um item falhar, rollback total.
   */
  async updateRealignConfig(
    items: Array<{ code: string; canSendRealign: boolean; canReceiveRealign: boolean }>,
  ) {
    if (!Array.isArray(items) || items.length === 0) {
      return { updated: 0 };
    }
    const ops = items.map((it) =>
      this.prisma.store.update({
        where: { code: it.code },
        data: {
          canSendRealign: !!it.canSendRealign,
          canReceiveRealign: !!it.canReceiveRealign,
        },
      }),
    );
    await this.prisma.$transaction(ops);
    return { updated: items.length };
  }

  async performance(storeId: string) {
    const [total, separating, shipped] = await this.prisma.$transaction([
      this.prisma.pickOrder.count({ where: { storeId } }),
      this.prisma.pickOrder.count({ where: { storeId, status: 'separating' } }),
      this.prisma.pickOrder.count({ where: { storeId, status: 'shipped' } }),
    ]);
    return { total, separating, shipped };
  }

  async create(data: StoreInput) {
    if (!data.code?.trim()) throw new BadRequestException('Código é obrigatório');
    if (!data.name?.trim()) throw new BadRequestException('Nome é obrigatório');

    const code = data.code.trim();
    const exists = await this.prisma.store.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`Já existe uma loja com o código "${code}"`);

    return this.prisma.store.create({
      data: {
        code,
        name: data.name.trim(),
        cep: data.cep?.trim() || null,
        city: data.city?.trim() || null,
        state: data.state?.trim().toUpperCase() || null,
        whatsapp: this.cleanPhone(data.whatsapp),
        contactName: data.contactName?.trim() || null,
        active: data.active ?? true,
        priorityScore: data.priorityScore ?? 50,
        tipo: data.tipo === 'FILIAL' ? 'FILIAL' : 'REDE',
        expectedCnpj: this.cleanCnpj(data.expectedCnpj),
        expectedRazaoSocial: data.expectedRazaoSocial?.trim() || null,
      } as any,
    });
  }

  /** Strip não-dígitos do CNPJ. Retorna null se vazio. */
  private cleanCnpj(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    return digits || null;
  }

  async update(id: string, data: StoreInput) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Loja não encontrada');

    // Se tentou trocar o código, confere se não conflita
    if (data.code && data.code.trim() !== store.code) {
      const conflict = await this.prisma.store.findUnique({ where: { code: data.code.trim() } });
      if (conflict) throw new ConflictException(`Já existe uma loja com o código "${data.code}"`);
    }

    return this.prisma.store.update({
      where: { id },
      data: {
        code: data.code?.trim() ?? undefined,
        name: data.name?.trim() ?? undefined,
        cep: data.cep !== undefined ? (data.cep.trim() || null) : undefined,
        city: data.city !== undefined ? (data.city.trim() || null) : undefined,
        state: data.state !== undefined ? (data.state.trim().toUpperCase() || null) : undefined,
        whatsapp: data.whatsapp !== undefined ? this.cleanPhone(data.whatsapp) : undefined,
        contactName: data.contactName !== undefined ? (data.contactName.trim() || null) : undefined,
        active: data.active ?? undefined,
        priorityScore: data.priorityScore ?? undefined,
        tipo: data.tipo ? (data.tipo === 'FILIAL' ? 'FILIAL' : 'REDE') : undefined,
        expectedCnpj: data.expectedCnpj !== undefined ? this.cleanCnpj(data.expectedCnpj) : undefined,
        expectedRazaoSocial: data.expectedRazaoSocial !== undefined
          ? (data.expectedRazaoSocial?.trim() || null)
          : undefined,
      } as any,
    });
  }

  /**
   * Remove a loja. Se tiver vínculos (pedidos, separações, usuários) faz SOFT DELETE
   * (só desativa, preserva histórico). Senão, hard delete.
   */
  async remove(id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Loja não encontrada');

    const [orderItems, pickOrders, users] = await Promise.all([
      this.prisma.orderItem.count({ where: { assignedStoreId: id } }),
      this.prisma.pickOrder.count({ where: { storeId: id } }),
      this.prisma.user.count({ where: { storeId: id } }),
    ]);
    const links = orderItems + pickOrders + users;

    if (links > 0) {
      await this.prisma.store.update({ where: { id }, data: { active: false } });
      return { deleted: false, deactivated: true, reason: `Loja tem ${links} vínculo(s) (pedidos/separações/usuários), apenas desativada.` };
    }

    await this.prisma.store.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  private cleanPhone(v: string | undefined | null): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const clean = v.replace(/\D/g, '');
    return clean.length ? clean : null;
  }
}
