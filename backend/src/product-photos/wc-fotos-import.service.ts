import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ProductPhotosService } from './product-photos.service';

/**
 * IMPORTAR AS FOTOS DO SITE ANTIGO — WooCommerce → R2, por REF e COR.
 *
 * O acervo já existe: no WooCommerce cada COR é um produto separado, todos com
 * o MESMO SKU (a REF). O sync de conteúdo tratava isso como "REF duplicada" e
 * descartava — o que se perdia ali era justamente a foto de cada cor.
 *
 * COMO CASA A COR: o WC não tem campo de cor confiável, mas o NOME do produto
 * carrega ("... REF CHIC GOIABA"). E nós já sabemos, pelo ERP, quais cores
 * aquela REF tem de verdade. Então o casamento é contra essa lista fechada, com
 * o nome MAIS LONGO ganhando: senão "ROSA QUEIMADO" seria casado como "ROSA" e
 * duas cores diferentes receberiam a mesma foto.
 *
 * O que NÃO casar é reportado, nunca chutado. Foto errada na cor é troca
 * garantida — e a cliente perde a confiança na peça inteira, não só na cor.
 *
 * Idempotente: cor que já tem foto é pulada, então dá pra rodar quantas vezes
 * quiser sem duplicar acervo nem gastar upload à toa.
 */

export interface ResultadoRef {
  ref: string;
  coresComFoto: string[];
  coresSemFoto: string[];
  jaTinham: string[];
  produtosWcSemCor: string[];
  fotos: number;
}

@Injectable()
export class WcFotosImportService {
  private readonly logger = new Logger(WcFotosImportService.name);
  private static readonly MAX_POR_COR = 6;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly fotos: ProductPhotosService,
  ) {}

  private get baseUrl() {
    return `${(this.config.get<string>('WC_URL') ?? '').replace(/\/$/, '')}/wp-json/wc/v3`;
  }

  private get auth() {
    return {
      username: this.config.get<string>('WC_CONSUMER_KEY') ?? '',
      password: this.config.get<string>('WC_CONSUMER_SECRET') ?? '',
    };
  }

  private semAcento(v: string) {
    return String(v || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase();
  }

  /** Cores que a REF tem no catálogo — a lista fechada do casamento. */
  private async coresDaRef(ref: string): Promise<string[]> {
    const linhas = await this.prisma.$queryRawUnsafe<Array<{ cor: string }>>(
      `SELECT DISTINCT NULLIF(TRIM(cor), '') AS cor
         FROM wincred_produtos
        WHERE UPPER(TRIM(ref)) = $1 AND cor IS NOT NULL AND TRIM(cor) <> ''`,
      ref,
    );
    return linhas.map((l) => l.cor).filter(Boolean);
  }

  /**
   * Qual cor da lista aparece no nome do produto do WC. Mais longa primeiro —
   * "ROSA QUEIMADO" tem que ganhar de "ROSA".
   */
  private casarCor(nomeWc: string, cores: string[]): string | null {
    const nome = this.semAcento(nomeWc);
    const candidatas = [...cores].sort((a, b) => b.length - a.length);
    for (const cor of candidatas) {
      const alvo = this.semAcento(cor);
      if (!alvo) continue;
      // Fronteira de palavra pra "UVA" não casar dentro de "LUVA".
      if (new RegExp(`(^|[^A-Z0-9])${alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`).test(nome)) {
        return cor;
      }
    }
    return null;
  }

  private async baixar(url: string): Promise<{ buffer: Buffer; mime: string } | null> {
    try {
      const res = await firstValueFrom(
        this.http.get(url, { responseType: 'arraybuffer', timeout: 30000 }),
      );
      const mime = String(res.headers?.['content-type'] || 'image/jpeg');
      if (!mime.startsWith('image/')) return null;
      return { buffer: Buffer.from(res.data), mime };
    } catch (e: any) {
      this.logger.warn(`[wc-fotos] não baixei ${url}: ${e?.message || e}`);
      return null;
    }
  }

  /** Importa as fotos de UMA REF. */
  async importarRef(refBruta: string, usuario?: string): Promise<ResultadoRef> {
    const ref = String(refBruta || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!ref) throw new BadRequestException('REF obrigatória');
    if (!this.config.get<string>('WC_URL')) {
      throw new BadRequestException('WC_URL não configurada — sem o site antigo não há de onde importar.');
    }

    const cores = await this.coresDaRef(ref);
    if (!cores.length) throw new BadRequestException(`REF ${ref} não tem cores no catálogo.`);

    // Todos os produtos do WC com esse SKU — um por cor.
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/products`, {
        auth: this.auth,
        params: { sku: ref, per_page: 100, status: 'publish' },
        timeout: 30000,
      }),
    ).catch((e) => {
      this.logger.warn(`[wc-fotos] busca ${ref} falhou: ${e?.message}`);
      return null;
    });

    const produtos: any[] = res?.data ?? [];
    const resultado: ResultadoRef = {
      ref, coresComFoto: [], coresSemFoto: [], jaTinham: [], produtosWcSemCor: [], fotos: 0,
    };

    for (const p of produtos) {
      const cor = this.casarCor(String(p.name || ''), cores);
      if (!cor) {
        resultado.produtosWcSemCor.push(`#${p.id} ${String(p.name || '').slice(0, 60)}`);
        continue;
      }

      const jaTem = await this.fotos.listPhotos(ref, cor);
      if (jaTem.length) {
        if (!resultado.jaTinham.includes(cor)) resultado.jaTinham.push(cor);
        continue;
      }

      const imagens: any[] = (p.images ?? []).slice(0, WcFotosImportService.MAX_POR_COR);
      let subidas = 0;
      for (const img of imagens) {
        const arquivo = await this.baixar(String(img?.src || ''));
        if (!arquivo) continue;
        try {
          await this.fotos.upload({
            ref,
            cor,
            userId: usuario ?? undefined,
            file: {
              buffer: arquivo.buffer,
              mimetype: arquivo.mime,
              originalname: `wc-${p.id}-${subidas + 1}.jpg`,
            },
          });
          subidas++;
        } catch (e: any) {
          this.logger.warn(`[wc-fotos] ${ref}/${cor}: ${e?.message || e}`);
        }
      }
      if (subidas > 0) {
        resultado.coresComFoto.push(cor);
        resultado.fotos += subidas;
      }
    }

    resultado.coresSemFoto = cores.filter(
      (c) => !resultado.coresComFoto.includes(c) && !resultado.jaTinham.includes(c),
    );

    this.logger.log(
      `[wc-fotos] ${ref}: ${resultado.fotos} foto(s) em ${resultado.coresComFoto.length} cor(es); ` +
        `${resultado.coresSemFoto.length} cor(es) sem foto no site antigo`,
    );
    return resultado;
  }

  /**
   * Lote — para quando o dono quiser puxar o acervo inteiro.
   *
   * Em SÉRIE e com teto: o WordPress mora no mesmo servidor do ERP antigo
   * ([[giga-wp-server-firewall]]), e paralelizar download de imagem lá é a
   * receita pra derrubar o site que ainda está vendendo.
   */
  async importarLote(refs: string[], usuario?: string) {
    const lista = Array.from(new Set((refs || []).map((r) => String(r).trim().toUpperCase()))).slice(0, 50);
    const relatorio: ResultadoRef[] = [];
    for (const ref of lista) {
      try {
        relatorio.push(await this.importarRef(ref, usuario));
      } catch (e: any) {
        relatorio.push({
          ref, coresComFoto: [], coresSemFoto: [], jaTinham: [],
          produtosWcSemCor: [`erro: ${e?.message || e}`], fotos: 0,
        });
      }
    }
    return {
      refs: relatorio.length,
      fotos: relatorio.reduce((s, r) => s + r.fotos, 0),
      detalhe: relatorio,
    };
  }
}
