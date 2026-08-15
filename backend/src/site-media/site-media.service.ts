import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CloudflareImagesClient } from './cloudflare-images.client';
import { PrismaService } from '../prisma/prisma.service';
import { refBaseOf } from '../common/ref-base';

const MEDIA_KINDS = new Set(['product', 'banner', 'cover']);
const MAX_FILENAME = 180;

@Injectable()
export class SiteMediaService {
  constructor(private readonly cloudflare: CloudflareImagesClient, private readonly prisma: PrismaService) {}

  async createDirectUpload(input: { filename?: string; kind?: string; resourceKey?: string }, user: any) {
    const filename = String(input.filename || '').trim();
    const kind = String(input.kind || '').trim().toLowerCase();
    let resourceKey = String(input.resourceKey || '').trim();
    if (!filename || filename.length > MAX_FILENAME) throw new BadRequestException('Nome do arquivo inválido');
    if (!MEDIA_KINDS.has(kind)) throw new BadRequestException('Tipo de mídia inválido');
    if (!resourceKey || resourceKey.length > 160) throw new BadRequestException('Recurso inválido');
    if (kind === 'product') {
      const [ref, cor] = resourceKey.split('|');
      resourceKey = [refBaseOf(ref), String(cor || '').trim().toUpperCase()].filter(Boolean).join('|');
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const result = await this.cloudflare.createDirectUpload({
      kind,
      resourceKey,
      filename,
      uploadedBy: String(user?.sub || user?.email || 'admin'),
    }, expiresAt);
    return { ...result, expiresAt: expiresAt.toISOString() };
  }

  async confirm(idRaw: string, input?: { ref?: string; cor?: string; substituirId?: string }, user?: any) {
    const id = String(idRaw || '').trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new BadRequestException('Identificador de mídia inválido');
    const image = await this.cloudflare.get(id);
    const result: any = {
      id: image.id,
      filename: image.filename ?? null,
      uploadedAt: image.uploaded ?? null,
      ready: Array.isArray(image.variants) && image.variants.length > 0,
      variants: image.variants ?? [],
      metadata: image.meta ?? {},
    };
    if (!input?.ref) return result;
    if (!result.ready) throw new BadRequestException('A imagem ainda está sendo processada');
    const ref = refBaseOf(String(input.ref).trim().toUpperCase());
    const cor = String(input.cor || '').trim().toUpperCase() || null;
    const expectedKey = [ref, cor].filter(Boolean).join('|');
    if (String(image.meta?.resourceKey || '') !== expectedKey) {
      throw new BadRequestException('A imagem não pertence a este produto e cor');
    }
    const existing = await (this.prisma as any).productPhoto.findMany({ where: { ref, cor }, orderBy: { ordem: 'asc' } });
    const replacing = input.substituirId ? existing.find((photo: any) => photo.id === input.substituirId) : null;
    if (input.substituirId && !replacing) throw new BadRequestException('Foto a substituir não pertence a esta galeria');
    if (!replacing && existing.length >= 6) throw new BadRequestException('Esta cor já tem 6 fotos');
    const url = image.variants?.[0];
    if (!url) throw new BadRequestException('Cloudflare não devolveu uma variante pública');
    const data = { ref, cor, url, objectKey: `cloudflare:${id}`, ordem: replacing?.ordem ?? (existing.length ? Math.max(...existing.map((p: any) => Number(p.ordem) || 0)) + 1 : 0), uploadedByUserId: user?.id || user?.sub || null };
    const photo = replacing
      ? await (this.prisma as any).productPhoto.update({ where: { id: replacing.id }, data })
      : await (this.prisma as any).productPhoto.create({ data });
    if (replacing?.objectKey?.startsWith('cloudflare:')) {
      await this.cloudflare.delete(String(replacing.objectKey).slice('cloudflare:'.length)).catch(() => undefined);
    }
    return { ...result, photo };
  }

  async removePhoto(photoId: string) {
    const photo = await (this.prisma as any).productPhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw new NotFoundException('Foto não encontrada');
    const key = String(photo.objectKey || '');
    if (!key.startsWith('cloudflare:')) throw new BadRequestException('Esta foto antiga deve ser removida pelo editor legado');
    await this.cloudflare.delete(key.slice('cloudflare:'.length));
    await (this.prisma as any).productPhoto.delete({ where: { id: photoId } });
    return { ok: true };
  }
}
