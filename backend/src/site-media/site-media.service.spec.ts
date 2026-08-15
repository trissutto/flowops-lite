import { BadRequestException } from '@nestjs/common';
import { CloudflareImagesClient } from './cloudflare-images.client';
import { SiteMediaService } from './site-media.service';

describe('SiteMediaService', () => {
  const cloudflare = {
    createDirectUpload: jest.fn(),
    get: jest.fn(),
  } as unknown as CloudflareImagesClient;
  const service = new SiteMediaService(cloudflare);

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

  it('não consulta identificador inválido', async () => {
    await expect(service.confirm('../secret')).rejects.toBeInstanceOf(BadRequestException);
    expect(cloudflare.get).not.toHaveBeenCalled();
  });
});
