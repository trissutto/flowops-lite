import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PropertiesCommercialService } from './properties-commercial.service';
import { preparePublicProperty } from './properties-publication.contract';

export function signPublicationBody(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');
}

@Injectable()
export class PropertiesPublicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commercial: PropertiesCommercialService,
  ) {}

  async preview(propertyId: string) {
    const property = await this.commercial.propertyForPublication(propertyId);
    const publication = property.publication;
    const publicId = publication?.publicId || this.newPublicId();
    const version = Number(publication?.operationVersion || 0) + 1;
    const prepared = preparePublicProperty(property, publicId, version);
    return {
      ...prepared,
      publicUrl: this.publicUrl(publicId),
      publication,
    };
  }

  async publish(propertyId: string, user: any) {
    this.ensureConfigured();
    const property = await this.commercial.propertyForPublication(propertyId);
    const publication = await this.ensurePublication(propertyId);
    const targetStatus = publication.publishedVersion > 0 ? 'updating' : 'publishing';
    return this.enqueueSnapshot(property, publication, 'upsert', targetStatus, user);
  }

  async unpublish(propertyId: string, user: any) {
    this.ensureConfigured();
    const publication = await (this.prisma as any).propertyPublication.findUnique({
      where: { propertyId },
    });
    if (!publication || publication.publishedVersion < 1) {
      throw new BadRequestException('Este imóvel ainda não foi publicado.');
    }

    const queued = await (this.prisma as any).$transaction(async (tx: any) => {
      const updated = await tx.propertyPublication.update({
        where: { id: publication.id },
        data: {
          operationVersion: { increment: 1 },
          status: 'unpublishing',
          lastError: null,
        },
      });
      await tx.propertyPublicationJob.updateMany({
        where: { propertyId, status: { in: ['pending', 'retry', 'failed'] } },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      const job = await tx.propertyPublicationJob.create({
        data: {
          propertyId,
          action: 'revoke',
          idempotencyKey: randomUUID(),
          payload: {
            action: 'revoke',
            publicId: publication.publicId,
            version: updated.operationVersion,
          },
        },
      });
      await tx.propertyPublication.update({
        where: { id: publication.id },
        data: { activeJobId: job.id },
      });
      return { publication: updated, job };
    });
    await this.log(propertyId, user, 'unpublish_requested', {
      jobId: queued.job.id,
      version: queued.publication.operationVersion,
    });
    return this.status(propertyId);
  }

  async rotateLink(propertyId: string, user: any) {
    this.ensureConfigured();
    const property = await this.commercial.propertyForPublication(propertyId);
    const publication = property.publication;
    if (!publication || publication.publishedVersion < 1 || publication.status === 'unpublished') {
      throw new BadRequestException('Publique o imóvel antes de trocar o link.');
    }
    const newPublicId = this.newPublicId();
    return this.enqueueSnapshot(
      property,
      publication,
      'rotate',
      'updating',
      user,
      newPublicId,
    );
  }

  async retry(propertyId: string, user: any) {
    this.ensureConfigured();
    const publication = await (this.prisma as any).propertyPublication.findUnique({
      where: { propertyId },
    });
    if (!publication?.activeJobId) throw new NotFoundException('Nenhuma operação para repetir.');
    const job = await (this.prisma as any).propertyPublicationJob.findUnique({
      where: { id: publication.activeJobId },
    });
    if (!job || !['failed', 'retry'].includes(job.status)) {
      throw new BadRequestException('A operação atual não precisa ser repetida.');
    }
    const payload: any = job.payload || {};
    const status = payload.action === 'revoke'
      ? 'unpublishing'
      : publication.publishedVersion > 0 ? 'updating' : 'publishing';
    await (this.prisma as any).$transaction([
      (this.prisma as any).propertyPublicationJob.update({
        where: { id: job.id },
        data: { status: 'pending', nextAttemptAt: new Date(), lockedAt: null, lastError: null },
      }),
      (this.prisma as any).propertyPublication.update({
        where: { id: publication.id },
        data: { status, lastError: null },
      }),
    ]);
    await this.log(propertyId, user, 'publication_retry_requested', { jobId: job.id });
    return this.status(propertyId);
  }

  async status(propertyId: string) {
    return this.commercial.get(propertyId);
  }

  private async enqueueSnapshot(
    property: any,
    publication: any,
    action: 'upsert' | 'rotate',
    targetStatus: string,
    user: any,
    forcedPublicId?: string,
  ) {
    const propertyId = property.id;
    const result = await (this.prisma as any).$transaction(async (tx: any) => {
      const updated = await tx.propertyPublication.update({
        where: { id: publication.id },
        data: {
          operationVersion: { increment: 1 },
          status: targetStatus,
          lastError: null,
        },
      });
      const targetPublicId = forcedPublicId || publication.publicId;
      const prepared = preparePublicProperty(
        property,
        targetPublicId,
        updated.operationVersion,
      );
      if (!prepared.checklist.ready) {
        const missing = prepared.checklist.items.filter((item) => !item.ok).map((item) => item.label);
        throw new BadRequestException({
          message: 'Ficha incompleta para publicação.',
          missing,
        });
      }
      const payloadHash = createHash('sha256')
        .update(JSON.stringify({ snapshot: prepared.snapshot, mediaSources: prepared.mediaSources }))
        .digest('hex');

      await tx.propertyPublicationJob.updateMany({
        where: { propertyId, status: { in: ['pending', 'retry', 'failed'] } },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      const job = await tx.propertyPublicationJob.create({
        data: {
          propertyId,
          action,
          idempotencyKey: randomUUID(),
          payload: {
            action,
            publicId: targetPublicId,
            oldPublicId: action === 'rotate' ? publication.publicId : null,
            version: updated.operationVersion,
            payloadHash,
            publicUrl: this.publicUrl(targetPublicId),
            snapshot: prepared.snapshot,
            mediaSources: prepared.mediaSources,
          },
        },
      });
      await tx.propertyPublication.update({
        where: { id: publication.id },
        data: { activeJobId: job.id },
      });
      return { job, updated, prepared, payloadHash, targetPublicId };
    });

    await this.log(propertyId, user, `${action}_requested`, {
      jobId: result.job.id,
      version: result.updated.operationVersion,
      publicId: result.targetPublicId,
    });
    return this.status(propertyId);
  }

  private async ensurePublication(propertyId: string) {
    const existing = await (this.prisma as any).propertyPublication.findUnique({
      where: { propertyId },
    });
    if (existing) return existing;
    return (this.prisma as any).propertyPublication.create({
      data: {
        propertyId,
        publicId: this.newPublicId(),
        status: 'draft',
      },
    });
  }

  private newPublicId() {
    return randomBytes(18).toString('base64url');
  }

  private publicUrl(publicId: string) {
    const base = (process.env.PUBLIC_PROPERTIES_BASE_URL || 'https://imoveis.lurds.com.br')
      .replace(/\/$/, '');
    return `${base}/i/${publicId}`;
  }

  private ensureConfigured() {
    if (!process.env.PUBLIC_PROPERTIES_SYNC_URL || !process.env.PUBLIC_PROPERTIES_SYNC_SECRET) {
      throw new BadRequestException(
        'Portal público ainda não configurado. Defina PUBLIC_PROPERTIES_SYNC_URL e PUBLIC_PROPERTIES_SYNC_SECRET.',
      );
    }
  }

  private async log(propertyId: string, user: any, action: string, details: any) {
    try {
      await (this.prisma as any).propertyLog.create({
        data: {
          propertyId,
          userId: user?.id || null,
          userName: user?.name || null,
          action,
          scope: 'publication',
          details: JSON.stringify(details),
        },
      });
    } catch {
      // Auditoria não bloqueia a fila.
    }
  }
}
