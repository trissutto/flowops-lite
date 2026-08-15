import { ConflictException } from '@nestjs/common';
import { SiteContentEditorService } from './site-content-editor.service';

describe('SiteContentEditorService', () => {
  const prisma = {
    siteContentDraft: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), delete: jest.fn() },
    siteContentVersion: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  } as any;
  const produtos = { get: jest.fn(), upsert: jest.fn(), upsertCor: jest.fn() } as any;
  const service = new SiteContentEditorService(prisma, produtos);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.siteContentVersion.findFirst.mockResolvedValue(null);
  });

  it('salva rascunho privado pela chave composta do produto', async () => {
    prisma.siteContentDraft.upsert.mockResolvedValue({ id: 'draft-1', state: 'draft' });

    await expect(service.saveProductDraft({
      ref: ' bmm-100 ', marca: ' lurds ', cor: ' preto ', baseVersion: 0,
      ficha: { nomeCurto: 'Blusa Marrie' },
    }, { email: 'admin@lurds.com.br' })).resolves.toEqual({ id: 'draft-1', state: 'draft' });

    expect(prisma.siteContentDraft.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { resourceType_resourceKey: { resourceType: 'product', resourceKey: 'BMM-100|LURDS|PRETO' } },
      create: expect.objectContaining({ state: 'draft', baseVersion: 0 }),
    }));
    expect(produtos.upsert).not.toHaveBeenCalled();
  });

  it('impede rascunho baseado em versão antiga', async () => {
    prisma.siteContentVersion.findFirst.mockResolvedValue({ version: 3 });
    await expect(service.saveProductDraft({
      ref: 'BMM-100', marca: 'LURDS', baseVersion: 2, ficha: { descricao: 'Nova' },
    }, { sub: 'admin-1' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.siteContentDraft.upsert).not.toHaveBeenCalled();
  });

  it('publica ficha e cor, cria versão e remove o rascunho', async () => {
    prisma.siteContentVersion.findFirst.mockResolvedValue({ version: 2 });
    prisma.siteContentDraft.findUnique.mockResolvedValue({
      id: 'draft-1', baseVersion: 2,
      payload: {
        ref: 'BMM-100', marca: 'LURDS', cor: 'PRETO',
        ficha: { nomeCurto: 'Blusa Marrie' }, fichaCor: { tituloComercial: 'Preta' },
      },
    });
    prisma.siteContentDraft.update.mockResolvedValue({});
    prisma.siteContentVersion.create.mockResolvedValue({ version: 3 });
    prisma.siteContentDraft.delete.mockResolvedValue({});
    produtos.upsert.mockResolvedValue({});
    produtos.upsertCor.mockResolvedValue({});
    produtos.get.mockResolvedValue({ ref: 'BMM-100' });

    await expect(service.publishProduct('BMM-100', 'LURDS', 'PRETO', 2, { sub: 'admin-1' }))
      .resolves.toEqual(expect.objectContaining({ ok: true, version: 3 }));

    expect(produtos.upsert).toHaveBeenCalled();
    expect(produtos.upsertCor).toHaveBeenCalled();
    expect(prisma.siteContentVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 3, origin: 'publish' }),
    }));
    expect(prisma.siteContentDraft.delete).toHaveBeenCalledWith({ where: { id: 'draft-1' } });
  });
});
