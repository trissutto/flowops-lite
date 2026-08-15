import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FichaCorInput, FichaInput, ProdutoFichaService } from '../produto-ficha/produto-ficha.service';

export type ProductDraftPayload = {
  ref: string;
  marca: string;
  cor?: string | null;
  ficha?: FichaInput;
  fichaCor?: FichaCorInput;
};

@Injectable()
export class SiteContentEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly produtos: ProdutoFichaService,
  ) {}

  private productKey(refRaw: string, marcaRaw: string, corRaw?: string | null) {
    const ref = String(refRaw || '').trim().toUpperCase();
    const marca = String(marcaRaw || '').trim().toUpperCase();
    const cor = String(corRaw || '').trim().toUpperCase();
    if (!ref || !marca) throw new BadRequestException('REF e marca são obrigatórias');
    if (ref.length > 60 || marca.length > 80 || cor.length > 80) {
      throw new BadRequestException('Identificação do produto inválida');
    }
    return { ref, marca, cor: cor || null, key: [ref, marca, cor].filter(Boolean).join('|') };
  }

  private actor(user: any) {
    return String(user?.name || user?.email || user?.sub || 'admin').slice(0, 160);
  }

  async getProduct(ref: string, marca: string, cor?: string) {
    const id = this.productKey(ref, marca, cor);
    const [published, draft, latest] = await Promise.all([
      this.produtos.get(id.ref, id.marca),
      (this.prisma as any).siteContentDraft.findUnique({
        where: { resourceType_resourceKey: { resourceType: 'product', resourceKey: id.key } },
      }),
      (this.prisma as any).siteContentVersion.findFirst({
        where: { resourceType: 'product', resourceKey: id.key }, orderBy: { version: 'desc' },
      }),
    ]);
    return { resourceKey: id.key, published, draft, currentVersion: latest?.version ?? 0 };
  }

  async saveProductDraft(input: ProductDraftPayload & { baseVersion?: number }, user: any) {
    const id = this.productKey(input.ref, input.marca, input.cor);
    const latest = await (this.prisma as any).siteContentVersion.findFirst({
      where: { resourceType: 'product', resourceKey: id.key }, orderBy: { version: 'desc' },
      select: { version: true },
    });
    const currentVersion = latest?.version ?? 0;
    const requestedVersion = Number(input.baseVersion ?? currentVersion);
    if (requestedVersion !== currentVersion) {
      throw new ConflictException({
        message: 'O produto foi publicado por outra pessoa. Recarregue antes de salvar.',
        currentVersion,
      });
    }

    const payload: ProductDraftPayload = {
      ref: id.ref, marca: id.marca, cor: id.cor,
      ficha: input.ficha ?? {}, fichaCor: input.fichaCor ?? {},
    };
    return (this.prisma as any).siteContentDraft.upsert({
      where: { resourceType_resourceKey: { resourceType: 'product', resourceKey: id.key } },
      create: {
        resourceType: 'product', resourceKey: id.key, payload,
        baseVersion: currentVersion, editedBy: this.actor(user), state: 'draft',
      },
      update: {
        payload, baseVersion: currentVersion, editedBy: this.actor(user),
        state: 'draft', errorMessage: null,
      },
    });
  }

  async publishProduct(ref: string, marca: string, cor: string | undefined, baseVersion: number, user: any) {
    const id = this.productKey(ref, marca, cor);
    const draft = await (this.prisma as any).siteContentDraft.findUnique({
      where: { resourceType_resourceKey: { resourceType: 'product', resourceKey: id.key } },
    });
    if (!draft) throw new NotFoundException('Rascunho não encontrado');

    const latest = await (this.prisma as any).siteContentVersion.findFirst({
      where: { resourceType: 'product', resourceKey: id.key }, orderBy: { version: 'desc' },
      select: { version: true },
    });
    const currentVersion = latest?.version ?? 0;
    if (Number(baseVersion) !== currentVersion || draft.baseVersion !== currentVersion) {
      throw new ConflictException({ message: 'Existe uma publicação mais recente.', currentVersion });
    }

    const payload = draft.payload as ProductDraftPayload;
    await (this.prisma as any).siteContentDraft.update({ where: { id: draft.id }, data: { state: 'publishing' } });
    try {
      if (payload.ficha && Object.keys(payload.ficha).length) {
        await this.produtos.upsert(id.ref, id.marca, payload.ficha, this.actor(user));
      }
      if (id.cor && payload.fichaCor && Object.keys(payload.fichaCor).length) {
        await this.produtos.upsertCor(id.ref, id.marca, id.cor, payload.fichaCor, this.actor(user));
      }
      const version = currentVersion + 1;
      const saved = await (this.prisma as any).siteContentVersion.create({
        data: {
          resourceType: 'product', resourceKey: id.key, version, payload,
          origin: 'publish', publishedBy: this.actor(user),
        },
      });
      await (this.prisma as any).siteContentDraft.delete({ where: { id: draft.id } });
      return { ok: true, version: saved.version, published: await this.produtos.get(id.ref, id.marca) };
    } catch (error) {
      await (this.prisma as any).siteContentDraft.update({
        where: { id: draft.id },
        data: { state: 'failed', errorMessage: error instanceof Error ? error.message : 'Falha ao publicar' },
      }).catch(() => undefined);
      throw error;
    }
  }

  listProductVersions(ref: string, marca: string, cor?: string) {
    const id = this.productKey(ref, marca, cor);
    return (this.prisma as any).siteContentVersion.findMany({
      where: { resourceType: 'product', resourceKey: id.key },
      orderBy: { version: 'desc' }, take: 50,
    });
  }
}
