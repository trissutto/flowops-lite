import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildConstructionSummary,
  buildLedger,
  netPaymentCents,
  paymentExceedsCommitment,
  reversalExceedsPayment,
} from './properties-construction.calculations';

const PROJECT_STATUSES = new Set(['planejamento', 'ativa', 'pausada', 'concluida', 'cancelada']);
const STAGE_STATUSES = new Set(['nao_iniciada', 'em_andamento', 'pausada', 'concluida', 'cancelada']);
const VENDOR_KINDS = new Set(['fornecedor', 'prestador', 'ambos']);
const ENTRY_TYPES = new Set(['aporte', 'reembolso', 'outra']);
const DEFAULT_CATEGORIES = [
  'Projeto',
  'Documentação',
  'Demolição',
  'Fundação',
  'Alvenaria',
  'Cobertura',
  'Elétrica',
  'Hidráulica',
  'Acabamentos',
  'Mão de obra',
  'Materiais',
  'Outros',
];

@Injectable()
export class PropertiesConstructionService {
  constructor(private readonly prisma: PrismaService) {}

  async bootstrap(propertyId: string) {
    const property = await this.propertyOrThrow(propertyId);
    await this.ensureDefaultCategories();
    const [projects, categories, vendors] = await Promise.all([
      (this.prisma as any).propertyConstructionProject.findMany({
        where: { propertyId },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      }),
      (this.prisma as any).constructionCategory.findMany({
        where: { active: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      (this.prisma as any).constructionVendor.findMany({
        orderBy: [{ active: 'desc' }, { legalName: 'asc' }],
      }),
    ]);
    return {
      property: { id: property.id, name: property.name },
      projects,
      categories,
      vendors: vendors.map((vendor: any) => this.safeVendor(vendor)),
    };
  }

  async createProject(propertyId: string, input: any, user: any) {
    await this.propertyOrThrow(propertyId);
    const project = await (this.prisma as any).propertyConstructionProject.create({
      data: {
        propertyId,
        name: this.requiredText(input?.name, 'Nome da obra', 160),
        description: this.optionalText(input?.description, 4000),
        status: this.enumValue(input?.status || 'planejamento', PROJECT_STATUSES, 'Status da obra'),
        plannedStartAt: this.optionalDate(input?.plannedStartAt, 'Início previsto'),
        plannedEndAt: this.optionalDate(input?.plannedEndAt, 'Término previsto'),
        actualStartAt: this.optionalDate(input?.actualStartAt, 'Início realizado'),
        actualEndAt: this.optionalDate(input?.actualEndAt, 'Término realizado'),
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      },
    });
    await this.log(propertyId, project.id, user, 'create', 'project', project.id, {
      name: project.name,
      status: project.status,
    });
    return this.getProject(propertyId, project.id);
  }

  async updateProject(propertyId: string, projectId: string, input: any, user: any) {
    const current = await this.projectOrThrow(propertyId, projectId);
    const data: any = {};
    if (input?.name !== undefined) data.name = this.requiredText(input.name, 'Nome da obra', 160);
    if (input?.description !== undefined) data.description = this.optionalText(input.description, 4000);
    if (input?.status !== undefined) data.status = this.enumValue(input.status, PROJECT_STATUSES, 'Status da obra');
    for (const field of ['plannedStartAt', 'plannedEndAt', 'actualStartAt', 'actualEndAt']) {
      if (input?.[field] !== undefined) data[field] = this.optionalDate(input[field], field);
    }
    if (data.status === 'concluida' && !data.actualEndAt && !current.actualEndAt) data.actualEndAt = new Date();
    const project = await (this.prisma as any).propertyConstructionProject.update({
      where: { id: projectId },
      data,
    });
    await this.log(propertyId, projectId, user, 'update', 'project', projectId, data);
    return project;
  }

  async getProject(propertyId: string, projectId: string) {
    await this.projectOrThrow(propertyId, projectId);
    const project = await (this.prisma as any).propertyConstructionProject.findUnique({
      where: { id: projectId },
      include: {
        stages: {
          include: { category: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
        commitments: {
          include: {
            vendor: true,
            category: true,
            stage: { select: { id: true, name: true } },
            payments: { include: { reversals: true } },
            documents: { where: { removedAt: null }, orderBy: { uploadedAt: 'desc' } },
          },
          orderBy: { contractedAt: 'desc' },
        },
        payments: {
          include: {
            vendor: true,
            stage: { select: { id: true, name: true } },
            commitment: { select: { id: true, description: true } },
            reversals: { orderBy: { occurredAt: 'desc' } },
            documents: { where: { removedAt: null }, orderBy: { uploadedAt: 'desc' } },
          },
          orderBy: { paidAt: 'desc' },
        },
        entries: {
          include: {
            vendor: true,
            documents: { where: { removedAt: null }, orderBy: { uploadedAt: 'desc' } },
          },
          orderBy: { occurredAt: 'desc' },
        },
      },
    });

    const summary = buildConstructionSummary({
      stages: project.stages,
      commitments: project.commitments,
      payments: project.payments,
      entries: project.entries,
    });
    const paidByStage = new Map<string, number>();
    const contractedByStage = new Map<string, number>();
    for (const commitment of project.commitments) {
      if (commitment.status !== 'cancelada' && commitment.stageId) {
        contractedByStage.set(
          commitment.stageId,
          (contractedByStage.get(commitment.stageId) || 0) + commitment.amountCents,
        );
      }
    }
    for (const payment of project.payments) {
      if (payment.stageId && payment.status !== 'estornado') {
        paidByStage.set(
          payment.stageId,
          (paidByStage.get(payment.stageId) || 0) + netPaymentCents(payment),
        );
      }
    }

    return {
      ...project,
      summary,
      stages: project.stages.map((stage: any) => ({
        ...stage,
        contractedCents: contractedByStage.get(stage.id) || 0,
        paidCents: paidByStage.get(stage.id) || 0,
        overdue: this.isStageOverdue(stage),
      })),
      commitments: project.commitments.map((commitment: any) => {
        const paidCents = commitment.payments.reduce(
          (total: number, payment: any) => total + netPaymentCents(payment),
          0,
        );
        return {
          ...commitment,
          vendor: commitment.vendor ? this.safeVendor(commitment.vendor) : null,
          documents: commitment.documents.map((document: any) => this.safeDocument(document)),
          paidCents,
          balanceCents: Math.max(0, commitment.amountCents - paidCents),
          overdue: commitment.status !== 'cancelada'
            && commitment.dueDate
            && paidCents < commitment.amountCents
            && this.endOfDay(commitment.dueDate) < new Date(),
        };
      }),
      payments: project.payments.map((payment: any) => ({
        ...payment,
        vendor: payment.vendor ? this.safeVendor(payment.vendor) : null,
        documents: payment.documents.map((document: any) => this.safeDocument(document)),
        netAmountCents: netPaymentCents(payment),
      })),
      entries: project.entries.map((entry: any) => ({
        ...entry,
        vendor: entry.vendor ? this.safeVendor(entry.vendor) : null,
        documents: entry.documents.map((document: any) => this.safeDocument(document)),
      })),
    };
  }

  async createCategory(propertyId: string, input: any, user: any) {
    await this.propertyOrThrow(propertyId);
    const name = this.requiredText(input?.name, 'Nome da categoria', 100);
    const existing = await (this.prisma as any).constructionCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    const category = existing
      ? await (this.prisma as any).constructionCategory.update({ where: { id: existing.id }, data: { active: true } })
      : await (this.prisma as any).constructionCategory.create({ data: { name, active: true, isDefault: false } });
    await this.log(propertyId, null, user, 'create', 'category', category.id, { name: category.name });
    return category;
  }

  async createStage(propertyId: string, projectId: string, input: any, user: any) {
    await this.projectOrThrow(propertyId, projectId);
    await this.optionalRelationOrThrow('constructionCategory', input?.categoryId, 'Categoria');
    const last = await (this.prisma as any).constructionStage.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });
    const stage = await (this.prisma as any).constructionStage.create({
      data: {
        projectId,
        categoryId: input?.categoryId || null,
        name: this.requiredText(input?.name, 'Nome da etapa', 160),
        description: this.optionalText(input?.description, 3000),
        responsible: this.optionalText(input?.responsible, 160),
        plannedStartAt: this.optionalDate(input?.plannedStartAt, 'Início previsto'),
        plannedEndAt: this.optionalDate(input?.plannedEndAt, 'Término previsto'),
        actualStartAt: this.optionalDate(input?.actualStartAt, 'Início realizado'),
        actualEndAt: this.optionalDate(input?.actualEndAt, 'Término realizado'),
        budgetCents: this.nonNegativeCents(input?.budgetCents, 'Orçamento previsto'),
        progressPercent: this.percent(input?.progressPercent || 0),
        status: this.enumValue(input?.status || 'nao_iniciada', STAGE_STATUSES, 'Status da etapa'),
        sortOrder: Number(last?._max?.sortOrder ?? -1) + 1,
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      },
    });
    await this.log(propertyId, projectId, user, 'create', 'stage', stage.id, {
      name: stage.name,
      budgetCents: stage.budgetCents,
    });
    return stage;
  }

  async updateStage(propertyId: string, projectId: string, stageId: string, input: any, user: any) {
    const current = await this.stageOrThrow(propertyId, projectId, stageId);
    const data: any = {};
    if (input?.categoryId !== undefined) {
      await this.optionalRelationOrThrow('constructionCategory', input.categoryId, 'Categoria');
      data.categoryId = input.categoryId || null;
    }
    if (input?.name !== undefined) data.name = this.requiredText(input.name, 'Nome da etapa', 160);
    if (input?.description !== undefined) data.description = this.optionalText(input.description, 3000);
    if (input?.responsible !== undefined) data.responsible = this.optionalText(input.responsible, 160);
    if (input?.budgetCents !== undefined) data.budgetCents = this.nonNegativeCents(input.budgetCents, 'Orçamento previsto');
    if (input?.progressPercent !== undefined) data.progressPercent = this.percent(input.progressPercent);
    if (input?.sortOrder !== undefined) data.sortOrder = this.nonNegativeInteger(input.sortOrder, 'Ordem');
    if (input?.status !== undefined) data.status = this.enumValue(input.status, STAGE_STATUSES, 'Status da etapa');
    for (const field of ['plannedStartAt', 'plannedEndAt', 'actualStartAt', 'actualEndAt']) {
      if (input?.[field] !== undefined) data[field] = this.optionalDate(input[field], field);
    }
    if (data.status === 'concluida') {
      data.progressPercent = 100;
      if (!data.actualEndAt && !current.actualEndAt) data.actualEndAt = new Date();
    }
    const stage = await (this.prisma as any).constructionStage.update({ where: { id: stageId }, data });
    await this.log(propertyId, projectId, user, 'update', 'stage', stageId, data);
    return stage;
  }

  async createVendor(propertyId: string, input: any, user: any) {
    await this.propertyOrThrow(propertyId);
    const document = this.optionalText(input?.document, 30);
    const documentNormalized = document ? document.replace(/\D/g, '') || null : null;
    if (documentNormalized) {
      const duplicate = await (this.prisma as any).constructionVendor.findUnique({
        where: { documentNormalized },
      });
      if (duplicate) throw new BadRequestException('Já existe fornecedor/prestador com este CPF/CNPJ.');
    }
    const vendor = await (this.prisma as any).constructionVendor.create({
      data: {
        legalName: this.requiredText(input?.legalName, 'Nome/Razão social', 180),
        tradeName: this.optionalText(input?.tradeName, 180),
        kind: this.enumValue(input?.kind || 'prestador', VENDOR_KINDS, 'Tipo de fornecedor'),
        specialty: this.optionalText(input?.specialty, 160),
        document,
        documentNormalized,
        phone: this.optionalText(input?.phone, 40),
        email: this.optionalText(input?.email, 180),
        pixKey: this.optionalText(input?.pixKey, 180),
        paymentNotes: this.optionalText(input?.paymentNotes, 2000),
        notes: this.optionalText(input?.notes, 4000),
        active: input?.active !== false,
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      },
    });
    await this.log(propertyId, null, user, 'create', 'vendor', vendor.id, {
      legalName: vendor.legalName,
      kind: vendor.kind,
    });
    return this.safeVendor(vendor);
  }

  async updateVendor(propertyId: string, vendorId: string, input: any, user: any) {
    await this.propertyOrThrow(propertyId);
    const current = await (this.prisma as any).constructionVendor.findUnique({ where: { id: vendorId } });
    if (!current) throw new NotFoundException('Fornecedor/prestador não encontrado.');
    const data: any = {};
    for (const field of ['tradeName', 'specialty', 'phone', 'email', 'pixKey', 'paymentNotes', 'notes']) {
      if (input?.[field] !== undefined) data[field] = this.optionalText(input[field], field === 'notes' ? 4000 : 2000);
    }
    if (input?.legalName !== undefined) data.legalName = this.requiredText(input.legalName, 'Nome/Razão social', 180);
    if (input?.kind !== undefined) data.kind = this.enumValue(input.kind, VENDOR_KINDS, 'Tipo de fornecedor');
    if (input?.active !== undefined) data.active = input.active === true;
    if (input?.document !== undefined) {
      const document = this.optionalText(input.document, 30);
      const documentNormalized = document ? document.replace(/\D/g, '') || null : null;
      if (documentNormalized && documentNormalized !== current.documentNormalized) {
        const duplicate = await (this.prisma as any).constructionVendor.findUnique({ where: { documentNormalized } });
        if (duplicate) throw new BadRequestException('Já existe fornecedor/prestador com este CPF/CNPJ.');
      }
      data.document = document;
      data.documentNormalized = documentNormalized;
    }
    const vendor = await (this.prisma as any).constructionVendor.update({ where: { id: vendorId }, data });
    await this.log(propertyId, null, user, 'update', 'vendor', vendorId, {
      legalName: vendor.legalName,
      active: vendor.active,
    });
    return this.safeVendor(vendor);
  }

  async createCommitment(propertyId: string, projectId: string, input: any, user: any) {
    await this.projectOrThrow(propertyId, projectId);
    await this.scopedRelationsOrThrow(projectId, input);
    const commitment = await (this.prisma as any).constructionCommitment.create({
      data: {
        projectId,
        stageId: input?.stageId || null,
        categoryId: input?.categoryId || null,
        vendorId: input?.vendorId || null,
        description: this.requiredText(input?.description, 'Descrição da contratação', 300),
        contractedAt: this.requiredDate(input?.contractedAt, 'Data da contratação'),
        amountCents: this.positiveCents(input?.amountCents, 'Valor contratado'),
        dueDate: this.optionalDate(input?.dueDate, 'Vencimento'),
        notes: this.optionalText(input?.notes, 4000),
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      },
    });
    await this.log(propertyId, projectId, user, 'create', 'commitment', commitment.id, {
      description: commitment.description,
      amountCents: commitment.amountCents,
    });
    return commitment;
  }

  async cancelCommitment(propertyId: string, projectId: string, commitmentId: string, input: any, user: any) {
    await this.commitmentOrThrow(propertyId, projectId, commitmentId);
    const commitment = await (this.prisma as any).constructionCommitment.update({
      where: { id: commitmentId },
      data: {
        status: 'cancelada',
        cancelledAt: new Date(),
        cancelledReason: this.requiredText(input?.reason, 'Motivo do cancelamento', 2000),
      },
    });
    await this.log(propertyId, projectId, user, 'cancel', 'commitment', commitmentId, {
      reason: commitment.cancelledReason,
    });
    return commitment;
  }

  async createPayment(propertyId: string, projectId: string, input: any, user: any) {
    await this.projectOrThrow(propertyId, projectId);
    await this.scopedRelationsOrThrow(projectId, input);
    const amountCents = this.positiveCents(input?.amountCents, 'Valor pago');
    let commitment: any = null;
    if (input?.commitmentId) {
      commitment = await this.commitmentOrThrow(propertyId, projectId, input.commitmentId, true);
      if (commitment.status === 'cancelada') throw new BadRequestException('A contratação está cancelada.');
      if (paymentExceedsCommitment({
        commitmentAmountCents: commitment.amountCents,
        currentPayments: commitment.payments,
        newPaymentCents: amountCents,
      }) && input?.allowOverpayment !== true) {
        throw new BadRequestException('O pagamento ultrapassa o saldo contratado. Confirme o pagamento excedente.');
      }
    }
    const payment = await (this.prisma as any).constructionPayment.create({
      data: {
        projectId,
        commitmentId: commitment?.id || null,
        stageId: input?.stageId || commitment?.stageId || null,
        vendorId: input?.vendorId || commitment?.vendorId || null,
        description: this.requiredText(
          input?.description || commitment?.description,
          'Descrição do pagamento',
          300,
        ),
        paidAt: this.requiredDate(input?.paidAt, 'Data do pagamento'),
        amountCents,
        paymentMethod: this.optionalText(input?.paymentMethod, 80),
        notes: this.optionalText(input?.notes, 4000),
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      },
    });
    if (commitment) await this.refreshCommitmentStatus(commitment.id);
    await this.log(propertyId, projectId, user, 'create', 'payment', payment.id, {
      description: payment.description,
      amountCents: payment.amountCents,
      commitmentId: payment.commitmentId,
    });
    return payment;
  }

  async reversePayment(propertyId: string, projectId: string, paymentId: string, input: any, user: any) {
    const payment = await this.paymentOrThrow(propertyId, projectId, paymentId);
    const amountCents = this.positiveCents(input?.amountCents, 'Valor do estorno');
    if (reversalExceedsPayment({ payment, newReversalCents: amountCents })) {
      throw new BadRequestException('O estorno ultrapassa o valor ainda não estornado do pagamento.');
    }
    const reversal = await (this.prisma as any).constructionPaymentReversal.create({
      data: {
        paymentId,
        occurredAt: this.requiredDate(input?.occurredAt, 'Data do estorno'),
        amountCents,
        reason: this.requiredText(input?.reason, 'Motivo do estorno', 2000),
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      },
    });
    const totalReversed = payment.reversals.reduce(
      (total: number, item: any) => total + item.amountCents,
      amountCents,
    );
    if (totalReversed >= payment.amountCents) {
      await (this.prisma as any).constructionPayment.update({
        where: { id: paymentId },
        data: { status: 'estornado' },
      });
    }
    if (payment.commitmentId) await this.refreshCommitmentStatus(payment.commitmentId);
    await this.log(propertyId, projectId, user, 'reverse', 'payment', paymentId, {
      reversalId: reversal.id,
      amountCents,
    });
    return reversal;
  }

  async createEntry(propertyId: string, projectId: string, input: any, user: any) {
    await this.projectOrThrow(propertyId, projectId);
    if (input?.vendorId) await this.optionalRelationOrThrow('constructionVendor', input.vendorId, 'Fornecedor');
    const entry = await (this.prisma as any).constructionEntry.create({
      data: {
        projectId,
        vendorId: input?.vendorId || null,
        type: this.enumValue(input?.type || 'aporte', ENTRY_TYPES, 'Tipo da entrada'),
        occurredAt: this.requiredDate(input?.occurredAt, 'Data da entrada'),
        description: this.requiredText(input?.description, 'Descrição da entrada', 300),
        amountCents: this.positiveCents(input?.amountCents, 'Valor da entrada'),
        notes: this.optionalText(input?.notes, 4000),
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      },
    });
    await this.log(propertyId, projectId, user, 'create', 'entry', entry.id, {
      type: entry.type,
      amountCents: entry.amountCents,
    });
    return entry;
  }

  async cancelEntry(propertyId: string, projectId: string, entryId: string, input: any, user: any) {
    const current = await (this.prisma as any).constructionEntry.findFirst({
      where: { id: entryId, projectId, project: { propertyId } },
    });
    if (!current) throw new NotFoundException('Entrada não encontrada nesta obra.');
    const entry = await (this.prisma as any).constructionEntry.update({
      where: { id: entryId },
      data: {
        status: 'cancelada',
        cancelledAt: new Date(),
        cancelledReason: this.requiredText(input?.reason, 'Motivo do cancelamento', 2000),
      },
    });
    await this.log(propertyId, projectId, user, 'cancel', 'entry', entryId, {
      reason: entry.cancelledReason,
    });
    return entry;
  }

  async ledger(propertyId: string, projectId: string, query: any) {
    await this.projectOrThrow(propertyId, projectId);
    const [entries, payments] = await Promise.all([
      (this.prisma as any).constructionEntry.findMany({
        where: { projectId, status: { not: 'cancelada' } },
        include: { vendor: true, documents: { where: { removedAt: null } } },
      }),
      (this.prisma as any).constructionPayment.findMany({
        where: { projectId },
        include: {
          vendor: true,
          stage: { select: { id: true, name: true } },
          commitment: { select: { id: true, description: true } },
          reversals: true,
          documents: { where: { removedAt: null } },
        },
      }),
    ]);

    const rows: any[] = [];
    for (const entry of entries) {
      rows.push({
        id: `entry:${entry.id}`,
        entityId: entry.id,
        type: 'entrada',
        subtype: entry.type,
        occurredAt: entry.occurredAt,
        description: entry.description,
        amountCents: entry.amountCents,
        vendor: entry.vendor ? this.safeVendor(entry.vendor) : null,
        vendorId: entry.vendorId,
        stageId: null,
        documents: entry.documents.map((item: any) => this.safeDocument(item)),
      });
    }
    for (const payment of payments) {
      rows.push({
        id: `payment:${payment.id}`,
        entityId: payment.id,
        type: 'pagamento',
        subtype: payment.paymentMethod,
        occurredAt: payment.paidAt,
        description: payment.description,
        amountCents: payment.amountCents,
        vendor: payment.vendor ? this.safeVendor(payment.vendor) : null,
        vendorId: payment.vendorId,
        stage: payment.stage,
        stageId: payment.stageId,
        commitment: payment.commitment,
        documents: payment.documents.map((item: any) => this.safeDocument(item)),
      });
      for (const reversal of payment.reversals) {
        rows.push({
          id: `reversal:${reversal.id}`,
          entityId: reversal.id,
          type: 'estorno',
          subtype: 'estorno',
          occurredAt: reversal.occurredAt,
          description: `Estorno: ${payment.description}`,
          amountCents: reversal.amountCents,
          vendor: payment.vendor ? this.safeVendor(payment.vendor) : null,
          vendorId: payment.vendorId,
          stage: payment.stage,
          stageId: payment.stageId,
          commitment: payment.commitment,
          documents: [],
        });
      }
    }

    const filtered = rows.filter((row) => {
      if (query?.type && row.type !== query.type) return false;
      if (query?.vendorId && row.vendorId !== query.vendorId) return false;
      if (query?.stageId && row.stageId !== query.stageId) return false;
      if (query?.documentStatus === 'com' && row.documents.length === 0) return false;
      if (query?.documentStatus === 'sem' && row.documents.length > 0) return false;
      return true;
    });
    return buildLedger(
      filtered,
      query?.from ? this.requiredDate(query.from, 'Data inicial') : null,
      query?.to ? this.requiredDate(query.to, 'Data final') : null,
    );
  }

  async addDocument(propertyId: string, projectId: string, input: any, uploaded: any, user: any) {
    await this.projectOrThrow(propertyId, projectId);
    const target = await this.documentTargetOrThrow(projectId, input);
    const document = await (this.prisma as any).constructionDocument.create({
      data: {
        projectId,
        commitmentId: target.commitmentId,
        paymentId: target.paymentId,
        entryId: target.entryId,
        kind: this.optionalText(input?.kind, 80) || 'recibo',
        fileName: uploaded.fileName,
        objectKey: uploaded.objectKey,
        fileSize: uploaded.fileSize,
        mimeType: uploaded.mimeType,
        uploadedByUserId: user?.id || null,
        uploadedByName: user?.name || null,
      },
    });
    await this.log(propertyId, projectId, user, 'upload', 'document', document.id, {
      fileName: document.fileName,
      kind: document.kind,
      paymentId: document.paymentId,
    });
    return this.safeDocument(document);
  }

  async documentForDownload(propertyId: string, projectId: string, documentId: string) {
    const document = await (this.prisma as any).constructionDocument.findFirst({
      where: { id: documentId, projectId, removedAt: null, project: { propertyId } },
    });
    if (!document) throw new NotFoundException('Documento não encontrado nesta obra.');
    return document;
  }

  async removeDocument(propertyId: string, projectId: string, documentId: string, user: any) {
    await this.documentForDownload(propertyId, projectId, documentId);
    const document = await (this.prisma as any).constructionDocument.update({
      where: { id: documentId },
      data: { removedAt: new Date(), removedByUserId: user?.id || null },
    });
    await this.log(propertyId, projectId, user, 'remove', 'document', documentId, {
      fileName: document.fileName,
    });
    return { ok: true };
  }

  async audits(propertyId: string, projectId: string) {
    await this.projectOrThrow(propertyId, projectId);
    return (this.prisma as any).constructionAuditLog.findMany({
      where: { propertyId, projectId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private async propertyOrThrow(propertyId: string) {
    const property = await (this.prisma as any).property.findUnique({
      where: { id: propertyId },
      select: { id: true, name: true },
    });
    if (!property) throw new NotFoundException('Imóvel não encontrado.');
    return property;
  }

  private async projectOrThrow(propertyId: string, projectId: string) {
    const project = await (this.prisma as any).propertyConstructionProject.findFirst({
      where: { id: projectId, propertyId },
    });
    if (!project) throw new NotFoundException('Obra não encontrada neste imóvel.');
    return project;
  }

  private async stageOrThrow(propertyId: string, projectId: string, stageId: string) {
    const stage = await (this.prisma as any).constructionStage.findFirst({
      where: { id: stageId, projectId, project: { propertyId } },
    });
    if (!stage) throw new NotFoundException('Etapa não encontrada nesta obra.');
    return stage;
  }

  private async commitmentOrThrow(propertyId: string, projectId: string, commitmentId: string, includePayments = false) {
    const commitment = await (this.prisma as any).constructionCommitment.findFirst({
      where: { id: commitmentId, projectId, project: { propertyId } },
      include: includePayments ? { payments: { include: { reversals: true } } } : undefined,
    });
    if (!commitment) throw new NotFoundException('Contratação não encontrada nesta obra.');
    return commitment;
  }

  private async paymentOrThrow(propertyId: string, projectId: string, paymentId: string) {
    const payment = await (this.prisma as any).constructionPayment.findFirst({
      where: { id: paymentId, projectId, project: { propertyId } },
      include: { reversals: true },
    });
    if (!payment) throw new NotFoundException('Pagamento não encontrado nesta obra.');
    return payment;
  }

  private async scopedRelationsOrThrow(projectId: string, input: any) {
    if (input?.stageId) {
      const stage = await (this.prisma as any).constructionStage.findFirst({
        where: { id: input.stageId, projectId },
      });
      if (!stage) throw new BadRequestException('A etapa não pertence a esta obra.');
    }
    await this.optionalRelationOrThrow('constructionCategory', input?.categoryId, 'Categoria');
    await this.optionalRelationOrThrow('constructionVendor', input?.vendorId, 'Fornecedor/prestador');
  }

  private async optionalRelationOrThrow(model: string, id: string | null | undefined, label: string) {
    if (!id) return;
    const record = await (this.prisma as any)[model].findUnique({ where: { id } });
    if (!record) throw new BadRequestException(`${label} não encontrado(a).`);
  }

  private async documentTargetOrThrow(projectId: string, input: any) {
    const targets = [input?.commitmentId, input?.paymentId, input?.entryId].filter(Boolean);
    if (targets.length !== 1) {
      throw new BadRequestException('Informe exatamente um destino para o documento.');
    }
    if (input?.commitmentId) {
      const record = await (this.prisma as any).constructionCommitment.findFirst({
        where: { id: input.commitmentId, projectId },
      });
      if (!record) throw new BadRequestException('A contratação não pertence a esta obra.');
      return { commitmentId: record.id, paymentId: null, entryId: null };
    }
    if (input?.paymentId) {
      const record = await (this.prisma as any).constructionPayment.findFirst({
        where: { id: input.paymentId, projectId },
      });
      if (!record) throw new BadRequestException('O pagamento não pertence a esta obra.');
      return { commitmentId: null, paymentId: record.id, entryId: null };
    }
    const record = await (this.prisma as any).constructionEntry.findFirst({
      where: { id: input.entryId, projectId },
    });
    if (!record) throw new BadRequestException('A entrada não pertence a esta obra.');
    return { commitmentId: null, paymentId: null, entryId: record.id };
  }

  private async refreshCommitmentStatus(commitmentId: string) {
    const commitment = await (this.prisma as any).constructionCommitment.findUnique({
      where: { id: commitmentId },
      include: { payments: { include: { reversals: true } } },
    });
    if (!commitment || commitment.status === 'cancelada') return;
    const paid = commitment.payments.reduce(
      (total: number, payment: any) => total + netPaymentCents(payment),
      0,
    );
    await (this.prisma as any).constructionCommitment.update({
      where: { id: commitmentId },
      data: { status: paid >= commitment.amountCents ? 'concluida' : 'ativa' },
    });
  }

  private async ensureDefaultCategories() {
    await (this.prisma as any).constructionCategory.createMany({
      data: DEFAULT_CATEGORIES.map((name) => ({ name, isDefault: true, active: true })),
      skipDuplicates: true,
    });
  }

  private async log(
    propertyId: string,
    projectId: string | null,
    user: any,
    action: string,
    entityType: string,
    entityId: string | null,
    details: any,
  ) {
    await (this.prisma as any).constructionAuditLog.create({
      data: {
        propertyId,
        projectId,
        action,
        entityType,
        entityId,
        details: details || undefined,
        userId: user?.id || null,
        userName: user?.name || null,
      },
    });
  }

  private safeDocument(document: any) {
    const { objectKey: _objectKey, ...safe } = document;
    return { ...safe, downloadAvailable: !document.removedAt };
  }

  private safeVendor(vendor: any) {
    const { documentNormalized: _normalized, ...safe } = vendor;
    return safe;
  }

  private isStageOverdue(stage: any) {
    return stage.status !== 'concluida'
      && stage.status !== 'cancelada'
      && Number(stage.progressPercent || 0) < 100
      && stage.plannedEndAt
      && this.endOfDay(stage.plannedEndAt) < new Date();
  }

  private requiredText(value: any, label: string, max = 1000) {
    const text = String(value || '').trim();
    if (!text) throw new BadRequestException(`${label} é obrigatório(a).`);
    if (text.length > max) throw new BadRequestException(`${label} ultrapassa ${max} caracteres.`);
    return text;
  }

  private optionalText(value: any, max = 1000) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const text = String(value).trim();
    if (text.length > max) throw new BadRequestException(`Texto ultrapassa ${max} caracteres.`);
    return text;
  }

  private enumValue(value: any, allowed: Set<string>, label: string) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!allowed.has(normalized)) throw new BadRequestException(`${label} inválido(a).`);
    return normalized;
  }

  private positiveCents(value: any, label: string) {
    const cents = Number(value);
    if (!Number.isInteger(cents) || cents <= 0 || cents > 2_000_000_000) {
      throw new BadRequestException(`${label} deve ser informado em centavos e maior que zero.`);
    }
    return cents;
  }

  private nonNegativeCents(value: any, label: string) {
    const cents = Number(value || 0);
    if (!Number.isInteger(cents) || cents < 0 || cents > 2_000_000_000) {
      throw new BadRequestException(`${label} inválido.`);
    }
    return cents;
  }

  private nonNegativeInteger(value: any, label: string) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new BadRequestException(`${label} inválida.`);
    return parsed;
  }

  private percent(value: any) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      throw new BadRequestException('Percentual deve estar entre 0 e 100.');
    }
    return parsed;
  }

  private requiredDate(value: any, label: string) {
    if (!value) throw new BadRequestException(`${label} é obrigatória.`);
    return this.parseDate(value, label);
  }

  private optionalDate(value: any, label: string) {
    if (value === null || value === undefined || value === '') return null;
    return this.parseDate(value, label);
  }

  private parseDate(value: any, label: string) {
    const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T12:00:00`
      : value;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} inválida.`);
    return date;
  }

  private endOfDay(value: Date | string) {
    const date = new Date(value);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  }
}
