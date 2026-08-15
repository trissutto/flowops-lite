import { BadRequestException, Injectable } from '@nestjs/common';
import { CloudflareImagesClient } from './cloudflare-images.client';

const MEDIA_KINDS = new Set(['product', 'banner', 'cover']);
const MAX_FILENAME = 180;

@Injectable()
export class SiteMediaService {
  constructor(private readonly cloudflare: CloudflareImagesClient) {}

  async createDirectUpload(input: { filename?: string; kind?: string; resourceKey?: string }, user: any) {
    const filename = String(input.filename || '').trim();
    const kind = String(input.kind || '').trim().toLowerCase();
    const resourceKey = String(input.resourceKey || '').trim();
    if (!filename || filename.length > MAX_FILENAME) throw new BadRequestException('Nome do arquivo inválido');
    if (!MEDIA_KINDS.has(kind)) throw new BadRequestException('Tipo de mídia inválido');
    if (!resourceKey || resourceKey.length > 160) throw new BadRequestException('Recurso inválido');

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const result = await this.cloudflare.createDirectUpload({
      kind,
      resourceKey,
      filename,
      uploadedBy: String(user?.sub || user?.email || 'admin'),
    }, expiresAt);
    return { ...result, expiresAt: expiresAt.toISOString() };
  }

  async confirm(idRaw: string) {
    const id = String(idRaw || '').trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new BadRequestException('Identificador de mídia inválido');
    const image = await this.cloudflare.get(id);
    return {
      id: image.id,
      filename: image.filename ?? null,
      uploadedAt: image.uploaded ?? null,
      ready: Array.isArray(image.variants) && image.variants.length > 0,
      variants: image.variants ?? [],
      metadata: image.meta ?? {},
    };
  }
}
