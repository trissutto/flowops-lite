import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { signPublicationBody } from './properties-publication.service';

@Injectable()
export class PropertiesPublicationWorker {
  private readonly logger = new Logger(PropertiesPublicationWorker.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron('*/10 * * * * *', { name: 'properties-publication-outbox' })
  async tick() {
    if (this.running) return;
    const url = process.env.PUBLIC_PROPERTIES_SYNC_URL;
    const secret = process.env.PUBLIC_PROPERTIES_SYNC_SECRET;
    if (!url || !secret) return;
    this.running = true;
    try {
      for (let index = 0; index < 3; index++) {
        const job = await this.claimNext();
        if (!job) break;
        await this.process(job, url, secret);
      }
    } finally {
      this.running = false;
    }
  }

  private async claimNext() {
    const staleLock = new Date(Date.now() - 5 * 60 * 1000);
    const candidate = await (this.prisma as any).propertyPublicationJob.findFirst({
      where: {
        status: { in: ['pending', 'retry', 'processing'] },
        nextAttemptAt: { lte: new Date() },
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: staleLock } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return null;
    const claimed = await (this.prisma as any).propertyPublicationJob.updateMany({
      where: {
        id: candidate.id,
        status: { in: ['pending', 'retry', 'processing'] },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLock } }],
      },
      data: {
        status: 'processing',
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;
    return (this.prisma as any).propertyPublicationJob.findUnique({
      where: { id: candidate.id },
    });
  }

  private async process(job: any, url: string, secret: string) {
    try {
      const body = JSON.stringify(job.payload);
      const timestamp = String(Date.now());
      const nonce = randomBytes(16).toString('hex');
      const signature = signPublicationBody(secret, timestamp, nonce, body);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-flowops-timestamp': timestamp,
            'x-flowops-nonce': nonce,
            'x-flowops-signature': signature,
            'x-idempotency-key': job.idempotencyKey,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1500);
        throw new Error(`Portal respondeu ${response.status}: ${detail}`);
      }
      await response.json().catch(() => ({}));
      await this.complete(job);
    } catch (error: any) {
      await this.fail(job, error?.name === 'AbortError' ? 'Tempo esgotado ao publicar.' : error?.message || String(error));
    }
  }

  private async complete(job: any) {
    const payload: any = job.payload || {};
    await (this.prisma as any).$transaction(async (tx: any) => {
      await tx.propertyPublicationJob.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          completedAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      });
      const publication = await tx.propertyPublication.findUnique({
        where: { propertyId: job.propertyId },
      });
      if (!publication || publication.activeJobId !== job.id) return;

      if (payload.action === 'revoke') {
        await tx.propertyPublication.update({
          where: { id: publication.id },
          data: {
            status: 'unpublished',
            publishedVersion: Number(payload.version),
            publicUrl: null,
            syncedAt: new Date(),
            lastError: null,
            activeJobId: null,
          },
        });
        return;
      }

      const wasEditedDuringSync = publication.status === 'update_pending';
      await tx.propertyPublication.update({
        where: { id: publication.id },
        data: {
          publicId: String(payload.publicId),
          status: wasEditedDuringSync ? 'update_pending' : 'published',
          publishedVersion: Number(payload.version),
          payloadHash: String(payload.payloadHash || ''),
          publicUrl: String(payload.publicUrl || ''),
          publishedAt: publication.publishedAt || new Date(),
          syncedAt: new Date(),
          lastError: null,
          activeJobId: null,
        },
      });
    });
    await this.log(job.propertyId, 'publication_succeeded', {
      jobId: job.id,
      action: job.action,
      version: payload.version,
    });
  }

  private async fail(job: any, rawMessage: string) {
    const message = String(rawMessage || 'Falha desconhecida').slice(0, 2000);
    const payload: any = job.payload || {};
    const maxAttempts = payload.action === 'revoke' ? 50 : 20;
    const terminal = Number(job.attempts || 0) >= maxAttempts;
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, Number(job.attempts || 1) - 1));
    await (this.prisma as any).$transaction(async (tx: any) => {
      await tx.propertyPublicationJob.update({
        where: { id: job.id },
        data: {
          status: terminal ? 'failed' : 'retry',
          nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
          lockedAt: null,
          lastError: message,
        },
      });
      const publication = await tx.propertyPublication.findUnique({
        where: { propertyId: job.propertyId },
      });
      if (publication?.activeJobId === job.id) {
        await tx.propertyPublication.update({
          where: { id: publication.id },
          data: { status: 'error', lastError: message },
        });
      }
    });
    this.logger.warn(`[properties-publication] ${job.id}: ${message}`);
  }

  private async log(propertyId: string, action: string, details: any) {
    try {
      await (this.prisma as any).propertyLog.create({
        data: {
          propertyId,
          userName: 'Sistema',
          action,
          scope: 'publication',
          details: JSON.stringify(details),
        },
      });
    } catch {
      // Auditoria não derruba o worker.
    }
  }
}
