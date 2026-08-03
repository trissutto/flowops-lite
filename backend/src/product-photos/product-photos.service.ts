import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { refBaseOf, refsDeBusca } from '../common/ref-base';

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) {
    throw new Error('R2_* env não configuradas');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

@Injectable()
export class ProductPhotosService {
  private readonly logger = new Logger(ProductPhotosService.name);

  /** Teto da galeria por cor — o mesmo número que a ficha do site promete. */
  static readonly MAX_POR_COR = 6;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Busca A CAPA da REF (+ COR opcional).
   * Se não achar foto da COR específica, tenta foto genérica da REF.
   *
   * ⚠️ `orderBy: ordem` é obrigatório, não cosmético: desde que a galeria
   * passou a aceitar até 6 fotos por cor, existe mais de uma linha por
   * (ref, cor) e `findFirst` sem ordem devolveria uma qualquer — a foto do
   * produto no PDV mudaria sozinha entre uma consulta e outra.
   */
  async getPhoto(ref: string, cor?: string) {
    const refUp = (ref || '').trim().toUpperCase();
    if (!refUp) return null;
    const refs = refsDeBusca(refUp);
    const corUp = (cor || '').trim().toUpperCase() || null;
    // Tenta COR específica primeiro
    if (corUp) {
      const specific = await (this.prisma as any).productPhoto.findFirst({
        where: { ref: { in: refs }, cor: corUp },
        orderBy: { ordem: 'asc' },
      });
      if (specific) return specific;
    }
    // Fallback: foto genérica (cor = null)
    return (this.prisma as any).productPhoto.findFirst({
      where: { ref: { in: refs }, cor: null },
      orderBy: { ordem: 'asc' },
    });
  }

  /**
   * Galeria completa de uma cor, na ordem de exibição (capa primeiro).
   *
   * Procura pela REF-BASE **e** pela REF como veio. A foto nova é gravada na
   * base (uma galeria por família, que é o que o site mostra), mas o PDV, a
   * Reposição e a Separação bipam a REF INTEIRA — "VMS-223 MA" — e o acervo
   * importado antes da unificação também está sob ela. Procurar só num dos
   * dois lados faz a foto sumir de um lado ou do outro.
   */
  async listPhotos(ref: string, cor?: string) {
    const refUp = (ref || '').trim().toUpperCase();
    if (!refUp) return [];
    const refs = refsDeBusca(refUp);
    const corUp = (cor || '').trim().toUpperCase() || null;
    const achadas = await (this.prisma as any).productPhoto.findMany({
      where: { ref: { in: refs }, cor: corUp },
      orderBy: { ordem: 'asc' },
    });
    // Se a mesma cor tiver foto nos DOIS lugares (acervo antigo + novo), fica
    // com o da base — misturar as duas galerias duplicaria a capa.
    if (refs.length > 1 && achadas.some((f: any) => f.ref === refs[0])) {
      return achadas.filter((f: any) => f.ref === refs[0]);
    }
    return achadas;
  }

  /**
   * Busca várias fotos por REF (lista completa de cores).
   */
  async listByRef(ref: string) {
    const refUp = (ref || '').trim().toUpperCase();
    if (!refUp) return [];
    return (this.prisma as any).productPhoto.findMany({
      where: { ref: { in: refsDeBusca(refUp) } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Busca em batch — recebe lista de {ref, cor?} e retorna map.
   * Útil pra telas que listam vários produtos.
   */
  async getBatch(items: Array<{ ref: string; cor?: string }>) {
    const pedidas = Array.from(
      new Set(items.map((i) => (i.ref || '').trim().toUpperCase()).filter(Boolean)),
    );
    if (pedidas.length === 0) return {};
    // Busca a família inteira: a foto pode estar sob a base ("VMS-223") mesmo
    // que a tela tenha pedido a REF do cadastro ("VMS-223 MA").
    const refs = Array.from(new Set(pedidas.flatMap((r) => refsDeBusca(r))));
    const photos = await (this.prisma as any).productPhoto.findMany({
      where: { ref: { in: refs } },
      orderBy: { ordem: 'asc' },
    });
    // Indexa por "REF|COR" e por "REF|" (genérica)
    const map: Record<string, string> = {};
    for (const p of photos) {
      const key = `${p.ref}|${p.cor || ''}`;
      if (!map[key]) map[key] = p.url; // ordem 0 primeiro = capa
    }
    /**
     * A tela pergunta pela REF que ela tem na mão. Se a foto ficou gravada na
     * base, a chave dela não bate com a pergunta e a peça aparece sem foto —
     * o mesmo "sumiu" que já aconteceu com o espelho de estoque. Aqui a
     * resposta ganha também a chave PEDIDA, apontando pra mesma URL.
     */
    for (const pedida of pedidas) {
      const base = refBaseOf(pedida);
      if (base === pedida) continue;
      for (const [chave, url] of Object.entries(map)) {
        const [r, cor] = chave.split('|');
        if (r !== base) continue;
        const chavePedida = `${pedida}|${cor}`;
        if (!map[chavePedida]) map[chavePedida] = url;
      }
    }
    return map;
  }

  /**
   * Sobe foto pro R2 e grava a linha.
   *
   * ⚠️ ACRESCENTA à galeria (até 6 por cor) em vez de substituir. Até 03/08 este
   * método apagava a foto existente de (ref, cor) a cada upload — o modelo já
   * previa galeria (`@@unique([ref, cor, ordem])`), mas na prática nunca dava
   * pra ter a segunda foto, e a vitrine do site precisa de várias.
   *
   * Quem quer TROCAR uma foto específica (o "trocar foto" do PDV/Reposição)
   * manda `substituirId` — aí sim a antiga sai do R2 e a nova herda a ordem.
   */
  async upload(input: {
    ref: string;
    cor?: string;
    file: any; // multer file
    userId?: string;
    substituirId?: string;
  }) {
    // Grava sempre na REF-BASE: a galeria é da FAMÍLIA, não do cadastro. Sem
    // isto, "VMS-223 MA" e "VMS-223 MM" — o mesmo vestido — teriam galerias
    // separadas e o site mostraria dois produtos em vez de um com duas cores.
    const refUp = refBaseOf(input.ref);
    if (!refUp) throw new BadRequestException('REF obrigatório');
    if (!input.file) throw new BadRequestException('Arquivo obrigatório');
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado.');
    }

    const corUp = (input.cor || '').trim().toUpperCase() || null;

    // Decide ANTES de gastar upload: galeria cheia devolve erro sem subir nada.
    const irmas = await (this.prisma as any).productPhoto.findMany({
      where: { ref: refUp, cor: corUp },
      orderBy: { ordem: 'asc' },
    });
    const alvo = input.substituirId
      ? irmas.find((f: any) => f.id === input.substituirId)
      : null;
    if (input.substituirId && !alvo) {
      throw new BadRequestException('foto a substituir não encontrada nesta cor');
    }
    if (!alvo && irmas.length >= ProductPhotosService.MAX_POR_COR) {
      throw new BadRequestException(
        `esta cor já tem ${ProductPhotosService.MAX_POR_COR} fotos — remova uma antes de subir outra`,
      );
    }

    const safeName = (input.file.originalname || 'foto.jpg')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const corPath = corUp ? corUp.replace(/[^a-zA-Z0-9]/g, '_') : 'GENERICA';
    const objectKey = `produtos/${refUp}/${corPath}/${Date.now()}-${safeName}`;

    try {
      const client = getR2Client();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: input.file.buffer,
          // Content-type CONFIAVEL: o multer devolve 'application/octet-stream'
          // quando o navegador nao informa, e a foto fica no bucket com um tipo
          // que a API de visao recusa ("media_type: Input should be image/...").
          ContentType: (input.file.mimetype || '').startsWith('image/')
            ? input.file.mimetype
            : 'image/jpeg',
          ContentDisposition: `inline; filename="${input.file.originalname}"`,
        }),
      );
    } catch (e: any) {
      throw new BadRequestException(`Falha ao subir pro R2: ${e?.message || e}`);
    }

    const base = publicUrl.replace(/\/$/, '');
    const fullUrl = `${base}/${objectKey}`;

    // Trocar foto existente: a nova herda a ordem (a capa continua capa) e a
    // antiga sai do bucket.
    if (alvo) {
      if (alvo.objectKey) {
        try {
          await getR2Client().send(
            new DeleteObjectCommand({ Bucket: bucket, Key: alvo.objectKey }),
          );
        } catch (e: any) {
          this.logger.warn(`Falha ao deletar R2 antigo: ${e?.message}`);
        }
      }
      return (this.prisma as any).productPhoto.update({
        where: { id: alvo.id },
        data: {
          url: fullUrl,
          objectKey,
          uploadedByUserId: input.userId || null,
        },
      });
    }

    // Nova da galeria: entra no fim. `ordem` vem do MAIOR existente + 1 e não
    // de `length`, senão apagar a foto do meio recria colisão no unique.
    const proximaOrdem = irmas.length
      ? Math.max(...irmas.map((f: any) => Number(f.ordem) || 0)) + 1
      : 0;

    return (this.prisma as any).productPhoto.create({
      data: {
        ref: refUp,
        cor: corUp,
        url: fullUrl,
        objectKey,
        ordem: proximaOrdem,
        uploadedByUserId: input.userId || null,
      },
    });
  }

  /**
   * Reordena a galeria de uma cor — a primeira da lista vira a capa.
   *
   * Passa por ordem NEGATIVA antes de gravar a definitiva: o índice
   * `@@unique([ref, cor, ordem])` recusaria duas fotos com a mesma ordem no
   * meio da troca, mesmo que o estado final esteja correto.
   */
  async reordenar(ids: string[]) {
    const limpos = (ids || []).map((i) => String(i)).filter(Boolean);
    if (!limpos.length) throw new BadRequestException('nenhuma foto informada');

    const fotos = await (this.prisma as any).productPhoto.findMany({
      where: { id: { in: limpos } },
    });
    if (fotos.length !== limpos.length) {
      throw new BadRequestException('alguma foto da lista não existe mais');
    }
    const mesmaCor = fotos.every(
      (f: any) => f.ref === fotos[0].ref && (f.cor ?? null) === (fotos[0].cor ?? null),
    );
    if (!mesmaCor) throw new BadRequestException('as fotos precisam ser da mesma REF e cor');

    await this.prisma.$transaction([
      ...fotos.map((f: any, i: number) =>
        (this.prisma as any).productPhoto.update({
          where: { id: f.id },
          data: { ordem: -(i + 1) },
        }),
      ),
      ...limpos.map((id, i) =>
        (this.prisma as any).productPhoto.update({ where: { id }, data: { ordem: i } }),
      ),
    ]);

    return this.listPhotos(fotos[0].ref, fotos[0].cor ?? undefined);
  }

  /**
   * Remove foto (DB + R2).
   */
  async delete(id: string) {
    const photo = await (this.prisma as any).productPhoto.findUnique({ where: { id } });
    if (!photo) throw new BadRequestException('Foto não encontrada');
    const bucket = process.env.R2_BUCKET_NAME;
    if (bucket && photo.objectKey) {
      try {
        await getR2Client().send(
          new DeleteObjectCommand({ Bucket: bucket, Key: photo.objectKey }),
        );
      } catch (e: any) {
        this.logger.warn(`Falha ao deletar R2: ${e?.message}`);
      }
    }
    await (this.prisma as any).productPhoto.delete({ where: { id } });
    return { ok: true };
  }
}
