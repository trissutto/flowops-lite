import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { refBaseOf, refsDeBusca } from '../common/ref-base';
import {
  medirImagem, fotoBaixaResolucao, FOTO_LARGURA_MINIMA, FOTO_ALTURA_MINIMA,
} from '../common/medir-imagem';
// Só os ESTÁTICOS (assinatura de formato) — não há injeção nem ciclo aqui.
import { CorIaService } from './cor-ia.service';

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

    /**
     * Mede o arquivo pra saber se a peça vai aparecer nítida na vitrine.
     * Formato exótico devolve null e a foto entra sem medida — a medição é
     * informação, não portaria (ver common/medir-imagem.ts).
     */
    const tamanho = medirImagem(input.file.buffer);
    if (tamanho && fotoBaixaResolucao(tamanho.largura, tamanho.altura)) {
      this.logger.warn(
        `[foto] ${refUp}${corUp ? ` ${corUp}` : ''}: ${tamanho.largura}x${tamanho.altura} — ` +
          `abaixo de ${FOTO_LARGURA_MINIMA}x${FOTO_ALTURA_MINIMA}, vai sair borrada na PDP`,
      );
    }
    const medida = { larguraPx: tamanho?.largura ?? null, alturaPx: tamanho?.altura ?? null };

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
          ...medida,
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
        ...medida,
      },
    });
  }

  /**
   * As fotos que vão sair borradas na vitrine, capa primeiro.
   *
   * Capa antes das outras de propósito: é a que aparece na listagem, no Meta e
   * no card — uma capa pequena custa mais que a 4ª foto da galeria.
   */
  async listarBaixaResolucao(limite = 200) {
    const fotos: any[] = await this.prisma.$queryRawUnsafe(
      `
      SELECT id, ref, cor, url, ordem, largura_px AS "larguraPx", altura_px AS "alturaPx"
        FROM product_photos
       WHERE largura_px IS NOT NULL
         AND (largura_px < $1 OR altura_px < $2)
       ORDER BY ordem ASC, ref ASC
       LIMIT $3
      `,
      FOTO_LARGURA_MINIMA, FOTO_ALTURA_MINIMA, Math.max(1, Math.min(1000, limite)),
    );

    const [contagem]: any[] = await this.prisma.$queryRawUnsafe(
      `
      SELECT COUNT(*)::int                                                        AS total,
             COUNT(*) FILTER (WHERE largura_px IS NULL)::int                      AS "semMedida",
             COUNT(*) FILTER (WHERE largura_px IS NOT NULL
                              AND (largura_px < $1 OR altura_px < $2))::int        AS "abaixoDoMinimo"
        FROM product_photos
      `,
      FOTO_LARGURA_MINIMA, FOTO_ALTURA_MINIMA,
    );

    return {
      minimo: { largura: FOTO_LARGURA_MINIMA, altura: FOTO_ALTURA_MINIMA },
      ...contagem,
      fotos,
    };
  }

  /**
   * Mede o acervo ANTIGO — foto anterior a 13/08 entrou sem medida.
   *
   * Baixa só os primeiros 128 KB de cada arquivo (header `Range`): as
   * dimensões moram no começo, e puxar 3.600 fotos inteiras seria gigabytes
   * pra descobrir dois números. Em série e com teto por chamada, mesma receita
   * do `normalizarFormatos` — o domínio público do R2 responde 429 com pressa.
   */
  async medirAcervo(limite = 200): Promise<{
    olhadas: number; medidas: number; pequenas: number; falharam: number; restantes: number;
  }> {
    const fotos: any[] = await (this.prisma as any).productPhoto.findMany({
      where: { larguraPx: null },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(500, limite)),
    });

    let medidas = 0, pequenas = 0, falharam = 0;
    for (const foto of fotos) {
      try {
        const resposta = await fetch(foto.url, { headers: { Range: 'bytes=0-131071' } });
        if (!resposta.ok && resposta.status !== 206) throw new Error(`HTTP ${resposta.status}`);
        const tamanho = medirImagem(Buffer.from(await resposta.arrayBuffer()));
        if (!tamanho) { falharam++; continue; }
        await (this.prisma as any).productPhoto.update({
          where: { id: foto.id },
          data: { larguraPx: tamanho.largura, alturaPx: tamanho.altura },
        });
        medidas++;
        if (fotoBaixaResolucao(tamanho.largura, tamanho.altura)) pequenas++;
      } catch (e: any) {
        falharam++;
        this.logger.warn(`[foto] não medi ${foto.ref}/${foto.cor ?? '—'}: ${e?.message || e}`);
      }
    }

    const restantes = await (this.prisma as any).productPhoto.count({ where: { larguraPx: null } });
    return { olhadas: fotos.length, medidas, pequenas, falharam, restantes };
  }

  /**
   * NORMALIZA O ACERVO: AVIF/HEIC viram JPEG no bucket (12/08/2026).
   *
   * O WordPress converte imagem na origem e o importador salvou os bytes como
   * vieram, com nome `.jpg`. Duas consequências medidas na produção:
   *
   *   1. A leitura de cor por IA responde `400 ... not supported` — 129 das
   *      139 capas AVIF estavam sem bolinha.
   *   2. iPhone com iOS anterior ao 16.4 não abre AVIF: a cliente vê o card
   *      vazio e conclui que o site está quebrado.
   *
   * A conversão em memória (`CorIaService.paraFormatoDaIA`) resolve só o item
   * 1 — o arquivo continua AVIF pra quem navega. Aqui o arquivo é REGRAVADO.
   *
   * Detalhes que importam:
   * - Grava numa CHAVE NOVA e só então apaga a antiga. A URL do R2 é servida
   *   por CDN: sobrescrever a mesma chave deixaria o cache antigo no ar sem
   *   jeito de saber por quanto tempo.
   * - Em SÉRIE e com teto por chamada. O domínio público do R2 responde 429
   *   com download paralelo (medido), e a tela chama de novo pra continuar.
   * - Erro numa foto não derruba o lote: ela fica pro próximo clique.
   */
  async normalizarFormatos(limite = 150): Promise<{
    olhadas: number; convertidas: number; jaOk: number; falharam: number;
    restantes: number; exemplosFalha: string[];
  }> {
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado.');
    }
    let sharp: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sharp = require('sharp');
    } catch (e: any) {
      throw new BadRequestException(`conversão indisponível (sharp): ${e?.message || e}`);
    }

    /**
     * O CURSOR É `updatedAt`, e ele avança MESMO NA FOTO QUE JÁ ESTAVA BOA.
     *
     * Sem isso a segunda chamada baixaria as mesmas 150 primeiras de novo e o
     * mutirão nunca sairia do começo do acervo — o mesmo erro de fila do
     * `bolinha-auto` (ordem fixa + nada marcando o que já passou).
     */
    const inicio = new Date();
    const aOlhar = { objectKey: { not: null }, updatedAt: { lt: inicio } };
    const fotos: any[] = await (this.prisma as any).productPhoto.findMany({
      where: aOlhar,
      orderBy: { updatedAt: 'asc' },
      take: Math.max(1, Math.min(500, limite)),
    });

    let convertidas = 0, jaOk = 0, falharam = 0;
    const exemplosFalha: string[] = [];
    const client = getR2Client();
    const base = publicUrl.replace(/\/$/, '');

    for (const foto of fotos) {
      try {
        const resposta = await fetch(foto.url);
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
        const bytes = Buffer.from(await resposta.arrayBuffer());
        const mime = CorIaService.tipoDaImagem(
          bytes, String(resposta.headers.get('content-type') || ''),
        );
        if (CorIaService.ACEITOS_PELA_IA.includes(mime)) {
          jaOk++;
          // Toque no registro só pra o cursor andar (ver `inicio` acima).
          await (this.prisma as any).productPhoto.update({
            where: { id: foto.id }, data: { objectKey: foto.objectKey },
          });
          continue;
        }

        const convertida: Buffer = await sharp(bytes).jpeg({ quality: 90 }).toBuffer();
        const chaveNova = `${String(foto.objectKey).replace(/\.[^./]+$/, '')}-jpg.jpg`;
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: chaveNova, Body: convertida,
          ContentType: 'image/jpeg', ContentDisposition: 'inline',
        }));
        await (this.prisma as any).productPhoto.update({
          where: { id: foto.id },
          data: { url: `${base}/${chaveNova}`, objectKey: chaveNova },
        });
        // Só depois do banco apontar pro arquivo novo: se apagasse antes e o
        // update falhasse, a foto sumia do site.
        await client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: foto.objectKey }))
          .catch((e: any) => this.logger.warn(`[fotos] sobrou o AVIF ${foto.objectKey}: ${e?.message}`));
        convertidas++;
        this.logger.log(`[fotos] ${foto.ref}/${foto.cor ?? '—'}: ${mime} → JPEG`);
      } catch (e: any) {
        falharam++;
        if (exemplosFalha.length < 10) {
          exemplosFalha.push(`${foto.ref}/${foto.cor ?? '—'}: ${e?.message || e}`);
        }
        // A que falhou também anda: senão uma foto morta (404 no bucket)
        // seguraria o cursor e o resto do acervo nunca seria olhado.
        await (this.prisma as any).productPhoto
          .update({ where: { id: foto.id }, data: { objectKey: foto.objectKey } })
          .catch(() => undefined);
      }
    }

    const restantes = await (this.prisma as any).productPhoto.count({ where: aOlhar });
    this.logger.log(
      `[fotos] normalização: ${convertidas} convertida(s), ${jaOk} já ok, ${falharam} falha(s), ${restantes} por olhar`,
    );
    return { olhadas: fotos.length, convertidas, jaOk, falharam, restantes, exemplosFalha };
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
