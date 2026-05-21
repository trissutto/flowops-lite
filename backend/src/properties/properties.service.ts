import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PropertiesService — módulo IMOBILIÁRIO.
 *
 * Roles permitidas:
 *   - admin                 → tudo (senha suprema do dono)
 *   - imobiliario_admin     → tudo dentro do módulo imobiliário
 *   - imobiliario_user      → CRUD imóveis + docs (NÃO exclui imóveis)
 *   - imobiliario_viewer    → só leitura
 *
 * Audit log granular: toda mudança gera PropertyLog com user + diff.
 */
@Injectable()
export class PropertiesService {
  private readonly logger = new Logger(PropertiesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────
  // CRUD principal
  // ─────────────────────────────────────────────────────────────────────

  async list(filters: {
    search?: string | null;
    cidade?: string | null;
    bairro?: string | null;
    status?: string | null;
    incluirArquivados?: boolean;
  } = {}) {
    const where: any = {};
    if (!filters.incluirArquivados) {
      where.archivedAt = null;
    }
    if (filters.cidade?.trim()) {
      where.cidade = { contains: filters.cidade.trim(), mode: 'insensitive' };
    }
    if (filters.bairro?.trim()) {
      where.bairro = { contains: filters.bairro.trim(), mode: 'insensitive' };
    }
    if (filters.status?.trim()) {
      where.status = filters.status.trim();
    }
    if (filters.search?.trim()) {
      const q = filters.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { endereco: { contains: q, mode: 'insensitive' } },
        { proprietario: { contains: q, mode: 'insensitive' } },
        { bairro: { contains: q, mode: 'insensitive' } },
        { cidade: { contains: q, mode: 'insensitive' } },
      ];
    }

    const properties = await (this.prisma as any).property.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: {
            attachments: true,
            taxes: true,
          },
        },
        water: { select: { id: true } },
        energy: { select: { id: true } },
        iptu: { select: { id: true, dataVencimento: true, situacao: true } },
        deed: { select: { id: true } },
        scripture: { select: { id: true } },
      },
    });

    // Enriquece com flags de "pendências"
    return properties.map((p: any) => {
      const docsFaltando: string[] = [];
      if (!p.water) docsFaltando.push('Água');
      if (!p.energy) docsFaltando.push('Energia');
      if (!p.iptu) docsFaltando.push('IPTU');
      if (!p.deed) docsFaltando.push('Matrícula');
      if (!p.scripture) docsFaltando.push('Escritura');

      const iptuVencendo =
        p.iptu?.dataVencimento &&
        new Date(p.iptu.dataVencimento).getTime() < Date.now() + 30 * 24 * 60 * 60 * 1000;

      return {
        ...p,
        anexosCount: p._count.attachments,
        taxasCount: p._count.taxes,
        docsFaltandoCount: docsFaltando.length,
        docsFaltando,
        iptuVencendo: !!iptuVencendo,
      };
    });
  }

  async getById(id: string) {
    const p = await (this.prisma as any).property.findUnique({
      where: { id },
      include: {
        water: true,
        energy: true,
        iptu: true,
        deed: true,
        scripture: true,
        taxes: { orderBy: { createdAt: 'desc' } },
        attachments: { orderBy: { uploadedAt: 'desc' } },
      },
    });
    if (!p) throw new NotFoundException('Imóvel não encontrado');
    return p;
  }

  async create(input: {
    name: string;
    cep?: string;
    endereco?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    estado?: string;
    status?: string;
    proprietario?: string;
    observacoes?: string;
  }, user: { id?: string; name?: string }) {
    if (!input.name?.trim()) {
      throw new BadRequestException('Nome do imóvel é obrigatório');
    }
    const data: any = {
      name: input.name.trim(),
      cep: input.cep?.replace(/\D/g, '') || null,
      endereco: input.endereco?.trim() || null,
      numero: input.numero?.trim() || null,
      complemento: input.complemento?.trim() || null,
      bairro: input.bairro?.trim() || null,
      cidade: input.cidade?.trim() || null,
      estado: input.estado?.trim().toUpperCase().slice(0, 2) || null,
      status: input.status || 'ativo',
      proprietario: input.proprietario?.trim() || null,
      observacoes: input.observacoes?.trim() || null,
      createdByUserId: user?.id || null,
    };
    const property = await (this.prisma as any).property.create({ data });
    await this.log(property.id, user, 'create', 'property', { name: property.name });
    return property;
  }

  async update(id: string, input: Partial<{
    name: string;
    cep: string;
    endereco: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    estado: string;
    status: string;
    proprietario: string;
    observacoes: string;
  }>, user: { id?: string; name?: string }) {
    const existing = await this.getById(id);
    const data: any = {};
    const changes: any = {};

    const fields: (keyof typeof input)[] = [
      'name', 'cep', 'endereco', 'numero', 'complemento',
      'bairro', 'cidade', 'estado', 'status', 'proprietario', 'observacoes',
    ];
    for (const field of fields) {
      if (input[field] === undefined) continue;
      let v: any = input[field];
      if (typeof v === 'string') {
        if (field === 'cep') v = v.replace(/\D/g, '') || null;
        else if (field === 'estado') v = v.trim().toUpperCase().slice(0, 2) || null;
        else v = v.trim() || null;
      }
      if (existing[field] !== v) {
        changes[field] = { from: existing[field], to: v };
        data[field] = v;
      }
    }

    if (Object.keys(data).length === 0) {
      return existing; // nada mudou
    }

    const updated = await (this.prisma as any).property.update({
      where: { id },
      data,
    });
    await this.log(id, user, 'update', 'property', changes);
    return updated;
  }

  async archive(id: string, user: { id?: string; name?: string }) {
    const property = await this.getById(id);
    if (property.archivedAt) {
      throw new BadRequestException('Imóvel já arquivado');
    }
    await (this.prisma as any).property.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await this.log(id, user, 'archive', 'property', null);
    return { ok: true };
  }

  async unarchive(id: string, user: { id?: string; name?: string }) {
    const property = await this.getById(id);
    if (!property.archivedAt) {
      throw new BadRequestException('Imóvel não está arquivado');
    }
    await (this.prisma as any).property.update({
      where: { id },
      data: { archivedAt: null },
    });
    await this.log(id, user, 'unarchive', 'property', null);
    return { ok: true };
  }

  async duplicate(id: string, user: { id?: string; name?: string }) {
    const original = await this.getById(id);
    const { id: _, createdAt, updatedAt, archivedAt, createdByUserId,
            water, energy, iptu, deed, scripture, taxes, attachments, ...rest } = original;
    const copy = await (this.prisma as any).property.create({
      data: {
        ...rest,
        name: `${original.name} (cópia)`,
        createdByUserId: user?.id || null,
      },
    });
    await this.log(copy.id, user, 'create', 'property', { duplicatedFrom: id });
    return copy;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Dashboard / KPIs
  // ─────────────────────────────────────────────────────────────────────

  async dashboard() {
    const all = await (this.prisma as any).property.findMany({
      where: { archivedAt: null },
      include: {
        water: { select: { id: true } },
        energy: { select: { id: true } },
        iptu: { select: { id: true, dataVencimento: true, situacao: true } },
        deed: { select: { id: true } },
        scripture: { select: { id: true } },
        _count: { select: { attachments: true } },
      },
    });

    const byStatus: Record<string, number> = {};
    let totalAnexos = 0;
    let docsFaltando = 0;
    let iptuPendente = 0;
    let iptuVencendo = 0;

    for (const p of all) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      totalAnexos += p._count.attachments;

      // Cada doc faltando conta
      if (!p.water) docsFaltando++;
      if (!p.energy) docsFaltando++;
      if (!p.iptu) {
        docsFaltando++;
        iptuPendente++;
      } else if (p.iptu.situacao === 'em_atraso') {
        iptuPendente++;
      }
      if (p.iptu?.dataVencimento) {
        const dueDate = new Date(p.iptu.dataVencimento).getTime();
        if (dueDate < Date.now() + 30 * 24 * 60 * 60 * 1000) iptuVencendo++;
      }
      if (!p.deed) docsFaltando++;
      if (!p.scripture) docsFaltando++;
    }

    return {
      total: all.length,
      ativos: byStatus['ativo'] || 0,
      em_construcao: byStatus['em_construcao'] || 0,
      pronta_locacao: byStatus['pronta_locacao'] || 0,
      vendidos: byStatus['vendido'] || 0,
      inativos: byStatus['inativo'] || 0,
      totalAnexos,
      docsFaltando,
      iptuPendente,
      iptuVencendo,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Sub-recursos (água, energia, IPTU, taxas, matrícula, escritura)
  // upsert pattern — cria se não existe, atualiza se existe
  // ─────────────────────────────────────────────────────────────────────

  async upsertWater(propertyId: string, input: any, user: any) {
    await this.getById(propertyId); // valida que existe
    const data: any = {
      companhia: input.companhia?.trim() || null,
      titular: input.titular?.trim() || null,
      codigoFornecimento: input.codigoFornecimento?.trim() || null,
      vencimentoDia: input.vencimentoDia ? Number(input.vencimentoDia) : null,
      observacoes: input.observacoes?.trim() || null,
    };
    if (input.attachmentUrl !== undefined) data.attachmentUrl = input.attachmentUrl || null;
    const result = await (this.prisma as any).propertyWaterAccount.upsert({
      where: { propertyId },
      create: { ...data, propertyId },
      update: data,
    });
    await this.log(propertyId, user, 'update', 'water', { ...data });
    return result;
  }

  async upsertEnergy(propertyId: string, input: any, user: any) {
    await this.getById(propertyId);
    const data: any = {
      companhia: input.companhia?.trim() || null,
      titular: input.titular?.trim() || null,
      codigoCliente: input.codigoCliente?.trim() || null,
      vencimentoDia: input.vencimentoDia ? Number(input.vencimentoDia) : null,
      observacoes: input.observacoes?.trim() || null,
    };
    if (input.attachmentUrl !== undefined) data.attachmentUrl = input.attachmentUrl || null;
    const result = await (this.prisma as any).propertyEnergyAccount.upsert({
      where: { propertyId },
      create: { ...data, propertyId },
      update: data,
    });
    await this.log(propertyId, user, 'update', 'energy', { ...data });
    return result;
  }

  async upsertIptu(propertyId: string, input: any, user: any) {
    await this.getById(propertyId);
    const data: any = {
      proprietario: input.proprietario?.trim() || null,
      codigoCadastro: input.codigoCadastro?.trim() || null,
      valorAnual: input.valorAnual ? Number(input.valorAnual) : null,
      situacao: input.situacao || null,
      dataVencimento: input.dataVencimento ? new Date(input.dataVencimento) : null,
      observacoes: input.observacoes?.trim() || null,
    };
    if (input.attachmentUrl !== undefined) data.attachmentUrl = input.attachmentUrl || null;
    const result = await (this.prisma as any).propertyIptu.upsert({
      where: { propertyId },
      create: { ...data, propertyId },
      update: data,
    });
    await this.log(propertyId, user, 'update', 'iptu', { ...data });
    return result;
  }

  async upsertDeed(propertyId: string, input: any, user: any) {
    await this.getById(propertyId);
    const data: any = {
      numero: input.numero?.trim() || null,
      cartorio: input.cartorio?.trim() || null,
      cidadeCartorio: input.cidadeCartorio?.trim() || null,
      dataEmissao: input.dataEmissao ? new Date(input.dataEmissao) : null,
      observacoes: input.observacoes?.trim() || null,
    };
    if (input.attachmentUrl !== undefined) data.attachmentUrl = input.attachmentUrl || null;
    const result = await (this.prisma as any).propertyDeed.upsert({
      where: { propertyId },
      create: { ...data, propertyId },
      update: data,
    });
    await this.log(propertyId, user, 'update', 'deed', { ...data });
    return result;
  }

  async upsertScripture(propertyId: string, input: any, user: any) {
    await this.getById(propertyId);
    const data: any = {
      numero: input.numero?.trim() || null,
      data: input.data ? new Date(input.data) : null,
      livro: input.livro?.trim() || null,
      folha: input.folha?.trim() || null,
      cartorio: input.cartorio?.trim() || null,
      observacoes: input.observacoes?.trim() || null,
    };
    if (input.attachmentUrl !== undefined) data.attachmentUrl = input.attachmentUrl || null;
    const result = await (this.prisma as any).propertyScripture.upsert({
      where: { propertyId },
      create: { ...data, propertyId },
      update: data,
    });
    await this.log(propertyId, user, 'update', 'scripture', { ...data });
    return result;
  }

  // ── Taxas (1:N) ──
  async createTax(propertyId: string, input: any, user: any) {
    await this.getById(propertyId);
    const tax = await (this.prisma as any).propertyTax.create({
      data: {
        propertyId,
        tipo: input.tipo || 'outros',
        nome: input.nome?.trim() || null,
        codigo: input.codigo?.trim() || null,
        valor: input.valor ? Number(input.valor) : null,
        vencimentoDia: input.vencimentoDia ? Number(input.vencimentoDia) : null,
        observacoes: input.observacoes?.trim() || null,
        attachmentUrl: input.attachmentUrl || null,
      },
    });
    await this.log(propertyId, user, 'create', 'tax', { tipo: tax.tipo, valor: tax.valor });
    return tax;
  }

  async updateTax(taxId: string, input: any, user: any) {
    const existing = await (this.prisma as any).propertyTax.findUnique({ where: { id: taxId } });
    if (!existing) throw new NotFoundException('Taxa não encontrada');
    const data: any = {};
    for (const f of ['tipo', 'nome', 'codigo', 'observacoes']) {
      if (input[f] !== undefined) data[f] = typeof input[f] === 'string' ? input[f].trim() || null : input[f];
    }
    if (input.valor !== undefined) data.valor = input.valor ? Number(input.valor) : null;
    if (input.vencimentoDia !== undefined) data.vencimentoDia = input.vencimentoDia ? Number(input.vencimentoDia) : null;
    if (input.attachmentUrl !== undefined) data.attachmentUrl = input.attachmentUrl || null;
    const updated = await (this.prisma as any).propertyTax.update({ where: { id: taxId }, data });
    await this.log(existing.propertyId, user, 'update', 'tax', { taxId, ...data });
    return updated;
  }

  async deleteTax(taxId: string, user: any) {
    const existing = await (this.prisma as any).propertyTax.findUnique({ where: { id: taxId } });
    if (!existing) throw new NotFoundException('Taxa não encontrada');
    await (this.prisma as any).propertyTax.delete({ where: { id: taxId } });
    await this.log(existing.propertyId, user, 'delete_attachment', 'tax', { taxId, tipo: existing.tipo });
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Anexos gerais (categoria fixa ou custom)
  // ─────────────────────────────────────────────────────────────────────

  async addAttachment(propertyId: string, input: {
    category: string;
    fileName: string;
    fileUrl: string;
    fileSize?: number;
    mimeType?: string;
  }, user: any) {
    await this.getById(propertyId);
    const att = await (this.prisma as any).propertyAttachment.create({
      data: {
        propertyId,
        category: input.category || 'Outros',
        fileName: input.fileName,
        fileUrl: input.fileUrl,
        fileSize: input.fileSize || null,
        mimeType: input.mimeType || null,
        uploadedByUserId: user?.id || null,
        uploadedByName: user?.name || null,
      },
    });
    await this.log(propertyId, user, 'upload', 'attachment', {
      attachmentId: att.id,
      fileName: att.fileName,
      category: att.category,
    });
    return att;
  }

  async deleteAttachment(attachmentId: string, user: any) {
    const att = await (this.prisma as any).propertyAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!att) throw new NotFoundException('Anexo não encontrado');
    await (this.prisma as any).propertyAttachment.delete({ where: { id: attachmentId } });
    await this.log(att.propertyId, user, 'delete_attachment', 'attachment', {
      fileName: att.fileName,
      category: att.category,
    });
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Logs (timeline)
  // ─────────────────────────────────────────────────────────────────────

  async getLogs(propertyId: string, limit = 50) {
    return (this.prisma as any).propertyLog.findMany({
      where: { propertyId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, limit),
    });
  }

  private async log(
    propertyId: string,
    user: { id?: string; name?: string },
    action: string,
    scope: string,
    details: any,
  ) {
    try {
      await (this.prisma as any).propertyLog.create({
        data: {
          propertyId,
          userId: user?.id || null,
          userName: user?.name || null,
          action,
          scope,
          details: details ? JSON.stringify(details) : null,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[properties] falha ao gravar log: ${e?.message || e}`);
    }
  }
}
