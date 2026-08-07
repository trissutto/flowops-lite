import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * BANNERS DA VITRINE — o conteúdo editorial do site que a loja troca sozinha.
 *
 * O site pede por SLOT ('home-hero', 'home-faixa', 'tarja-topo') e recebe só o
 * que está no ar naquele instante. Quem decide "no ar" é aqui, não o site:
 * ativo + dentro da janela de datas. Assim a campanha entra e sai sozinha, e o
 * cache do site (ISR) é a única defasagem.
 *
 * As imagens vão pro mesmo R2 das fotos de produto.
 */

export const SLOTS = ['home-hero', 'home-faixa', 'tarja-topo'] as const;
export type Slot = (typeof SLOTS)[number];

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) {
    throw new BadRequestException('R2_* não configurado — sem isso não dá pra subir imagem');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

export interface BannerInput {
  slot?: string;
  eyebrow?: string | null;
  titulo?: string | null;
  destaque?: string | null;
  subtitulo?: string | null;
  imagemUrl?: string | null;
  imagemMobileUrl?: string | null;
  alt?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  cta2Label?: string | null;
  cta2Href?: string | null;
  ordem?: number;
  ativo?: boolean;
  inicioEm?: string | null;
  fimEm?: string | null;
}

@Injectable()
export class SiteBannersService {
  private readonly logger = new Logger(SiteBannersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * AVISA O SITE que o conteúdo mudou (dono 07/08).
   *
   * Sem isto, a vitrine só via o banner novo quando o cache de 1 hora vencia —
   * o dono publicava, abria o site, via o hero antigo e mexia tudo de novo
   * achando que não tinha salvo.
   *
   * Nunca lança e nunca espera: banner é enfeite, e um site fora do ar não pode
   * impedir a retaguarda de gravar. Falhou? O cache de 1 hora resolve sozinho —
   * volta a ser exatamente o comportamento de antes.
   */
  private avisarSite(tags: string[]) {
    const base = (process.env.ECOMMERCE_URL || '').split(',')[0].trim().replace(/\/$/, '');
    const segredo = (process.env.REVALIDATE_SECRET || '').trim();
    if (!base || !segredo) return;
    void fetch(`${base}/api/revalidar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': segredo },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => {
        if (!r.ok) this.logger.warn(`[banners] site respondeu ${r.status} ao revalidar`);
      })
      .catch((e) => this.logger.warn(`[banners] não avisei o site: ${e?.message || e}`));
  }

  /** Tags do slot — o serviço do site marca o cache com estas mesmas. */
  private tagsDoSlot(slot?: string | null): string[] {
    const s = String(slot || '').trim();
    return s ? ['banners', `banners:${s}`] : ['banners'];
  }

  private texto(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return s || null;
  }

  private data(v: unknown): Date | null {
    if (!v) return null;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Tudo do slot (ou de todos), inclusive fora do ar — é a visão da retaguarda. */
  async listarAdmin(slot?: string) {
    return (this.prisma as any).siteBanner.findMany({
      where: slot ? { slot } : {},
      orderBy: [{ slot: 'asc' }, { ordem: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * O que o SITE vê: ativo e dentro da janela. `agora` entra como parâmetro
   * pra ficar testável e pra não haver dois relógios diferentes na mesma
   * requisição quando o slot é consultado duas vezes.
   */
  async listarPublico(slot: string, agora = new Date()) {
    const s = this.texto(slot);
    if (!s) return [];
    const linhas = await (this.prisma as any).siteBanner.findMany({
      where: {
        slot: s,
        ativo: true,
        AND: [
          { OR: [{ inicioEm: null }, { inicioEm: { lte: agora } }] },
          { OR: [{ fimEm: null }, { fimEm: { gte: agora } }] },
        ],
      },
      orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }],
    });
    // O site não precisa (nem deve) saber a chave do objeto no bucket.
    return linhas.map(({ objectKey, objectKeyMobile, atualizadoPor, ...pub }: any) => pub);
  }

  async criar(dados: BannerInput, usuario?: string) {
    const slot = this.texto(dados.slot);
    if (!slot || !(SLOTS as readonly string[]).includes(slot)) {
      throw new BadRequestException(`slot inválido — use ${SLOTS.join(', ')}`);
    }
    this.avisarSite(this.tagsDoSlot(slot));
    return (this.prisma as any).siteBanner.create({
      data: {
        slot,
        eyebrow: this.texto(dados.eyebrow),
        titulo: this.texto(dados.titulo),
        destaque: this.texto(dados.destaque),
        subtitulo: this.texto(dados.subtitulo),
        imagemUrl: this.texto(dados.imagemUrl),
        imagemMobileUrl: this.texto(dados.imagemMobileUrl),
        alt: this.texto(dados.alt),
        ctaLabel: this.texto(dados.ctaLabel),
        ctaHref: this.texto(dados.ctaHref),
        cta2Label: this.texto(dados.cta2Label),
        cta2Href: this.texto(dados.cta2Href),
        ordem: Number(dados.ordem) || 0,
        ativo: dados.ativo === undefined ? true : Boolean(dados.ativo),
        inicioEm: this.data(dados.inicioEm),
        fimEm: this.data(dados.fimEm),
        atualizadoPor: usuario ?? null,
      },
    });
  }

  async atualizar(id: string, dados: BannerInput, usuario?: string) {
    const atual = await (this.prisma as any).siteBanner.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('banner não encontrado');

    const patch: Record<string, unknown> = { atualizadoPor: usuario ?? null };
    const textos: (keyof BannerInput)[] = [
      'eyebrow', 'titulo', 'destaque', 'subtitulo', 'imagemUrl', 'imagemMobileUrl',
      'alt', 'ctaLabel', 'ctaHref', 'cta2Label', 'cta2Href',
    ];
    for (const campo of textos) {
      if (dados[campo] !== undefined) patch[campo] = this.texto(dados[campo]);
    }
    if (dados.slot !== undefined) {
      const s = this.texto(dados.slot);
      if (!s || !(SLOTS as readonly string[]).includes(s)) {
        throw new BadRequestException(`slot inválido — use ${SLOTS.join(', ')}`);
      }
      patch.slot = s;
    }
    if (dados.ordem !== undefined) patch.ordem = Number(dados.ordem) || 0;
    if (dados.ativo !== undefined) patch.ativo = Boolean(dados.ativo);
    if (dados.inicioEm !== undefined) patch.inicioEm = this.data(dados.inicioEm);
    if (dados.fimEm !== undefined) patch.fimEm = this.data(dados.fimEm);

    const salvo = await (this.prisma as any).siteBanner.update({ where: { id }, data: patch });
    // Slot novo E antigo: mover banner de slot muda os dois lados da vitrine.
    this.avisarSite([
      ...new Set([...this.tagsDoSlot(salvo.slot), ...this.tagsDoSlot(atual.slot)]),
    ]);
    return salvo;
  }

  async remover(id: string) {
    const atual = await (this.prisma as any).siteBanner.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('banner não encontrado');
    for (const key of [atual.objectKey, atual.objectKeyMobile]) {
      if (!key) continue;
      try {
        await getR2Client().send(
          new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }),
        );
      } catch (e: any) {
        // Imagem órfã no bucket incomoda menos que banner que não sai da tela.
        this.logger.warn(`R2: não apagou ${key}: ${e?.message || e}`);
      }
    }
    await (this.prisma as any).siteBanner.delete({ where: { id } });
    this.avisarSite(this.tagsDoSlot(atual.slot));
    return { ok: true };
  }

  /**
   * Sobe a imagem e já grava no banner. `variante` diz qual campo recebe —
   * desktop ou o recorte de celular.
   */
  async subirImagem(id: string, file: any, variante: 'desktop' | 'mobile' = 'desktop') {
    const banner = await (this.prisma as any).siteBanner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException('banner não encontrado');
    if (!file) throw new BadRequestException('arquivo obrigatório');

    const bucket = process.env.R2_BUCKET_NAME;
    const publico = process.env.R2_PUBLIC_URL;
    if (!bucket || !publico) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado');
    }

    const nome = (file.originalname || 'banner.jpg')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const key = `banners/${banner.slot}/${id}/${variante}-${Date.now()}-${nome}`;

    try {
      await getR2Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype || 'image/jpeg',
          ContentDisposition: `inline; filename="${nome}"`,
        }),
      );
    } catch (e: any) {
      throw new BadRequestException(`falha ao subir pro R2: ${e?.message || e}`);
    }

    const anterior = variante === 'mobile' ? banner.objectKeyMobile : banner.objectKey;
    const url = `${publico.replace(/\/$/, '')}/${key}`;
    const atualizado = await (this.prisma as any).siteBanner.update({
      where: { id },
      data: variante === 'mobile'
        ? { imagemMobileUrl: url, objectKeyMobile: key }
        : { imagemUrl: url, objectKey: key },
    });

    // Só apaga a antiga DEPOIS que a nova está gravada — se o banco falhar, a
    // imagem que está no ar continua existindo.
    if (anterior) {
      try {
        await getR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: anterior }));
      } catch (e: any) {
        this.logger.warn(`R2: não apagou ${anterior}: ${e?.message || e}`);
      }
    }
    this.avisarSite(this.tagsDoSlot(banner.slot));
    return atualizado;
  }
}
