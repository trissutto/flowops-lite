import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * COR DA PEÇA PELA FOTO — a bolinha do site preenchida sozinha.
 *
 * O conta-gotas manual continua sendo a palavra final, mas ninguém vai clicar
 * ponto a ponto em milhares de peças. Aqui o Claude OLHA a foto e responde a
 * cor DA ROUPA — que é diferente da cor média da imagem: a foto tem fundo,
 * pele, cabelo, acessório e sombra, e um algoritmo de "cor dominante" burro
 * devolve o bege da parede ou o tom da modelo.
 *
 * Também responde se a peça é ESTAMPADA. Estampa não cabe num hex: nesse caso
 * a tela troca a bolinha para o modo "recorte da foto".
 *
 * Modelo: `ANTHROPIC_VISION_MODEL` → `ANTHROPIC_MODEL` → padrão. O default
 * antigo era um id que eu supus existir, e a conta respondia erro em toda
 * chamada; agora o primeiro fallback é o modelo que o enriquecimento de texto
 * JÁ usa em produção — se ele funciona lá, funciona aqui.
 */

export interface CorDetectada {
  hex: string;
  nome: string;
  estampada: boolean;
  /** Predominantes, da mais pra menos presente (inclui a principal). */
  cores: Array<{ hex: string; nome: string }>;
  confianca: 'alta' | 'media' | 'baixa';
}

export interface FocoDetectado {
  /** Centro do recorte, fração 0..1 da largura/altura da foto. */
  focoX: number;
  focoY: number;
  /** Quanto ampliar a partir do foco — 1 = sem zoom, 2 = dobro. */
  zoom: number;
  confianca: 'alta' | 'media' | 'baixa';
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

@Injectable()
export class CorIaService {
  private readonly logger = new Logger(CorIaService.name);
  /** O mesmo modelo que o enriquecimento de texto já usa em produção — id
   *  chutado é 404 na hora da verdade. VISION_MODEL sobrescreve. */
  private readonly modeloPadrao = 'claude-sonnet-4-6';

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  private get apiKey(): string | null {
    const k = this.config.get<string>('ANTHROPIC_API_KEY');
    return k && k.trim() ? k.trim() : null;
  }

  isEnabled(): boolean {
    return !!this.apiKey;
  }

  /**
   * Tipo da imagem pelos BYTES, não pelo cabeçalho do servidor.
   *
   * Medido em produção: o R2 devolve `binary/octet-stream` em parte do acervo
   * (o arquivo subiu sem content-type), e a API recusa com
   * "media_type: Input should be 'image/jpeg', 'image/png'...". Repassar o
   * cabeçalho cru fazia TODA leitura de cor falhar naquelas fotos.
   *
   * A assinatura no início do arquivo não mente — é o que o próprio navegador
   * usa quando o servidor erra o tipo.
   */
  static readonly ACEITOS_PELA_IA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

  /**
   * ⚠️ AVIF/HEIC ESTÃO NO ACERVO E A API NÃO OS LÊ (achado de 12/08/2026).
   *
   * O WordPress converte a imagem na origem, e o importador salvou os bytes
   * como vieram, com nome `.jpg`. Sem reconhecer a assinatura ISO-BMFF, este
   * método caía no chute "image/jpeg" e a API respondia
   * `400 Image format image/jpeg not supported` — a cada 90 segundos, desde
   * 07/08. Medido: 139 capas AVIF, 129 delas sem bolinha, contra 296 de 299
   * pintadas em JPEG/PNG. A varredura não estava parada: estava batendo na
   * mesma porta.
   *
   * Reconhecer é metade do conserto — a outra é `paraFormatoDaIA`, porque AVIF
   * continua não sendo aceito depois de identificado.
   */
  static tipoDaImagem(bytes: Buffer, cabecalho: string): string {
    if (bytes.length >= 12) {
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
      if (bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
      if (bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
      if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        return 'image/webp';
      }
      // ISO-BMFF: [tamanho 4B]['ftyp'][marca 4B] — avif/avis, heic/heix/mif1.
      if (bytes.toString('ascii', 4, 8) === 'ftyp') {
        const marca = bytes.toString('ascii', 8, 12).toLowerCase();
        if (marca.startsWith('avi')) return 'image/avif';
        if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(marca)) return 'image/heic';
      }
    }
    const doCabecalho = cabecalho.split(';')[0].trim().toLowerCase();
    if (CorIaService.ACEITOS_PELA_IA.includes(doCabecalho)) return doCabecalho;
    if (doCabecalho === 'image/avif' || doCabecalho === 'image/heic') return doCabecalho;
    // JPEG é o formato de 99% do acervo — chute menos ruim que devolver erro.
    return 'image/jpeg';
  }

  /**
   * O que a API aceita — convertendo o que ela não aceita.
   *
   * AVIF e HEIC viram JPEG aqui, EM MEMÓRIA: o arquivo do bucket não é tocado
   * (normalizar o acervo é outro caminho, com botão próprio). Qualidade 88 é
   * de sobra pra ler cor de tecido.
   *
   * `sharp` entra por require preguiçoso de propósito: é binário nativo, e se
   * a instalação falhar num deploy o certo é a leitura de cor avisar — não o
   * backend inteiro deixar de subir.
   */
  async paraFormatoDaIA(bytes: Buffer, mime: string): Promise<{ bytes: Buffer; mime: string }> {
    if (CorIaService.ACEITOS_PELA_IA.includes(mime)) return { bytes, mime };

    let sharp: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sharp = require('sharp');
    } catch (e: any) {
      throw new BadRequestException(
        `foto em ${mime}, que a IA não lê, e a conversão não está disponível (sharp): ${e?.message || e}`,
      );
    }
    try {
      const convertida: Buffer = await sharp(bytes).jpeg({ quality: 88 }).toBuffer();
      this.logger.log(
        `[cor-ia] ${mime} convertida pra JPEG (${bytes.length} → ${convertida.length} bytes)`,
      );
      return { bytes: convertida, mime: 'image/jpeg' };
    } catch (e: any) {
      throw new BadRequestException(`não consegui converter a foto ${mime}: ${e?.message || e}`);
    }
  }

  private readonly PROMPT = `Você olha a foto de uma peça de roupa feminina plus size e responde a COR DA PEÇA.

Regras:
- Responda a cor do TECIDO DA ROUPA principal da foto. Ignore fundo, pele, cabelo, sapato, bolsa, acessório e sombra.
- Se a peça for estampada (floral, poá, listras, tie-dye, animal print), marque "estampada": true e liste as cores predominantes da estampa, da mais presente pra menos.
- O hex tem que ser a cor como ela APARECE no tecido iluminado da foto, não o nome comercial idealizado. Evite preto puro (#000000) e branco puro (#FFFFFF): tecido fotografado quase nunca é isso.
- "nome" em português, curto, do jeito que uma loja escreveria: "Preto", "Vinho", "Verde musgo", "Off white", "Rosa queimado".
- "confianca": "baixa" se a peça aparece pouco, está muito escura ou a foto está ruim.

Responda SOMENTE com um JSON válido, sem texto em volta, neste formato:
{"hex":"#RRGGBB","nome":"...","estampada":false,"cores":[{"hex":"#RRGGBB","nome":"..."}],"confianca":"alta"}`;

  /** Baixa a foto e devolve os bytes + mime real (pelos bytes, não pelo cabeçalho). */
  private async baixarImagem(urlFoto: string): Promise<{ bytes: Buffer; mime: string }> {
    const url = String(urlFoto || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('URL da foto inválida');
    }
    // A foto vai em BASE64, não por URL: mandar link obriga a Anthropic a
    // buscar o arquivo (mais uma rede, mais um jeito de falhar) e depende de
    // o formato `source: url` estar disponível na conta. Baixar aqui é uma
    // requisição nossa, previsível, e funciona com bucket privado no futuro.
    const baixada = await firstValueFrom(
      this.http.get(url, { responseType: 'arraybuffer', timeout: 20000 }),
    ).catch(() => null);
    if (!baixada) throw new BadRequestException('Não consegui abrir a foto.');
    const bytes = Buffer.from(baixada.data as ArrayBuffer);
    const mime = CorIaService.tipoDaImagem(
      bytes,
      String((baixada.headers as any)?.['content-type'] || ''),
    );
    // AVIF/HEIC viram JPEG antes de sair daqui: TODO caminho que lê foto (cor
    // e foco do recorte) passa por este método, então o conserto é um só.
    return this.paraFormatoDaIA(bytes, mime);
  }

  /** Chama a Anthropic com uma imagem + prompt de texto, devolve a resposta crua. */
  private async chamarVision(bytes: Buffer, mime: string, prompt: string, maxTokens = 400): Promise<string> {
    if (!this.apiKey) {
      throw new BadRequestException(
        'IA desabilitada — configure ANTHROPIC_API_KEY. O ajuste manual continua funcionando.',
      );
    }
    const body = {
      model:
        this.config.get<string>('ANTHROPIC_VISION_MODEL') ||
        this.config.get<string>('ANTHROPIC_MODEL') ||
        this.modeloPadrao,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    };
    try {
      const res = await firstValueFrom(
        this.http.post('https://api.anthropic.com/v1/messages', body, {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 45000,
        }),
      );
      return ((res.data?.content as any[]) || [])
        .filter((b) => b?.type === 'text')
        .map((b) => String(b?.text || ''))
        .join('\n');
    } catch (e: any) {
      // O motivo REAL vai pra tela e pro log. A mensagem genérica de antes
      // custou uma tarde: "não consegui ler a cor" tanto podia ser modelo
      // inválido quanto chave errada, e não dava pra saber sem deploy.
      const status = e?.response?.status;
      const detalhe =
        e?.response?.data?.error?.message ||
        e?.response?.data?.message ||
        e?.message ||
        'erro desconhecido';
      this.logger.warn(`[cor-ia] IA falhou (${status ?? 'sem status'}): ${detalhe}`);
      throw new BadRequestException(`IA falhou (${status ?? 'sem status'}): ${detalhe}`);
    }
  }

  /** @param urlFoto URL da foto no R2 — baixada aqui e enviada em base64. */
  async detectar(urlFoto: string): Promise<CorDetectada> {
    const { bytes, mime } = await this.baixarImagem(urlFoto);
    const texto = await this.chamarVision(bytes, mime, this.PROMPT, 400);
    return this.interpretar(texto);
  }

  private readonly PROMPT_FOCO = (nomeCategoria: string) => `Você olha a foto de uma modelo plus size vestindo roupa, pra escolher o RECORTE de uma vitrine de categoria "${nomeCategoria}".

O card da vitrine é vertical (proporção 3:4) e precisa mostrar a peça ${nomeCategoria.toLowerCase()} EM DESTAQUE, tipo revista de moda — não a modelo de corpo inteiro pequena no meio da foto.

Regras:
- "focoX" e "focoY": o CENTRO da peça de roupa que representa "${nomeCategoria}" nesta foto, como fração de 0 (esquerda/topo) a 1 (direita/base) da largura e altura TOTAIS da imagem original. Se a categoria for "Calças" ou "Shorts", mire na região da cintura/quadril até onde a peça termina. Se for "Blusas", "Jaquetas" ou "Conjuntos" com foco em cima, mire no tronco/busto. Se for "Vestidos", "Macacões" ou "Saias", mire no meio do corpo (a peça cobre tronco+quadril). Ignore rosto, cabelo e fundo ao escolher o ponto.
- "zoom": de 1.2 a 2.2 — quanto ampliar a partir desse centro pra virar um close de revista. Foto onde a peça já ocupa boa parte do quadro pede zoom menor (1.2–1.5); foto de corpo inteiro de longe pede zoom maior (1.8–2.2). Nunca amplie tanto que corte a peça inteira pra fora — pense no que ainda cabe depois do zoom.
- "confianca": "baixa" se não conseguir identificar a peça claramente na foto.

Responda SOMENTE com um JSON válido, sem texto em volta, neste formato:
{"focoX":0.5,"focoY":0.6,"zoom":1.6,"confianca":"alta"}`;

  /**
   * ONDE MIRAR O RECORTE do card de categoria (dono 07/08): "trate as fotos
   * pra dar mais close na peça que simboliza a categoria". O card de
   * "Calças" mostrando a modelo inteira de longe não vende calça nenhuma —
   * o recorte precisa mirar na peça, como uma vitrine de revista.
   */
  async detectarFoco(urlFoto: string, nomeCategoria: string): Promise<FocoDetectado> {
    const { bytes, mime } = await this.baixarImagem(urlFoto);
    const texto = await this.chamarVision(bytes, mime, this.PROMPT_FOCO(nomeCategoria), 200);
    return this.interpretarFoco(texto);
  }

  private interpretarFoco(texto: string): FocoDetectado {
    const bruto = texto.replace(/```json|```/g, '').trim();
    const inicio = bruto.indexOf('{');
    const fim = bruto.lastIndexOf('}');
    if (inicio < 0 || fim <= inicio) {
      throw new BadRequestException('A IA respondeu num formato que não entendi.');
    }
    let dados: any;
    try {
      dados = JSON.parse(bruto.slice(inicio, fim + 1));
    } catch {
      throw new BadRequestException('A IA respondeu num formato que não entendi.');
    }
    const clamp01 = (n: any, padrao: number) => {
      const v = Number(n);
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : padrao;
    };
    const zoom = Number(dados?.zoom);
    return {
      focoX: clamp01(dados?.focoX, 0.5),
      focoY: clamp01(dados?.focoY, 0.4),
      zoom: Number.isFinite(zoom) ? Math.min(2.5, Math.max(1, zoom)) : 1.5,
      confianca: ['alta', 'media', 'baixa'].includes(dados?.confianca) ? dados.confianca : 'media',
    };
  }

  /**
   * O modelo às vezes embrulha o JSON em ```json. Extrai o primeiro objeto e
   * valida campo a campo: hex inválido vindo da IA pintaria a bolinha de nada.
   */
  private interpretar(texto: string): CorDetectada {
    const bruto = texto.replace(/```json|```/g, '').trim();
    const inicio = bruto.indexOf('{');
    const fim = bruto.lastIndexOf('}');
    if (inicio < 0 || fim <= inicio) {
      throw new BadRequestException('A IA respondeu num formato que não entendi.');
    }

    let dados: any;
    try {
      dados = JSON.parse(bruto.slice(inicio, fim + 1));
    } catch {
      throw new BadRequestException('A IA respondeu num formato que não entendi.');
    }

    const hex = String(dados?.hex || '').toUpperCase();
    if (!HEX.test(hex)) {
      throw new BadRequestException('A IA não devolveu uma cor válida.');
    }

    const cores = Array.isArray(dados?.cores)
      ? dados.cores
          .map((c: any) => ({ hex: String(c?.hex || '').toUpperCase(), nome: String(c?.nome || '').trim() }))
          .filter((c: any) => HEX.test(c.hex))
          .slice(0, 4)
      : [];

    return {
      hex,
      nome: String(dados?.nome || '').trim() || 'Cor da peça',
      estampada: Boolean(dados?.estampada),
      cores: cores.length ? cores : [{ hex, nome: String(dados?.nome || '').trim() || 'Cor da peça' }],
      confianca: ['alta', 'media', 'baixa'].includes(dados?.confianca) ? dados.confianca : 'media',
    };
  }
}
