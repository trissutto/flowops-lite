import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const APP_CONFIG_KEY = 'avaliacoes-config';

/**
 * As REGRAS do programa de avaliação — todas na mão da matriz.
 *
 * O dono pediu pontuação "a definir numa tela de configuração": nenhum destes
 * números pode estar chumbado no código, porque a régua de um programa de
 * pontos se ajusta com o resultado (avaliação de mais? sobe o mínimo; poucas
 * fotos? sobe o bônus de foto) e mexer em deploy pra isso é o que faz o
 * programa nunca ser ajustado.
 *
 * Ver /retaguarda/avaliacoes.
 */
export interface AvaliacoesConfig {
  /** Programa ligado. Desligado: a barra some e ninguém ganha ponto. */
  ativo: boolean;

  /** Pontos por avaliação enviada (só as estrelas já valem isto). */
  pontosEnvio: number;
  /** Bônus por escrever um texto com pelo menos `minPalavras`. */
  pontosTexto: number;
  minPalavras: number;
  /** Bônus por mandar pelo menos uma foto da peça vestida. */
  pontosFoto: number;
  /** Bônus por informar altura e peso (é o que calibra o Fit AI). */
  pontosMedidas: number;

  /** Teto de fotos por avaliação. */
  maxFotos: number;

  /**
   * Quantos dias depois da ENTREGA a peça pode ser avaliada. 0 = na hora que
   * o rastreio confirma a entrega.
   */
  diasAposEntrega: number;

  /**
   * Dias depois da ENTREGA ate o CONVITE sair no WhatsApp.
   *
   * Separado do `diasAposEntrega` de proposito, ainda que os dois contem da
   * mesma data. Sao duas perguntas diferentes:
   *   · `diasAposEntrega` = a partir de quando a peca PODE ser avaliada. Zero
   *     esta certo ali: se ela entrar na conta no dia da entrega, a peca tem
   *     que estar la esperando.
   *   · `diasConvite` = quando a gente PUXA o assunto. No dia da entrega ela
   *     ainda nao vestiu, e "conta como ficou" sem ter usado nao rende
   *     avaliacao — rende uma mensagem ignorada e um convite queimado.
   *
   * Amarrar os dois no mesmo numero fazia o convite sair junto com a entrega
   * (o pedido do dono era CINCO DIAS).
   */
  diasConvite: number;
  /**
   * Prazo alternativo pra quando a entrega nunca é confirmada (rastreio de
   * outro contrato, retirada em loja): N dias depois do pedido pago a peça
   * libera assim mesmo. A Shopee usa 20.
   */
  diasAposPedido: number;

  /**
   * Por quantos dias a peça CONTINUA avaliável, contados do pedido.
   *
   * Sem este teto, quem compra há dois anos abre a tela com duzentas peças na
   * fila — e fila que não acaba ninguém começa. Também impede despejar o
   * histórico inteiro num dia só pra juntar ponto.
   */
  janelaDias: number;

  /** Avaliação nasce OCULTA e só aparece no site depois que a matriz aprova. */
  moderacao: boolean;

  /**
   * Quantos pontos valem R$ 1 de desconto. Ainda NÃO existe resgate — o
   * número está aqui pra a matriz fechar a régua antes de a primeira cliente
   * juntar pontos, porque mudar a cotação depois é quebra de promessa.
   */
  pontosPorReal: number;

  /**
   * Piso do resgate, em pontos. Cupom de R$ 1 dá trabalho pra todo mundo e
   * não muda comportamento nenhum; o piso é o que faz o saldo virar motivo
   * pra voltar.
   */
  minimoResgate: number;
}

export const AVALIACOES_CONFIG_PADRAO: AvaliacoesConfig = {
  ativo: true,
  pontosEnvio: 5,
  pontosTexto: 5,
  minPalavras: 20,
  pontosFoto: 10,
  pontosMedidas: 2,
  maxFotos: 5,
  diasAposEntrega: 0,
  diasConvite: 5,
  diasAposPedido: 20,
  janelaDias: 90,
  moderacao: false,
  pontosPorReal: 100,
  minimoResgate: 500,
};

@Injectable()
export class AvaliacoesConfigService {
  private readonly logger = new Logger(AvaliacoesConfigService.name);
  private cache: AvaliacoesConfig | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<AvaliacoesConfig> {
    if (this.cache) return this.cache;
    try {
      const row = await (this.prisma as any).appConfig.findUnique({
        where: { key: APP_CONFIG_KEY },
      });
      if (row?.valueJson) {
        // Merge com o padrão: campo novo em versão nova não deixa a config
        // salva antes dele virar `undefined` no meio da conta de pontos.
        const merged = { ...AVALIACOES_CONFIG_PADRAO, ...JSON.parse(row.valueJson) };
        this.cache = merged;
        return merged;
      }
    } catch (e: any) {
      this.logger.warn(`[avaliacoes-config] ler banco falhou: ${e?.message}`);
    }
    this.cache = AVALIACOES_CONFIG_PADRAO;
    return AVALIACOES_CONFIG_PADRAO;
  }

  async set(input: Partial<AvaliacoesConfig>): Promise<AvaliacoesConfig> {
    const atual = await this.get();
    const novo: AvaliacoesConfig = { ...atual, ...input };

    // Normaliza: o front manda string/undefined e um NaN aqui vira pontuação
    // fantasma (a cliente ganha "NaN pontos" e o saldo some).
    const inteiro = (v: any, padrao: number, min = 0) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= min ? n : padrao;
    };
    novo.ativo = !!novo.ativo;
    novo.moderacao = !!novo.moderacao;
    novo.pontosEnvio = inteiro(novo.pontosEnvio, AVALIACOES_CONFIG_PADRAO.pontosEnvio);
    novo.pontosTexto = inteiro(novo.pontosTexto, AVALIACOES_CONFIG_PADRAO.pontosTexto);
    novo.pontosFoto = inteiro(novo.pontosFoto, AVALIACOES_CONFIG_PADRAO.pontosFoto);
    novo.pontosMedidas = inteiro(novo.pontosMedidas, AVALIACOES_CONFIG_PADRAO.pontosMedidas);
    novo.minPalavras = inteiro(novo.minPalavras, AVALIACOES_CONFIG_PADRAO.minPalavras, 1);
    novo.maxFotos = Math.min(inteiro(novo.maxFotos, AVALIACOES_CONFIG_PADRAO.maxFotos, 1), 10);
    novo.diasAposEntrega = inteiro(novo.diasAposEntrega, AVALIACOES_CONFIG_PADRAO.diasAposEntrega);
    novo.diasConvite = inteiro(novo.diasConvite, AVALIACOES_CONFIG_PADRAO.diasConvite);
    novo.diasAposPedido = inteiro(novo.diasAposPedido, AVALIACOES_CONFIG_PADRAO.diasAposPedido, 1);
    novo.janelaDias = inteiro(novo.janelaDias, AVALIACOES_CONFIG_PADRAO.janelaDias, 1);
    novo.pontosPorReal = inteiro(novo.pontosPorReal, AVALIACOES_CONFIG_PADRAO.pontosPorReal, 1);
    novo.minimoResgate = inteiro(novo.minimoResgate, AVALIACOES_CONFIG_PADRAO.minimoResgate, 1);

    await (this.prisma as any).appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, valueJson: JSON.stringify(novo) },
      update: { valueJson: JSON.stringify(novo) },
    });
    this.cache = novo;
    this.logger.log(`[avaliacoes-config] atualizado: ${JSON.stringify(novo)}`);
    return novo;
  }

  clearCache(): void {
    this.cache = null;
  }
}
