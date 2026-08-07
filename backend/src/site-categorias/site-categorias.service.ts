import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CorIaService } from '../product-photos/cor-ia.service';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * CATEGORIAS DA VITRINE — foto, nome e texto de cada /categoria/<slug>.
 *
 * ⚠️ ESTA TABELA NÃO CRIA CATEGORIA. Quem cria é o cadastro do produto: a
 * categoria existe porque tem peça publicada nela. Aqui só se VESTE o que já
 * existe. Foi decisão consciente — categoria cadastrada à mão sem peça dentro
 * é vitrine vazia, o mesmo erro do "Fitness" que estava fixo no menu.
 *
 * Por isso `listarAdmin` devolve a UNIÃO: as categorias reais do catálogo (com
 * a contagem de peças) + a configuração de cada uma, quando existe.
 *
 * FOTO + FOCO (dono 07/08): sem foto escolhida à mão, a foto é a da PEÇA MAIS
 * NOVA da categoria — e o RECORTE (`focoX/focoY/focoZoom`) vem da IA olhando
 * a foto e mirando na peça que representa a categoria (a calça, não a modelo
 * inteira). O resultado fica em cache na própria linha, ligado à REF que
 * gerou a foto (`imagemDeRef`): só reprocessa quando a peça em destaque muda,
 * não a cada carregamento de página.
 */

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

export interface CategoriaInput {
  slug?: string;
  nome?: string | null;
  titulo?: string | null;
  intro?: string | null;
  alt?: string | null;
  ordem?: number;
  ativo?: boolean;
  destaque?: boolean;
}

interface FotoResolvida {
  imagemUrl: string | null;
  alt: string | null;
  focoX: number | null;
  focoY: number | null;
  focoZoom: number | null;
}

@Injectable()
export class SiteCategoriasService {
  private readonly logger = new Logger(SiteCategoriasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly corIa: CorIaService,
  ) {}

  private texto(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return s || null;
  }

  private normSlug(v: unknown): string {
    return String(v ?? '').trim().toLowerCase();
  }

  /** "moda-praia" → "Moda praia". Fallback de quem ainda não foi configurada. */
  private nomeDoSlug(slug: string): string {
    const s = slug.replace(/[-_]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
  }

  /** Avisa a vitrine (mesma regra dos banners — ver `site-banners.service`). */
  private avisarSite() {
    const base = (process.env.ECOMMERCE_URL || '').split(',')[0].trim().replace(/\/$/, '');
    const segredo = (process.env.REVALIDATE_SECRET || '').trim();
    if (!base || !segredo) return;
    void fetch(`${base}/api/revalidar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': segredo },
      body: JSON.stringify({ tags: ['categorias', 'filtros'] }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => this.logger.warn(`[categorias] não avisei o site: ${e?.message || e}`));
  }

  /** Slugs que EXISTEM de verdade, com quantas peças publicadas cada um tem. */
  private async doCatalogo(): Promise<Map<string, number>> {
    const linhas: Array<{ categoria: string | null }> = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true },
      select: { categoria: true },
    });
    const mapa = new Map<string, number>();
    for (const l of linhas) {
      const c = this.normSlug(l.categoria);
      if (!c) continue;
      mapa.set(c, (mapa.get(c) || 0) + 1);
    }
    return mapa;
  }

  /**
   * A foto da PEÇA MAIS NOVA publicada na categoria — candidata do automático.
   * Pula REF sem foto (algumas ainda não têm) até achar uma que sirva.
   */
  private async fotoAutoDaCategoria(slug: string): Promise<{ url: string; ref: string; alt: string } | null> {
    const produtos: Array<{ ref: string; nome: string | null }> = await (this.prisma as any).siteProduto.findMany({
      where: { categoria: slug, publicado: true },
      orderBy: { createdAt: 'desc' },
      select: { ref: true, nome: true },
      take: 10,
    });
    for (const p of produtos) {
      const foto = await (this.prisma as any).productPhoto.findFirst({
        where: { ref: p.ref },
        orderBy: { ordem: 'asc' },
        select: { url: true },
      });
      if (foto?.url) return { url: foto.url, ref: p.ref, alt: p.nome || '' };
    }
    return null;
  }

  /**
   * Foto final + recorte de uma categoria: manual sempre manda; sem manual,
   * resolve pelo automático e — só quando a REF em destaque MUDA — chama a
   * IA de novo e cacheia o resultado na linha. Nunca lança: falha na IA ou
   * na resolução automática cai pra "sem foto" (o card vira tipografia),
   * nunca derruba a listagem inteira.
   */
  private async resolverFotoEFoco(
    slug: string, nomeCategoria: string, atual: any,
  ): Promise<FotoResolvida> {
    try {
      // Foto MANUAL (sem imagemDeRef) nunca é sobrescrita pelo automático.
      if (atual?.imagemUrl && !atual?.imagemDeRef) {
        return {
          imagemUrl: atual.imagemUrl, alt: atual.alt,
          focoX: atual.focoX, focoY: atual.focoY, focoZoom: atual.focoZoom,
        };
      }

      const auto = await this.fotoAutoDaCategoria(slug);
      if (!auto) return { imagemUrl: null, alt: null, focoX: null, focoY: null, focoZoom: null };

      // Mesma REF de antes → usa o foco já cacheado, sem chamar IA de novo.
      if (atual?.imagemDeRef === auto.ref && atual?.imagemUrl) {
        return {
          imagemUrl: atual.imagemUrl, alt: atual.alt || auto.alt,
          focoX: atual.focoX, focoY: atual.focoY, focoZoom: atual.focoZoom,
        };
      }

      // Peça em destaque mudou (ou é a primeira vez): lê o foco e cacheia.
      let foco: { focoX: number; focoY: number; zoom: number } | null = null;
      try {
        foco = await this.corIa.detectarFoco(auto.url, nomeCategoria);
      } catch (e: any) {
        this.logger.warn(`[categorias] foco automático falhou (${slug}): ${e?.message || e}`);
      }
      const salvo = await (this.prisma as any).siteCategoria.upsert({
        where: { slug },
        create: {
          slug, imagemUrl: auto.url, imagemDeRef: auto.ref, alt: auto.alt || null,
          focoX: foco?.focoX ?? null, focoY: foco?.focoY ?? null, focoZoom: foco?.zoom ?? null,
        },
        update: {
          imagemUrl: auto.url, imagemDeRef: auto.ref, alt: auto.alt || null,
          focoX: foco?.focoX ?? null, focoY: foco?.focoY ?? null, focoZoom: foco?.zoom ?? null,
        },
      });
      return {
        imagemUrl: salvo.imagemUrl, alt: salvo.alt,
        focoX: salvo.focoX, focoY: salvo.focoY, focoZoom: salvo.focoZoom,
      };
    } catch (e: any) {
      this.logger.warn(`[categorias] resolverFotoEFoco falhou (${slug}): ${e?.message || e}`);
      return { imagemUrl: atual?.imagemUrl ?? null, alt: atual?.alt ?? null, focoX: null, focoY: null, focoZoom: null };
    }
  }

  /**
   * TELA DA RETAGUARDA: toda categoria que existe no catálogo, configurada ou
   * não, com a contagem de peças. Categoria configurada que perdeu todas as
   * peças aparece com `qtdPecas: 0` — some do site, mas não some da tela: quem
   * cadastrou precisa entender por que sumiu.
   */
  async listarAdmin() {
    const [catalogo, configs] = await Promise.all([
      this.doCatalogo(),
      (this.prisma as any).siteCategoria.findMany({ orderBy: { ordem: 'asc' } }),
    ]);
    const porSlug = new Map<string, any>(configs.map((c: any) => [c.slug, c]));
    const slugs = new Set<string>([...catalogo.keys(), ...porSlug.keys()]);

    const linhas = await Promise.all(
      Array.from(slugs).map(async (slug) => {
        const c = porSlug.get(slug);
        const qtdPecas = catalogo.get(slug) ?? 0;
        const nomeExibido = c?.nome || this.nomeDoSlug(slug);
        const foto = qtdPecas > 0 ? await this.resolverFotoEFoco(slug, nomeExibido, c) : null;
        return {
          id: c?.id ?? null,
          slug,
          nome: c?.nome ?? null,
          nomeExibido,
          titulo: c?.titulo ?? null,
          intro: c?.intro ?? null,
          imagemUrl: foto?.imagemUrl ?? null,
          alt: foto?.alt ?? null,
          focoX: foto?.focoX ?? null,
          focoY: foto?.focoY ?? null,
          focoZoom: foto?.focoZoom ?? null,
          fotoAutomatica: !!(c?.imagemDeRef),
          ordem: c?.ordem ?? 0,
          ativo: c?.ativo ?? true,
          destaque: c?.destaque ?? false,
          qtdPecas,
          configurada: !!c,
        };
      }),
    );
    return linhas.sort((a, b) => a.ordem - b.ordem || b.qtdPecas - a.qtdPecas);
  }

  /** O que o site consome: só categoria ATIVA e COM peça. */
  async listarPublico() {
    const [catalogo, configs] = await Promise.all([
      this.doCatalogo(),
      (this.prisma as any).siteCategoria.findMany({ orderBy: { ordem: 'asc' } }),
    ]);
    const porSlug = new Map<string, any>(configs.map((c: any) => [c.slug, c]));

    const validas = Array.from(catalogo.entries()).filter(
      ([slug]) => porSlug.get(slug)?.ativo !== false,
    );
    const linhas = await Promise.all(
      validas.map(async ([slug, qtdPecas]) => {
        const c = porSlug.get(slug);
        const nome = c?.nome || this.nomeDoSlug(slug);
        const foto = await this.resolverFotoEFoco(slug, nome, c);
        return {
          slug,
          nome,
          titulo: c?.titulo ?? null,
          intro: c?.intro ?? null,
          imagemUrl: foto.imagemUrl,
          alt: foto.alt,
          focoX: foto.focoX,
          focoY: foto.focoY,
          focoZoom: foto.focoZoom,
          ordem: c?.ordem ?? 0,
          destaque: c?.destaque ?? false,
          qtdPecas,
        };
      }),
    );
    return linhas.sort((a, b) => a.ordem - b.ordem || b.qtdPecas - a.qtdPecas);
  }

  /** Cria a configuração da categoria na primeira edição. Slug é a chave. */
  private async garantir(slug: string, usuario?: string) {
    const s = this.normSlug(slug);
    if (!s) throw new BadRequestException('slug da categoria é obrigatório');
    return (this.prisma as any).siteCategoria.upsert({
      where: { slug: s },
      create: { slug: s, atualizadoPor: usuario ?? null },
      update: {},
    });
  }

  async salvar(slug: string, dados: CategoriaInput, usuario?: string) {
    const atual = await this.garantir(slug, usuario);

    const patch: Record<string, unknown> = { atualizadoPor: usuario ?? null };
    for (const campo of ['nome', 'titulo', 'intro', 'alt'] as const) {
      if (dados[campo] !== undefined) patch[campo] = this.texto(dados[campo]);
    }
    if (dados.ordem !== undefined) patch.ordem = Number(dados.ordem) || 0;
    if (dados.ativo !== undefined) patch.ativo = Boolean(dados.ativo);
    if (dados.destaque !== undefined) patch.destaque = Boolean(dados.destaque);

    const salvo = await (this.prisma as any).siteCategoria.update({
      where: { id: atual.id },
      data: patch,
    });
    this.avisarSite();
    return salvo;
  }

  async subirImagem(slug: string, file: any, usuario?: string) {
    const atual = await this.garantir(slug, usuario);
    if (!file) throw new BadRequestException('arquivo obrigatório');

    const bucket = process.env.R2_BUCKET_NAME;
    const publico = process.env.R2_PUBLIC_URL;
    if (!bucket || !publico) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado');
    }

    const nome = (file.originalname || 'categoria.jpg')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const key = `categorias/${atual.slug}/${Date.now()}-${nome}`;

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

    const anterior = atual.objectKey;
    const url = `${publico.replace(/\/$/, '')}/${key}`;

    // Foto escolhida À MÃO: lê o foco na hora (mesmo motor do automático),
    // pra não publicar uma foto sem o recorte de close aplicado.
    let foco: { focoX: number; focoY: number; zoom: number } | null = null;
    try {
      foco = await this.corIa.detectarFoco(url, atual.nome || this.nomeDoSlug(atual.slug));
    } catch (e: any) {
      this.logger.warn(`[categorias] foco da foto manual falhou (${atual.slug}): ${e?.message || e}`);
    }

    const salvo = await (this.prisma as any).siteCategoria.update({
      where: { id: atual.id },
      data: {
        imagemUrl: url,
        objectKey: key,
        // imagemDeRef=null MARCA foto manual — nunca é sobrescrita pelo automático.
        imagemDeRef: null,
        focoX: foco?.focoX ?? null,
        focoY: foco?.focoY ?? null,
        focoZoom: foco?.zoom ?? null,
        atualizadoPor: usuario ?? null,
      },
    });

    // Só apaga a antiga DEPOIS que a nova está gravada (mesma regra dos banners).
    if (anterior) {
      try {
        await getR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: anterior }));
      } catch (e: any) {
        this.logger.warn(`R2: não apagou ${anterior}: ${e?.message || e}`);
      }
    }
    this.avisarSite();
    return salvo;
  }

  /** Tira só a FOTO — a categoria continua existindo (ela é do catálogo).
   *  Volta a valer o automático (peça mais nova) na próxima leitura. */
  async removerImagem(slug: string) {
    const atual = await (this.prisma as any).siteCategoria.findUnique({
      where: { slug: this.normSlug(slug) },
    });
    if (!atual) throw new NotFoundException('categoria não configurada');
    if (atual.objectKey) {
      try {
        await getR2Client().send(
          new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: atual.objectKey }),
        );
      } catch (e: any) {
        this.logger.warn(`R2: não apagou ${atual.objectKey}: ${e?.message || e}`);
      }
    }
    const salvo = await (this.prisma as any).siteCategoria.update({
      where: { id: atual.id },
      data: {
        imagemUrl: null, objectKey: null, imagemDeRef: null,
        focoX: null, focoY: null, focoZoom: null,
      },
    });
    this.avisarSite();
    return salvo;
  }
}
