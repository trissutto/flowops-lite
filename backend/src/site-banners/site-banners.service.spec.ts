import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { otimizarBanner, SiteBannersService } from './site-banners.service';

jest.mock('../common/avisar-vitrine', () => ({ avisarVitrine: jest.fn() }));

describe('otimizarBanner', () => {
  it('converte PNG grande em WebP e limita o desktop sem recortar', async () => {
    const original = await sharp({
      create: { width: 3000, height: 1200, channels: 3, background: '#b48a56' },
    }).png().toBuffer();

    const resultado = await otimizarBanner(original, 'desktop');

    expect(resultado.format).toBe('webp');
    expect(resultado.width).toBe(2216);
    expect(resultado.height).toBe(886);
    expect(resultado.originalBytes).toBe(original.length);
    expect(resultado.optimizedBytes).toBe(resultado.buffer.length);
    expect((await sharp(resultado.buffer).metadata()).format).toBe('webp');
  });

  it('limita mobile a 992px e não amplia uma imagem menor', async () => {
    const grande = await sharp({
      create: { width: 1600, height: 2400, channels: 3, background: '#111111' },
    }).jpeg().toBuffer();
    const pequena = await sharp({
      create: { width: 420, height: 700, channels: 3, background: '#eeeeee' },
    }).png().toBuffer();

    await expect(otimizarBanner(grande, 'mobile')).resolves.toMatchObject({
      width: 992,
      height: 1488,
    });
    await expect(otimizarBanner(pequena, 'mobile')).resolves.toMatchObject({
      width: 420,
      height: 700,
    });
  });

  it('recusa arquivo vazio ou corrompido', async () => {
    await expect(otimizarBanner(Buffer.alloc(0), 'desktop')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(otimizarBanner(Buffer.from('não é imagem'), 'desktop')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('SiteBannersService.subirImagem', () => {
  const send = jest.spyOn(S3Client.prototype, 'send');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.R2_ACCOUNT_ID = 'conta';
    process.env.R2_ACCESS_KEY_ID = 'chave';
    process.env.R2_SECRET_ACCESS_KEY = 'segredo';
    process.env.R2_BUCKET_NAME = 'bucket';
    process.env.R2_PUBLIC_URL = 'https://cdn.exemplo.com';
  });

  afterAll(() => send.mockRestore());

  it('envia WebP com cache imutável e só então atualiza o banco', async () => {
    const chamadas: string[] = [];
    send.mockImplementation(async (command: any) => {
      chamadas.push(command instanceof PutObjectCommand ? 'upload' : 'delete');
      return {} as any;
    });
    const prisma = {
      siteBanner: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'b1', slot: 'home-hero', objectKey: 'banners/antigo.png', objectKeyMobile: null,
        }),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          chamadas.push('database');
          return { id: 'b1', slot: 'home-hero', ...data };
        }),
      },
    };
    const arquivo = await sharp({
      create: { width: 2400, height: 800, channels: 3, background: '#ae8352' },
    }).png().toBuffer();

    const resultado = await new SiteBannersService(prisma as any).subirImagem(
      'b1',
      { buffer: arquivo, originalname: 'Campanha Verão.png', mimetype: 'image/png' },
      'desktop',
    );

    expect(chamadas).toEqual(['upload', 'database', 'delete']);
    const put = send.mock.calls[0][0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: 'bucket',
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(put.input.Key).toMatch(/desktop-\d+-Campanha_Verao\.webp$/);
    expect(Buffer.isBuffer(put.input.Body)).toBe(true);
    expect(resultado.imagemUrl).toContain('.webp');
    expect(resultado.otimizacao).toMatchObject({ format: 'webp', width: 2216 });
  });

  it('não altera o banco nem apaga o anterior quando o upload falha', async () => {
    send.mockImplementationOnce(async () => {
      throw new Error('R2 fora');
    });
    const prisma = {
      siteBanner: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'b1', slot: 'home-hero', objectKey: 'banners/antigo.png', objectKeyMobile: null,
        }),
        update: jest.fn(),
      },
    };
    const arquivo = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    }).png().toBuffer();

    await expect(
      new SiteBannersService(prisma as any).subirImagem(
        'b1', { buffer: arquivo, originalname: 'x.png' }, 'desktop',
      ),
    ).rejects.toThrow('falha ao subir pro R2');
    expect(prisma.siteBanner.update).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).not.toBeInstanceOf(DeleteObjectCommand);
  });

  it('remove o novo objeto quando o banco falha e preserva o anterior', async () => {
    send.mockImplementation(async () => ({} as any));
    const prisma = {
      siteBanner: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'b1', slot: 'home-hero', objectKey: 'banners/antigo.png', objectKeyMobile: null,
        }),
        update: jest.fn().mockRejectedValue(new Error('banco fora')),
      },
    };
    const arquivo = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    }).png().toBuffer();

    await expect(
      new SiteBannersService(prisma as any).subirImagem(
        'b1', { buffer: arquivo, originalname: 'x.png' }, 'desktop',
      ),
    ).rejects.toThrow('banco fora');

    expect(send).toHaveBeenCalledTimes(2);
    const rollback = send.mock.calls[1][0] as DeleteObjectCommand;
    expect(rollback.input.Key).toMatch(/desktop-\d+-x\.webp$/);
    expect(rollback.input.Key).not.toBe('banners/antigo.png');
  });
});
