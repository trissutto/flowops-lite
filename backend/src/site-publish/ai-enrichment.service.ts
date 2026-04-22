import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * AiEnrichmentService — gera conteúdo comercial pra produto via Claude (Anthropic).
 *
 * Por que HTTP direto em vez do SDK @anthropic-ai/sdk:
 *   - Evita dep node nova (já temos @nestjs/axios)
 *   - API Messages é estável, chamada é trivial
 *   - Facilita debug (logs brutos)
 *
 * Por que Claude e não OpenAI:
 *   - Qualidade superior em PT-BR pra copy persuasivo
 *   - Melhor adesão a guidelines de marca (few-shot do tom Lurds)
 *   - CEO já tá no ecossistema Anthropic (Cowork)
 *
 * Fallback: se ANTHROPIC_API_KEY não estiver setada, retorna 400 ("IA desabilitada").
 * Frontend trata isso mostrando "configure a chave no .env".
 */
@Injectable()
export class AiEnrichmentService {
  private readonly logger = new Logger(AiEnrichmentService.name);
  // Modelo default — pode sobrescrever via ANTHROPIC_MODEL no .env se quiser testar outro.
  private readonly defaultModel = 'claude-sonnet-4-6';

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  private get apiKey(): string | null {
    const k = this.config.get<string>('ANTHROPIC_API_KEY');
    return k && k.trim() ? k.trim() : null;
  }

  private get model(): string {
    return this.config.get<string>('ANTHROPIC_MODEL') || this.defaultModel;
  }

  isEnabled(): boolean {
    return !!this.apiKey;
  }

  /**
   * Gera enriquecimento completo para UM produto.
   *
   * Input: dados crus do Wincred (REF, descrição, cor, tamanhos) + contexto de
   * categoria/grupo se disponível.
   *
   * Output: JSON estruturado com título, descrição longa, descrição curta,
   * tags, atributos.
   */
  async generateForProduct(input: {
    refCode: string;
    cor: string;
    descricaoWincred: string;
    grupo?: string | null;
    subgrupo?: string | null;
    tamanhos: string[];
  }): Promise<{
    titulo: string;
    descricaoLonga: string;
    descricaoCurta: string;
    tags: string[];
    atributos: Array<{ nome: string; valor: string }>;
    rawModelResponse: string;
  }> {
    if (!this.apiKey) {
      throw new BadRequestException(
        'IA desabilitada. Configure ANTHROPIC_API_KEY no .env do backend pra gerar conteúdo automaticamente.',
      );
    }

    const prompt = this.buildPrompt(input);
    this.logger.log(`AI gen: ${input.refCode}/${input.cor} — prompt ${prompt.length} chars`);

    const body = {
      model: this.model,
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    let text = '';
    try {
      const res = await firstValueFrom(
        this.http.post('https://api.anthropic.com/v1/messages', body, {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 60000,
        }),
      );
      // Resposta Messages: { content: [{ type: 'text', text: '...' }] }
      const blocks = (res.data?.content as any[]) || [];
      text = blocks
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => String(b?.text || ''))
        .join('\n');
    } catch (e: any) {
      const status = e?.response?.status;
      const data = e?.response?.data;
      this.logger.error(
        `Claude error ${status}: ${JSON.stringify(data || e?.message).slice(0, 500)}`,
      );
      if (status === 401) {
        throw new BadRequestException('ANTHROPIC_API_KEY inválida ou expirada.');
      }
      if (status === 429) {
        throw new BadRequestException('Limite de requests da Anthropic atingido. Tenta de novo em 1 min.');
      }
      throw new BadRequestException(`Claude falhou (${status || 'network'}). ${e?.message || ''}`);
    }

    // Extrai o JSON do bloco ```json ... ```
    const parsed = this.extractJson(text);
    if (!parsed) {
      this.logger.warn(`AI gen: JSON inválido — resposta bruta:\n${text.slice(0, 800)}`);
      throw new BadRequestException('IA retornou formato inválido. Tenta de novo.');
    }

    return {
      titulo: String(parsed.titulo || '').trim(),
      descricaoLonga: String(parsed.descricao_longa || '').trim(),
      descricaoCurta: String(parsed.descricao_curta || '').trim(),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 20)
        : [],
      atributos: Array.isArray(parsed.atributos)
        ? parsed.atributos
            .map((a: any) => ({
              nome: String(a?.nome || '').trim(),
              valor: String(a?.valor || '').trim(),
            }))
            .filter((a) => a.nome && a.valor)
            .slice(0, 10)
        : [],
      rawModelResponse: text,
    };
  }

  /**
   * Prompt da marca Lurds. Few-shot curto com tom de voz + estrutura forçada.
   *
   * Diretrizes:
   *   - Público: mulher plus size (tamanho 46 ao 60)
   *   - Tom: acolhedor, empoderador, realista, sem clichê de "poderosa"
   *   - SEO: incluir "plus size" e variações de tamanho
   *   - Conversão: CTA no fim da descrição longa
   *
   * Retorno forçado em JSON (parser estrito).
   */
  private buildPrompt(input: {
    refCode: string;
    cor: string;
    descricaoWincred: string;
    grupo?: string | null;
    subgrupo?: string | null;
    tamanhos: string[];
  }): string {
    const ctx: string[] = [];
    ctx.push(`REFERÊNCIA: ${input.refCode}`);
    ctx.push(`DESCRIÇÃO BRUTA (Wincred ERP, pode ser técnica/sem graça): ${input.descricaoWincred || '(vazio)'}`);
    ctx.push(`COR: ${input.cor}`);
    if (input.grupo) ctx.push(`CATEGORIA INTERNA (grupo): ${input.grupo}`);
    if (input.subgrupo) ctx.push(`SUBCATEGORIA: ${input.subgrupo}`);
    if (input.tamanhos.length) ctx.push(`TAMANHOS DISPONÍVEIS: ${input.tamanhos.join(', ')}`);

    return `Você é o redator oficial da Lurds Plus Size, uma rede de lojas femininas especializada em moda tamanhos 46 ao 60. Sua missão é transformar um produto cadastrado de forma técnica no ERP em uma ficha comercial vendedora pro e-commerce.

TOM DE VOZ DA MARCA:
- Acolhedor e empoderador, sem clichê de "mulher poderosa"
- Direto, prático, sem floreio
- Fala com a cliente como amiga que entende corpo real
- Evita termos como "diva", "deusa", "tudo", "arrasadora"
- Prefere: "valoriza suas curvas", "caimento perfeito", "conforto do dia a dia"

ESTRUTURA OBRIGATÓRIA DA DESCRIÇÃO LONGA:
1) Abertura de 1-2 linhas com o benefício principal
2) Tecido e elastano (informar que tem elastano pro caimento)
3) Caimento e modelagem (como veste no corpo)
4) Ocasião de uso (trabalho, passeio, festa, dia a dia)
5) CTA final estimulando a compra ("garanta já", "leve pra sua loja", etc)

DADOS DO PRODUTO:
${ctx.join('\n')}

FORMATO DE RESPOSTA (OBRIGATÓRIO JSON):
Retorne EXATAMENTE o JSON abaixo dentro de um bloco \`\`\`json\`\`\`, sem nenhum texto antes ou depois:

\`\`\`json
{
  "titulo": "Título otimizado pra SEO + conversão, com 'Plus Size' no título, entre 50 e 80 chars",
  "descricao_longa": "HTML simples (pode usar <p>, <strong>, <br>). Seguir a estrutura de 5 blocos acima. 4-7 linhas no total.",
  "descricao_curta": "1 frase de no máximo 120 chars pra aparecer no topo do produto",
  "tags": ["array", "de", "6 a 10 tags", "em lowercase", "incluindo 'plus size' e variações de tamanho"],
  "atributos": [
    {"nome": "Tecido", "valor": "ex: Viscose com elastano"},
    {"nome": "Elasticidade", "valor": "ex: Média"},
    {"nome": "Caimento", "valor": "ex: Solto, ajustado no busto"},
    {"nome": "Modelagem", "valor": "ex: Evasê"}
  ]
}
\`\`\`

IMPORTANTE:
- Se a descrição bruta for pobre ("BLUSA" apenas), INFERE um tecido plausível pelo grupo/subgrupo. Prefira Viscose, Crepe, Malha, Moletom, Jeans, Tricoline conforme faz sentido.
- Se não souber um atributo, use "Não informado" em vez de chutar número.
- NUNCA invente medidas específicas (comprimento em cm, etc).
- Use linguagem 100% PT-BR.`;
  }

  /**
   * Extrai o bloco JSON da resposta do Claude. Aceita:
   *   - ```json ... ```
   *   - ``` ... ``` (sem lang)
   *   - JSON puro
   */
  private extractJson(text: string): any | null {
    const clean = text.trim();

    // Tenta bloco ```json
    const jsonBlock = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (jsonBlock?.[1]) {
      try {
        return JSON.parse(jsonBlock[1].trim());
      } catch {}
    }

    // Tenta JSON puro
    try {
      return JSON.parse(clean);
    } catch {}

    // Tenta encontrar { ... } no meio
    const bracket = clean.match(/\{[\s\S]*\}/);
    if (bracket) {
      try {
        return JSON.parse(bracket[0]);
      } catch {}
    }

    return null;
  }
}
