import { BadRequestException } from '@nestjs/common';
import { CloudflareImagesClient } from './cloudflare-images.client';
import { SiteMediaService } from './site-media.service';

describe('SiteMediaService', () => {
  const cloudflare = {
    createDirectUpload: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
  } as unknown as CloudflareImagesClient;
  const prisma = { productPhoto: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), delete: jest.fn() } } as any;
  const service = new SiteMediaService(cloudflare, prisma);

  beforeEach(() => jest.clearAllMocks());

  it('cria upload temporário com metadados administrativos', async () => {
    (cloudflare.createDirectUpload as jest.Mock).mockResolvedValue({ id: 'image_123', uploadURL: 'https://upload.example' });

    const result = await service.createDirectUpload(
      { filename: 'produto.jpg', kind: 'product', resourceKey: 'BMM-100|PRETO' },
      { sub: 'user-1' },
    );

    expect(result.id).toBe('image_123');
    expect(result.expiresAt).toMatch(/Z$/);
    expect(cloudflare.createDirectUpload).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'product', resourceKey: 'BMM-100|PRETO', uploadedBy: 'user-1' }),
      expect.any(Date),
    );
  });

  it.each([
    [{ filename: '', kind: 'product', resourceKey: 'BMM-100' }, 'nome'],
    [{ filename: 'foto.jpg', kind: 'outro', resourceKey: 'BMM-100' }, 'tipo'],
    [{ filename: 'foto.jpg', kind: 'product', resourceKey: '' }, 'recurso'],
  ])('rejeita entrada inválida %#', async (input) => {
    await expect(service.createDirectUpload(input, { sub: 'user-1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(cloudflare.createDirectUpload).not.toHaveBeenCalled();
  });

  it('confirma imagem processada', async () => {
    (cloudflare.get as jest.Mock).mockResolvedValue({
      id: 'image_123', filename: 'produto.jpg', uploaded: '2026-08-15T12:00:00Z',
      variants: ['https://imagedelivery.net/hash/image_123/catalog-card'], meta: { kind: 'product' },
    });

    await expect(service.confirm('image_123')).resolves.toEqual(expect.objectContaining({
      id: 'image_123', ready: true, filename: 'produto.jpg',
    }));
  });

  it('vincula imagem processada à galeria correta', async () => {
    (cloudflare.get as jest.Mock).mockResolvedValue({
      id: 'image_123', variants: ['https://imagedelivery.net/hash/image_123/public'],
      meta: { kind: 'product', resourceKey: 'BMM-100|PRETO' },
    });
    prisma.productPhoto.findMany.mockResolvedValue([]);
    prisma.productPhoto.create.mockImplementation(({ data }: any) => ({ id: 'photo-1', ...data }));

    const result = await service.confirm('image_123', { ref: 'BMM-100', cor: 'preto' }, { sub: 'user-1' });

    expect(result.photo).toEqual(expect.objectContaining({ ref: 'BMM-100', cor: 'PRETO', ordem: 0 }));
    expect(prisma.productPhoto.create).toHaveBeenCalledWith({ data: expect.objectContaining({ objectKey: 'cloudflare:image_123' }) });
  });

  it('substitui a foto preservando sua posição', async () => {
    (cloudflare.get as jest.Mock).mockResolvedValue({ id: 'image_new', variants: ['https://imagedelivery.net/hash/image_new/public'], meta: { resourceKey: 'BMM-100|PRETO' } });
    prisma.productPhoto.findMany.mockResolvedValue([{ id: 'photo-1', ref: 'BMM-100', cor: 'PRETO', ordem: 0, objectKey: 'cloudflare:image_old' }]);
    prisma.productPhoto.update.mockImplementation(({ data }: any) => ({ id: 'photo-1', ...data }));
    (cloudflare.delete as jest.Mock).mockResolvedValue({});

    const result = await service.confirm('image_new', { ref: 'BMM-100', cor: 'PRETO', substituirId: 'photo-1' }, { sub: 'user-1' });

    expect(result.photo).toEqual(expect.objectContaining({ id: 'photo-1', ordem: 0, objectKey: 'cloudflare:image_new' }));
    expect(cloudflare.delete).toHaveBeenCalledWith('image_old');
  });

  it('não consulta identificador inválido', async () => {
    await expect(service.confirm('../secret')).rejects.toBeInstanceOf(BadRequestException);
    expect(cloudflare.get).not.toHaveBeenCalled();
  });
});
