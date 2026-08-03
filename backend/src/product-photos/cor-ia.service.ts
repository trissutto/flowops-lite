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

  private readonly PROMPT = `Você olha a foto de uma peça de roupa feminina plus size e responde a COR DA PEÇA.

Regras:
- Responda a cor do TECIDO DA ROUPA principal da foto. Ignore fundo, pele, cabelo, sapato, bolsa, acessório e sombra.
- Se a peça for estampada (floral, poá, listras, tie-dye, animal print), marque "estampada": true e liste as cores predominantes da estampa, da mais presente pra menos.
- O hex tem que ser a cor como ela APARECE no tecido iluminado da foto, não o nome comercial idealizado. Evite preto puro (#000000) e branco puro (#FFFFFF): tecido fotografado quase nunca é isso.
- "nome" em português, curto, do jeito que uma loja escreveria: "Preto", "Vinho", "Verde musgo", "Off white", "Rosa queimado".
- "confianca": "baixa" se a peça aparece pouco, está muito escura ou a foto está ruim.

Responda SOMENTE com um JSON válido, sem texto em volta, neste formato:
{"hex":"#RRGGBB","nome":"...","estampada":false,"cores":[{"hex":"#RRGGBB","nome":"..."}],"confianca":"alta"}`;

  /** @param urlFoto URL da foto no R2 — baixada aqui e enviada em base64. */
  async detectar(urlFoto: string): Promise<CorDetectada> {
    if (!this.apiKey) {
      throw new BadRequestException(
        'IA desabilitada — configure ANTHROPIC_API_KEY. O conta-gotas manual continua funcionando.',
      );
    }
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
    if (!baixada) throw new BadRequestException('Não consegui abrir a foto pra ler a cor.');
    const mime = String((baixada.headers as any)?.['content-type'] || 'image/jpeg').split(';')[0];
    const base64 = Buffer.from(baixada.data as ArrayBuffer).toString('base64');

    const body = {
      model:
        this.config.get<string>('ANTHROPIC_VISION_MODEL') ||
        this.config.get<string>('ANTHROPIC_MODEL') ||
        this.modeloPadrao,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: this.PROMPT },
          ],
        },
      ],
    };

    let texto = '';
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
      texto = ((res.data?.content as any[]) || [])
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
      this.logger.warn(`[cor-ia] falhou (${status ?? 'sem status'}): ${detalhe}`);
      throw new BadRequestException(`IA não leu a cor (${status ?? 'sem status'}): ${detalhe}`);
    }

    return this.interpretar(texto);
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
