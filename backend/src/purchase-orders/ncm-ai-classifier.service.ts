import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export type NcmClassificationSource = 'ia' | 'regra' | 'existente';

export interface NcmClassificationInput {
  existingNcm?: string | null;
  ref?: string | null;
  descricaoBase: string;
  grupoNome?: string | null;
  subgrupoNome?: string | null;
  tecidoNome?: string | null;
  modelagens?: string[];
  ocasioes?: string[];
}

export interface NcmClassificationResult {
  ncm: string;
  source: NcmClassificationSource;
  officialDescription: string;
  officiallyValidated: boolean;
}

interface NcmCandidate {
  code: string;
  label: string;
}

interface OfficialNcmTable {
  codes: Map<string, string>;
  officiallyValidated: boolean;
  expiresAt: number;
}

/**
 * Candidatos usuais do catálogo de moda da Lurd's.
 *
 * A lista não é aceita cegamente: quando o Classif está disponível, somente os
 * códigos que ainda existem na tabela oficial vigente são enviados à IA. Ela
 * escolhe um código desta lista fechada; nunca devolve um NCM livre.
 */
export const FASHION_NCM_CANDIDATES: readonly NcmCandidate[] = [
  { code: '61061000', label: 'Blusas e camisas femininas de malha, de algodão' },
  { code: '61062000', label: 'Blusas e camisas femininas de malha, de fibras sintéticas ou artificiais' },
  { code: '61069000', label: 'Blusas e camisas femininas de malha, de outras matérias têxteis' },
  { code: '62063000', label: 'Blusas, camisas e camisetas femininas de tecido, de algodão' },
  { code: '62064000', label: 'Blusas, camisas e camisetas femininas de tecido, de fibras sintéticas ou artificiais' },
  { code: '62069000', label: 'Blusas, camisas e camisetas femininas de tecido, de outras matérias têxteis' },
  { code: '61091000', label: 'Camisetas T-shirt, regatas e semelhantes de malha, de algodão' },
  { code: '61099000', label: 'Camisetas T-shirt, regatas e semelhantes de malha, de outras matérias têxteis' },
  { code: '61044200', label: 'Vestidos femininos de malha, de algodão' },
  { code: '61044300', label: 'Vestidos femininos de malha, de fibras sintéticas' },
  { code: '61044400', label: 'Vestidos femininos de malha, de fibras artificiais' },
  { code: '61044900', label: 'Vestidos femininos de malha, de outras matérias têxteis' },
  { code: '62044200', label: 'Vestidos femininos de tecido, de algodão' },
  { code: '62044300', label: 'Vestidos femininos de tecido, de fibras sintéticas' },
  { code: '62044400', label: 'Vestidos femininos de tecido, de fibras artificiais' },
  { code: '62044900', label: 'Vestidos femininos de tecido, de outras matérias têxteis' },
  { code: '61045200', label: 'Saias e saias-calças femininas de malha, de algodão' },
  { code: '61045300', label: 'Saias e saias-calças femininas de malha, de fibras sintéticas' },
  { code: '61045900', label: 'Saias e saias-calças femininas de malha, de outras matérias têxteis' },
  { code: '62045200', label: 'Saias e saias-calças femininas de tecido, de algodão' },
  { code: '62045300', label: 'Saias e saias-calças femininas de tecido, de fibras sintéticas' },
  { code: '62045900', label: 'Saias e saias-calças femininas de tecido, de outras matérias têxteis' },
  { code: '61046200', label: 'Calças, shorts e bermudas femininas de malha, de algodão' },
  { code: '61046300', label: 'Calças, shorts e bermudas femininas de malha, de fibras sintéticas' },
  { code: '61046900', label: 'Calças, shorts e bermudas femininas de malha, de outras matérias têxteis' },
  { code: '62046200', label: 'Calças, shorts e bermudas femininas de tecido, de algodão' },
  { code: '62046300', label: 'Calças, shorts e bermudas femininas de tecido, de fibras sintéticas' },
  { code: '62046900', label: 'Calças, shorts e bermudas femininas de tecido, de outras matérias têxteis' },
  { code: '61043200', label: 'Blazers e jaquetas femininas de malha, de algodão' },
  { code: '61043300', label: 'Blazers e jaquetas femininas de malha, de fibras sintéticas' },
  { code: '61043900', label: 'Blazers e jaquetas femininas de malha, de outras matérias têxteis' },
  { code: '62043200', label: 'Blazers e jaquetas femininas de tecido, de algodão' },
  { code: '62043300', label: 'Blazers e jaquetas femininas de tecido, de fibras sintéticas' },
  { code: '62043900', label: 'Blazers e jaquetas femininas de tecido, de outras matérias têxteis' },
  { code: '61102000', label: 'Suéteres, pulôveres, cardigãs e semelhantes de malha, de algodão' },
  { code: '61103000', label: 'Suéteres, pulôveres, cardigãs e semelhantes de malha, de fibras sintéticas ou artificiais' },
  { code: '61109000', label: 'Suéteres, pulôveres, cardigãs e semelhantes de malha, de outras matérias têxteis' },
  { code: '62114200', label: 'Outros vestuários femininos de tecido, de algodão, incluindo macacões' },
  { code: '62114300', label: 'Outros vestuários femininos de tecido, de fibras sintéticas ou artificiais, incluindo macacões' },
  { code: '62114900', label: 'Outros vestuários femininos de tecido, de outras matérias têxteis, incluindo macacões' },
  { code: '62121000', label: 'Sutiãs e bustiês' },
  { code: '61082100', label: 'Calcinhas femininas de malha, de algodão' },
  { code: '61082200', label: 'Calcinhas femininas de malha, de fibras sintéticas ou artificiais' },
  { code: '61082900', label: 'Calcinhas femininas de malha, de outras matérias têxteis' },
  { code: '61083100', label: 'Camisolas e pijamas femininos de malha, de algodão' },
  { code: '61083200', label: 'Camisolas e pijamas femininos de malha, de fibras sintéticas ou artificiais' },
  { code: '61083900', label: 'Camisolas e pijamas femininos de malha, de outras matérias têxteis' },
  { code: '62082100', label: 'Camisolas e pijamas femininos de tecido, de algodão' },
  { code: '62082200', label: 'Camisolas e pijamas femininos de tecido, de fibras sintéticas ou artificiais' },
  { code: '62082900', label: 'Camisolas e pijamas femininos de tecido, de outras matérias têxteis' },
  { code: '61124100', label: 'Maiôs e biquínis femininos de malha, de fibras sintéticas' },
  { code: '61124900', label: 'Maiôs e biquínis femininos de malha, de outras matérias têxteis' },
  { code: '42022220', label: 'Bolsas de mão com superfície exterior de matérias têxteis' },
  { code: '42029200', label: 'Bolsas, mochilas e semelhantes com superfície exterior de matérias têxteis ou plástico' },
  { code: '42033000', label: 'Cintos e cinturões de couro' },
  { code: '64041900', label: 'Outros calçados com sola de borracha ou plástico e parte superior têxtil' },
  { code: '65050090', label: 'Outros chapéus, bonés e artefatos de uso semelhante' },
  { code: '71171900', label: 'Outras bijuterias de metais comuns' },
  { code: '62143000', label: 'Xales, echarpes, lenços e semelhantes de fibras sintéticas' },
  { code: '62144000', label: 'Xales, echarpes, lenços e semelhantes de fibras artificiais' },
] as const;

const CLASSIF_URL =
  'https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json';
const OFFICIAL_CACHE_MS = 24 * 60 * 60 * 1000;
const CLASSIFICATION_CACHE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class NcmAiClassifierService implements OnModuleInit {
  private readonly logger = new Logger(NcmAiClassifierService.name);
  private officialTable: OfficialNcmTable | null = null;
  private officialLoading: Promise<OfficialNcmTable> | null = null;
  private readonly classificationCache = new Map<
    string,
    { expiresAt: number; result: NcmClassificationResult }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  onModuleInit() {
    // Aquece a tabela em segundo plano para o primeiro clique em Conferir não
    // precisar esperar o download do Classif.
    void this.getOfficialTable();
  }

  async classify(input: NcmClassificationInput): Promise<NcmClassificationResult> {
    const table = await this.getOfficialTable();
    const existing = this.onlyDigits(input.existingNcm);
    if (existing.length === 8 && table.codes.has(existing)) {
      return this.result(existing, 'existente', table);
    }

    const key = this.cacheKey(input);
    const cached = this.classificationCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const candidates = FASHION_NCM_CANDIDATES.filter((candidate) =>
      table.codes.has(candidate.code),
    );
    const aiChoice = await this.askAi(input, candidates);
    const selected =
      aiChoice && candidates.some((candidate) => candidate.code === aiChoice)
        ? aiChoice
        : this.ruleFallback(input, candidates);
    const source: NcmClassificationSource = aiChoice === selected ? 'ia' : 'regra';
    const result = this.result(selected, source, table);

    if (this.classificationCache.size >= 500) this.classificationCache.clear();
    this.classificationCache.set(key, {
      expiresAt: Date.now() + CLASSIFICATION_CACHE_MS,
      result,
    });
    this.logger.log(
      `[ncm-ia] ref=${input.ref || '-'} ncm=${result.ncm} fonte=${result.source} ` +
        `oficial=${result.officiallyValidated}`,
    );
    return result;
  }

  private async askAi(
    input: NcmClassificationInput,
    candidates: readonly NcmCandidate[],
  ): Promise<string | null> {
    const apiKey = String(this.config.get<string>('ANTHROPIC_API_KEY') || '').trim();
    if (!apiKey || candidates.length === 0) return null;

    const context = [
      `Descrição base: ${input.descricaoBase || 'não informada'}`,
      `Grupo: ${input.grupoNome || 'não informado'}`,
      `Subgrupo: ${input.subgrupoNome || 'não informado'}`,
      `Tecido: ${input.tecidoNome || 'não informado'}`,
      `Modelagem: ${(input.modelagens || []).join(', ') || 'não informada'}`,
      `Ocasião: ${(input.ocasioes || []).join(', ') || 'não informada'}`,
    ].join('\n');
    const options = candidates.map((candidate) => `${candidate.code} — ${candidate.label}`).join('\n');

    try {
      const response = await firstValueFrom(
        this.http.post(
          'https://api.anthropic.com/v1/messages',
          {
            model:
              this.config.get<string>('NCM_AI_MODEL') ||
              this.config.get<string>('ANTHROPIC_MODEL') ||
              'claude-sonnet-4-6',
            max_tokens: 160,
            temperature: 0,
            system:
              'Você classifica produtos femininos de moda na NCM brasileira. ' +
              'Escolha obrigatoriamente um único código da lista fornecida. ' +
              'Considere tipo da peça, malha versus tecido plano e fibra. ' +
              'Nunca crie outro código. Responda somente JSON no formato {"ncm":"00000000"}.',
            messages: [
              {
                role: 'user',
                content: `${context}\n\nCÓDIGOS PERMITIDOS E VIGENTES:\n${options}`,
              },
            ],
          },
          {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: 30_000,
          },
        ),
      );
      const text = ((response.data?.content as any[]) || [])
        .filter((block: any) => block?.type === 'text')
        .map((block: any) => String(block?.text || ''))
        .join('\n');
      const parsed = this.extractJson(text);
      const ncm = this.onlyDigits(parsed?.ncm);
      return ncm.length === 8 ? ncm : null;
    } catch (error: any) {
      this.logger.warn(`[ncm-ia] Anthropic indisponível: ${error?.message || error}`);
      return null;
    }
  }

  private async getOfficialTable(): Promise<OfficialNcmTable> {
    if (this.officialTable && this.officialTable.expiresAt > Date.now()) {
      return this.officialTable;
    }
    if (this.officialLoading) return this.officialLoading;

    this.officialLoading = (async () => {
      try {
        const response = await firstValueFrom(
          this.http.get(CLASSIF_URL, {
            timeout: 20_000,
            maxContentLength: 20 * 1024 * 1024,
          }),
        );
        const rows = Array.isArray(response.data?.Nomenclaturas)
          ? response.data.Nomenclaturas
          : [];
        const codes = new Map<string, string>();
        for (const row of rows) {
          const code = this.onlyDigits(row?.Codigo);
          if (code.length === 8) codes.set(code, String(row?.Descricao || '').trim());
        }
        if (codes.size < 1000) throw new Error(`tabela oficial incompleta (${codes.size} códigos)`);
        this.officialTable = {
          codes,
          officiallyValidated: true,
          expiresAt: Date.now() + OFFICIAL_CACHE_MS,
        };
        return this.officialTable;
      } catch (error: any) {
        this.logger.warn(`[ncm-ia] Classif indisponível: ${error?.message || error}`);
        if (this.officialTable?.codes.size) {
          this.officialTable.expiresAt = Date.now() + 60 * 60 * 1000;
          return this.officialTable;
        }
        const codes = new Map(
          FASHION_NCM_CANDIDATES.map((candidate) => [candidate.code, candidate.label]),
        );
        this.officialTable = {
          codes,
          officiallyValidated: false,
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
        return this.officialTable;
      } finally {
        this.officialLoading = null;
      }
    })();
    return this.officialLoading;
  }

  private ruleFallback(
    input: NcmClassificationInput,
    candidates: readonly NcmCandidate[],
  ): string {
    const text = this.normalize(
      [
        input.descricaoBase,
        input.grupoNome,
        input.subgrupoNome,
        input.tecidoNome,
        ...(input.modelagens || []),
        ...(input.ocasioes || []),
      ]
        .filter(Boolean)
        .join(' '),
    );
    const available = new Set(candidates.map((candidate) => candidate.code));
    const isKnit = /\b(malha|tricot|trico|moletom|ribana|canelad|jersey)\b/.test(text);
    const fiber: 'cotton' | 'synthetic' | 'artificial' | 'other' =
      /\b(algodao|jeans|sarja|tricoline)\b/.test(text)
        ? 'cotton'
        : /\b(viscose|modal|liocel|rayon)\b/.test(text)
          ? 'artificial'
          : /\b(poliester|poliamida|nylon|microfibra|elastano)\b/.test(text)
            ? 'synthetic'
            : 'other';

    const choose = (...codes: string[]) => codes.find((code) => available.has(code));
    let preferred: string | undefined;

    if (/\b(sutia|sutia|bustie)\b/.test(text)) preferred = choose('62121000');
    else if (/\b(calcinha)\b/.test(text)) {
      preferred = choose(fiber === 'cotton' ? '61082100' : fiber === 'other' ? '61082900' : '61082200');
    } else if (/\b(pijama|camisola)\b/.test(text)) {
      const prefix = isKnit ? '6108' : '6208';
      const suffix = fiber === 'cotton' ? '2100' : fiber === 'other' ? '2900' : '2200';
      preferred = choose(`${prefix}${suffix}`);
    } else if (/\b(maio|biquini)\b/.test(text)) {
      preferred = choose(fiber === 'synthetic' ? '61124100' : '61124900');
    } else if (/\b(bolsa|mochila|necessaire|carteira|pochete)\b/.test(text)) {
      preferred = choose(/\b(bolsa|carteira)\b/.test(text) ? '42022220' : '42029200');
    } else if (/\b(cinto)\b/.test(text)) preferred = choose('42033000');
    else if (/\b(sapato|sandalia|tenis|rasteira|chinelo)\b/.test(text)) preferred = choose('64041900');
    else if (/\b(chapeu|bone)\b/.test(text)) preferred = choose('65050090');
    else if (/\b(brinco|colar|anel|pulseira|bijuteria)\b/.test(text)) preferred = choose('71171900');
    else if (/\b(lenco|echarpe|cachecol|xale)\b/.test(text)) {
      preferred = choose(fiber === 'artificial' ? '62144000' : '62143000');
    } else if (/\b(cardigan|sueter|pulover)\b/.test(text)) {
      preferred = choose(fiber === 'cotton' ? '61102000' : fiber === 'other' ? '61109000' : '61103000');
    } else if (/\b(vestido)\b/.test(text)) {
      preferred = choose(this.garmentCode(isKnit ? '6104' : '6204', '4', fiber));
    } else if (/\b(saia)\b/.test(text)) {
      preferred = choose(this.garmentCode(isKnit ? '6104' : '6204', '5', fiber));
    } else if (/\b(calca|short|bermuda)\b/.test(text)) {
      preferred = choose(this.garmentCode(isKnit ? '6104' : '6204', '6', fiber));
    } else if (/\b(blazer|jaqueta|casaco|colete)\b/.test(text)) {
      preferred = choose(this.garmentCode(isKnit ? '6104' : '6204', '3', fiber));
    } else if (/\b(macacao|kimono)\b/.test(text)) {
      preferred = choose(fiber === 'cotton' ? '62114200' : fiber === 'other' ? '62114900' : '62114300');
    } else if (/\b(camiseta|regata|cropped|t shirt)\b/.test(text)) {
      preferred = choose(fiber === 'cotton' ? '61091000' : '61099000');
    } else if (/\b(blusa|camisa)\b/.test(text)) {
      if (isKnit) {
        preferred = choose(fiber === 'cotton' ? '61061000' : fiber === 'other' ? '61069000' : '61062000');
      } else {
        preferred = choose(fiber === 'cotton' ? '62063000' : fiber === 'other' ? '62069000' : '62064000');
      }
    }

    return preferred || choose('61099000') || candidates[0]?.code || '61099000';
  }

  private garmentCode(
    heading: '6104' | '6204',
    familyDigit: '3' | '4' | '5' | '6',
    fiber: 'cotton' | 'synthetic' | 'artificial' | 'other',
  ): string {
    const fiberDigit = fiber === 'cotton' ? '2' : fiber === 'synthetic' ? '3' : fiber === 'artificial' && familyDigit === '4' ? '4' : '9';
    return `${heading}${familyDigit}${fiberDigit}00`;
  }

  private result(
    ncm: string,
    source: NcmClassificationSource,
    table: OfficialNcmTable,
  ): NcmClassificationResult {
    const embedded = FASHION_NCM_CANDIDATES.find((candidate) => candidate.code === ncm);
    return {
      ncm,
      source,
      officialDescription: table.codes.get(ncm) || embedded?.label || '',
      officiallyValidated: table.officiallyValidated,
    };
  }

  private cacheKey(input: NcmClassificationInput): string {
    return this.normalize(
      [
        input.descricaoBase,
        input.grupoNome,
        input.subgrupoNome,
        input.tecidoNome,
        ...(input.modelagens || []),
        ...(input.ocasioes || []),
      ]
        .filter(Boolean)
        .join('|'),
    );
  }

  private extractJson(text: string): any | null {
    const block = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    for (const candidate of [block, String(text || '').match(/\{[\s\S]*\}/)?.[0]]) {
      if (!candidate) continue;
      try {
        return JSON.parse(candidate.trim());
      } catch {}
    }
    return null;
  }

  private onlyDigits(value: unknown): string {
    return String(value || '').replace(/\D/g, '');
  }

  private normalize(value: string): string {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
}
