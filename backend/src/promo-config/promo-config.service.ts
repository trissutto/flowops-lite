import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CAMPANHA_PADRAO,
  ConfigCampanha,
  ESTRUTURA_MAX,
  PCT_MAX,
  PCT_MIN,
  TERMOS_MAX,
  compilarTermo,
  idDeEstrutura,
  normalizarConfig,
} from '../common/promo-por-termo';

const APP_CONFIG_KEY = 'promo-config';

/**
 * Configuração das promoções automáticas — PDV e site (AppConfig `promo-config`).
 *
 * Até 15/09/2026 guardava só o filtro de BÁSICO da promoção de 50% ("liquida
 * antigos"). A promoção saiu do ar e o que mora aqui agora é a CAMPANHA POR
 * TERMO (`common/promo-por-termo.ts`): ligada, nome, %, termos, palavras que
 * excluem e grupos/subgrupos do ERP. O resto da regra (quem entra, exceção por
 * família, arredondamento) é da régua, não desta config.
 *
 * Config gravada antes dos campos novos existirem lê o padrão deles (ex.: as
 * palavras que excluem BERMUDA e 22 DE ABRIL) — o `normalizarConfig` completa.
 *
 * O campo antigo `excluirBasicoNa50` pode continuar gravado na linha do banco:
 * é ignorado na leitura e some na primeira gravação.
 */
export interface CampanhaGravada extends ConfigCampanha {
  atualizadaEm?: string | null;
  atualizadaPor?: string | null;
}

export interface PromoConfig {
  campanha: CampanhaGravada;
}

@Injectable()
export class PromoConfigService {
  private readonly logger = new Logger(PromoConfigService.name);
  private _cache: PromoConfig | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Config atual. Sem linha no banco = a campanha padrão do dono (Inverno 30%).
   *
   * ⚠️ Erro de leitura SOBE. Antes esta função devolvia o padrão quando o
   * banco falhava — inofensivo pra um filtro de básico, perigoso pra uma
   * campanha: uma leitura que não voltou ligaria 30% com os termos de fábrica
   * numa rede que tinha desligado a campanha. Quem precisa de resiliência
   * (`PromoCampanhaService.regra`) guarda a última regra boa.
   */
  async getConfig(): Promise<PromoConfig> {
    if (this._cache) return this._cache;
    const row = await (this.prisma as any).appConfig.findUnique({
      where: { key: APP_CONFIG_KEY },
    });
    let gravada: any = null;
    if (row?.valueJson) {
      try {
        gravada = JSON.parse(row.valueJson);
      } catch (e: any) {
        this.logger.error(`[promo-config] JSON inválido no banco — valendo o padrão: ${e?.message}`);
      }
    }
    const c = gravada?.campanha;
    const config: PromoConfig = {
      campanha: {
        ...normalizarConfig(c ?? CAMPANHA_PADRAO),
        atualizadaEm: c?.atualizadaEm ?? null,
        atualizadaPor: c?.atualizadaPor ?? null,
      },
    };
    this._cache = config;
    return config;
  }

  /**
   * Grava a campanha. Valida ALTO em vez de corrigir calado: % fora da faixa
   * ou termo que não pega nada volta 400 com a frase pra tela — "30" digitado
   * como "300" não pode virar 90% em silêncio.
   */
  async setConfig(input: { campanha?: Partial<ConfigCampanha> } | null, usuario?: string): Promise<PromoConfig> {
    const atual = await this.getConfig();
    const pedida = { ...atual.campanha, ...(input?.campanha || {}) };

    const nome = String(pedida.nome ?? '').trim();
    if (!nome) throw new BadRequestException('Dê um nome pra campanha (ex.: Inverno).');
    if (nome.length > 30) throw new BadRequestException('Nome da campanha com no máximo 30 letras.');

    const pct = Number(pedida.pct);
    if (!Number.isInteger(pct) || pct < PCT_MIN || pct > PCT_MAX) {
      throw new BadRequestException(`O desconto tem que ser um número inteiro de ${PCT_MIN} a ${PCT_MAX} (%).`);
    }

    const lerTermos = (lista: unknown, rotulo: string): string[] => {
      const termos = Array.isArray(lista) ? lista.map((t) => String(t ?? '')) : [];
      const invalidos = termos.filter((t) => t.trim() && !compilarTermo(t));
      if (invalidos.length) {
        throw new BadRequestException(
          `${rotulo} que não pega nenhuma peça: ${invalidos.map((t) => `"${t.trim()}"`).join(', ')}. ` +
            'Com * no fim, deixe pelo menos 3 letras antes (TRIC*); só "DE", "DA", "COM"… sozinhos não valem.',
        );
      }
      if (termos.filter((t) => t.trim()).length > TERMOS_MAX) {
        throw new BadRequestException(`No máximo ${TERMOS_MAX} itens em "${rotulo}".`);
      }
      return termos;
    };
    const termos = lerTermos(pedida.termos, 'Termo');
    const termosExclusao = lerTermos(pedida.termosExclusao, 'Palavra que exclui');

    const lerIds = (lista: unknown, rotulo: string): number[] => {
      const brutos = Array.isArray(lista) ? lista : [];
      // Nulo/vazio viraria o subgrupo 0 (que existe) — recusa em vez de adivinhar.
      const ruins = brutos.filter((v) => idDeEstrutura(v) == null);
      if (ruins.length) {
        throw new BadRequestException(`${rotulo} inválido: ${ruins.slice(0, 5).map((v) => JSON.stringify(v)).join(', ')}.`);
      }
      return brutos.map((v) => idDeEstrutura(v) as number);
    };
    const grupos = lerIds(pedida.grupos, 'Grupo');
    const subgrupos = lerIds(pedida.subgrupos, 'Subgrupo');
    if (new Set(grupos).size + new Set(subgrupos).size > ESTRUTURA_MAX) {
      throw new BadRequestException(`No máximo ${ESTRUTURA_MAX} grupos e subgrupos somados.`);
    }

    const novo: PromoConfig = {
      campanha: {
        ...normalizarConfig({
          ativa: pedida.ativa !== false, nome, pct, termos, termosExclusao, grupos, subgrupos,
          // Só desliga com `false` explícito: "linha básica não entra" é a regra.
          excluirBasico: pedida.excluirBasico !== false,
        }),
        atualizadaEm: new Date().toISOString(),
        atualizadaPor: usuario || null,
      },
    };

    await (this.prisma as any).appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, valueJson: JSON.stringify(novo) },
      update: { valueJson: JSON.stringify(novo) },
    });
    this._cache = novo;
    this.logger.log(
      `[promo-config] campanha "${novo.campanha.nome}" ${novo.campanha.ativa ? 'LIGADA' : 'desligada'} · ` +
        `${novo.campanha.pct}% · ${novo.campanha.termos.length} termo(s) · ` +
        `${novo.campanha.termosExclusao.length} exclusão(ões) · ` +
        `${novo.campanha.grupos.length} grupo(s) · ${novo.campanha.subgrupos.length} subgrupo(s) · por ${usuario || '?'}`,
    );
    return novo;
  }

  clearCache(): void {
    this._cache = null;
  }
}
