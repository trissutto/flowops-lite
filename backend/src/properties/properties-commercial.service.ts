import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublicationChecklist } from './properties-publication.contract';

const PROPERTY_TYPES = new Set([
  'casa',
  'apartamento',
  'terreno',
  'sala_comercial',
  'galpao',
  'loja',
  'outro',
]);

const COMMERCIAL_STATUSES = new Set([
  'disponivel',
  'reservado',
  'em_negociacao',
  'vendido',
]);

const MEDIA_KINDS = new Set(['photo', 'floorplan', 'video', 'virtual_tour', 'file']);

@Injectable()
export class PropertiesCommercialService {
  constructor(private readonly prisma: PrismaService) {}

  private async propertyOrThrow(id: string) {
    const property = await (this.prisma as any).property.findUnique({
      where: { id },
      include: {
        commercialProfile: true,
        commercialMedia: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        publication: true,
      },
    });
    if (!property) throw new NotFoundException('Imóvel não encontrado.');
    return property;
  }

  async get(id: string) {
    const property = await this.propertyOrThrow(id);
    const jobs = await (this.prisma as any).propertyPublicationJob.findMany({
      where: { propertyId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        action: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        completedAt: true,
      },
    });
    return {
      property: {
        id: property.id,
        name: property.name,
        cep: property.cep,
        endereco: property.endereco,
        numero: property.numero,
        complemento: property.complemento,
        bairro: property.bairro,
        cidade: property.cidade,
        estado: property.estado,
      },
      profile: property.commercialProfile,
      media: property.commercialMedia,
      publication: property.publication,
      checklist: buildPublicationChecklist(property),
      jobs,
    };
  }

  async updateProfile(id: string, input: any, user: any) {
    await this.propertyOrThrow(id);
    const data = this.sanitizeProfile(input);
    const profile = await (this.prisma as any).propertyCommercialProfile.upsert({
      where: { propertyId: id },
      create: { propertyId: id, ...data },
      update: data,
    });
    await this.markDirty(id);
    await this.log(id, user, 'update', 'commercial_profile', Object.keys(data));
    return this.get(id);
  }

  async addMedia(id: string, input: any, user: any) {
    await this.propertyOrThrow(id);
    const kind = String(input?.kind || 'photo');
    if (!MEDIA_KINDS.has(kind)) throw new BadRequestException('Tipo de mídia inválido.');
    const sourceUrl = this.requiredText(input?.sourceUrl, 'URL da mídia');
    if (!/^https:\/\//i.test(sourceUrl)) {
      throw new BadRequestException('A mídia deve usar uma URL HTTPS.');
    }
    const currentCount = await (this.prisma as any).propertyCommercialMedia.count({
      where: { propertyId: id },
    });
    const hasCover = await (this.prisma as any).propertyCommercialMedia.count({
      where: { propertyId: id, active: true, isCover: true },
    });
    const media = await (this.prisma as any).propertyCommercialMedia.create({
      data: {
        propertyId: id,
        kind,
        fileName: this.requiredText(input?.fileName || this.defaultFileName(kind), 'Nome do arquivo'),
        sourceUrl,
        sourceKey: this.optionalText(input?.sourceKey),
        mimeType: this.optionalText(input?.mimeType),
        fileSize: this.optionalInteger(input?.fileSize),
        caption: this.optionalText(input?.caption),
        sortOrder: currentCount,
        isCover: kind === 'photo' && hasCover === 0,
        active: input?.active !== false,
        uploadedByUserId: user?.id || null,
        uploadedByName: user?.name || null,
      },
    });
    await this.markDirty(id);
    await this.log(id, user, 'upload', 'commercial_media', {
      mediaId: media.id,
      kind: media.kind,
      fileName: media.fileName,
    });
    return media;
  }

  async updateMedia(propertyId: string, mediaId: string, input: any, user: any) {
    const existing = await (this.prisma as any).propertyCommercialMedia.findFirst({
      where: { id: mediaId, propertyId },
    });
    if (!existing) throw new NotFoundException('Mídia não encontrada.');

    const data: any = {};
    if (input?.caption !== undefined) data.caption = this.optionalText(input.caption);
    if (input?.active !== undefined) data.active = input.active === true;
    if (input?.sortOrder !== undefined) data.sortOrder = this.requiredInteger(input.sortOrder, 'Ordem');
    if (input?.isCover !== undefined) data.isCover = input.isCover === true && existing.kind === 'photo';

    await (this.prisma as any).$transaction(async (tx: any) => {
      if (data.isCover) {
        await tx.propertyCommercialMedia.updateMany({
          where: { propertyId, id: { not: mediaId } },
          data: { isCover: false },
        });
      }
      await tx.propertyCommercialMedia.update({ where: { id: mediaId }, data });
    });
    await this.markDirty(propertyId);
    await this.log(propertyId, user, 'update', 'commercial_media', { mediaId, ...data });
    return this.get(propertyId);
  }

  async reorderMedia(propertyId: string, orderedIds: string[], user: any) {
    await this.propertyOrThrow(propertyId);
    if (!Array.isArray(orderedIds) || orderedIds.length > 100) {
      throw new BadRequestException('Ordem de mídias inválida.');
    }
    const media = await (this.prisma as any).propertyCommercialMedia.findMany({
      where: { propertyId },
      select: { id: true },
    });
    const existingIds = new Set(media.map((item: any) => item.id));
    if (orderedIds.some((id) => !existingIds.has(id))) {
      throw new BadRequestException('A lista contém mídia de outro imóvel.');
    }
    await (this.prisma as any).$transaction(
      orderedIds.map((mediaId, sortOrder) =>
        (this.prisma as any).propertyCommercialMedia.update({
          where: { id: mediaId },
          data: { sortOrder },
        }),
      ),
    );
    await this.markDirty(propertyId);
    await this.log(propertyId, user, 'reorder', 'commercial_media', { orderedIds });
    return this.get(propertyId);
  }

  async deleteMedia(propertyId: string, mediaId: string, user: any) {
    const existing = await (this.prisma as any).propertyCommercialMedia.findFirst({
      where: { id: mediaId, propertyId },
    });
    if (!existing) throw new NotFoundException('Mídia não encontrada.');
    await (this.prisma as any).propertyCommercialMedia.delete({ where: { id: mediaId } });
    if (existing.isCover) {
      const nextPhoto = await (this.prisma as any).propertyCommercialMedia.findFirst({
        where: { propertyId, kind: 'photo', active: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      if (nextPhoto) {
        await (this.prisma as any).propertyCommercialMedia.update({
          where: { id: nextPhoto.id },
          data: { isCover: true },
        });
      }
    }
    await this.markDirty(propertyId);
    await this.log(propertyId, user, 'delete_attachment', 'commercial_media', {
      mediaId,
      fileName: existing.fileName,
    });
    return existing;
  }

  async propertyForPublication(id: string) {
    return this.propertyOrThrow(id);
  }

  private sanitizeProfile(input: any) {
    const propertyType = this.optionalText(input?.propertyType);
    if (propertyType && !PROPERTY_TYPES.has(propertyType)) {
      throw new BadRequestException('Tipo de imóvel inválido.');
    }
    const commercialStatus = this.optionalText(input?.commercialStatus) || 'disponivel';
    if (!COMMERCIAL_STATUSES.has(commercialStatus)) {
      throw new BadRequestException('Situação comercial inválida.');
    }
    const constructionYear = this.optionalInteger(input?.constructionYear);
    if (constructionYear && (constructionYear < 1800 || constructionYear > 2200)) {
      throw new BadRequestException('Ano de construção inválido.');
    }

    return {
      municipalRegistration: this.optionalText(input?.municipalRegistration),
      propertyType,
      commercialStatus,
      internalReference: this.optionalText(input?.internalReference),
      mapUrl: this.optionalHttpsUrl(input?.mapUrl),
      publicLocationNote: this.optionalText(input?.publicLocationNote, 2000),
      publishFullAddress: input?.publishFullAddress !== false,
      landAreaM2: this.optionalNumber(input?.landAreaM2),
      landAreaNotApplicable: input?.landAreaNotApplicable === true,
      builtAreaM2: this.optionalNumber(input?.builtAreaM2),
      builtAreaNotApplicable: input?.builtAreaNotApplicable === true,
      usefulAreaM2: this.optionalNumber(input?.usefulAreaM2),
      bedrooms: this.optionalInteger(input?.bedrooms),
      suites: this.optionalInteger(input?.suites),
      bathrooms: this.optionalInteger(input?.bathrooms),
      parkingSpaces: this.optionalInteger(input?.parkingSpaces),
      floor: this.optionalInteger(input?.floor),
      elevator: this.optionalBoolean(input?.elevator),
      furnished: this.optionalBoolean(input?.furnished),
      constructionYear,
      features: this.features(input?.features),
      salePrice: this.optionalNumber(input?.salePrice),
      condominiumMonthly: this.optionalNumber(input?.condominiumMonthly),
      iptuAnnual: this.optionalNumber(input?.iptuAnnual),
      acceptsFinancing: this.optionalBoolean(input?.acceptsFinancing),
      acceptsExchange: this.optionalBoolean(input?.acceptsExchange),
      negotiable: this.optionalBoolean(input?.negotiable),
      negotiationText: this.optionalText(input?.negotiationText, 3000),
      description: this.optionalText(input?.description, 12000),
      whatsappSummary: this.optionalText(input?.whatsappSummary, 3000),
      campaignTitle: this.optionalText(input?.campaignTitle, 160),
      lastReviewedAt: this.optionalDate(input?.lastReviewedAt),
      brokerCommissionNotes: this.optionalText(input?.brokerCommissionNotes, 3000),
      internalNegotiationNotes: this.optionalText(input?.internalNegotiationNotes, 6000),
    };
  }

  private async markDirty(propertyId: string) {
    const publication = await (this.prisma as any).propertyPublication.findUnique({
      where: { propertyId },
    });
    if (!publication || ['draft', 'unpublished', 'unpublishing'].includes(publication.status)) return;
    await (this.prisma as any).propertyPublication.update({
      where: { propertyId },
      data: { status: 'update_pending', lastError: null },
    });
  }

  private async log(propertyId: string, user: any, action: string, scope: string, details: any) {
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
    } catch {
      // Log nunca derruba o cadastro principal.
    }
  }

  private optionalText(value: unknown, max = 500): string | null {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : null;
  }

  private requiredText(value: unknown, label: string): string {
    const text = this.optionalText(value, 2000);
    if (!text) throw new BadRequestException(`${label} é obrigatória.`);
    return text;
  }

  private optionalNumber(value: unknown): number | null {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestException('Valor numérico inválido.');
    }
    return parsed;
  }

  private optionalInteger(value: unknown): number | null {
    const parsed = this.optionalNumber(value);
    return parsed === null ? null : Math.trunc(parsed);
  }

  private requiredInteger(value: unknown, label: string): number {
    const parsed = this.optionalInteger(value);
    if (parsed === null) throw new BadRequestException(`${label} inválida.`);
    return parsed;
  }

  private optionalBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
  }

  private optionalDate(value: unknown): Date | null {
    if (!value) return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Data inválida.');
    return date;
  }

  private optionalHttpsUrl(value: unknown): string | null {
    const text = this.optionalText(value, 2000);
    if (!text) return null;
    if (!/^https:\/\//i.test(text)) throw new BadRequestException('Use uma URL HTTPS.');
    return text;
  }

  private features(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => this.optionalText(item, 120)).filter(Boolean)))
      .slice(0, 50) as string[];
  }

  private defaultFileName(kind: string) {
    if (kind === 'video') return 'Vídeo';
    if (kind === 'virtual_tour') return 'Tour virtual';
    return 'Arquivo';
  }
}
