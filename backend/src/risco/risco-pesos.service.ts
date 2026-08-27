import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const APP_CONFIG_KEY = 'risco-pesos';

/**
 * A RÉGUA DO SCORE — na mão da matriz, nunca chumbada no código.
 *
 * O documento pede explicitamente que o administrador possa alterar os pesos
 * (item 4), e a razão é boa: peso de score se calibra com o RESULTADO. Hoje a
 * base de chargeback é pequena demais pra calibrar nada — os números abaixo
 * são os sugeridos no documento, não uma verdade medida. Quando houver
 * histórico, o dono ajusta na tela sem esperar deploy.
 *
 * ⚠️ O NÚMERO É O RESUMO, O MOTIVO É O PRODUTO. O item 24 é categórico: nunca
 * mostrar "risco alto" sem dizer por quê. Se um dia a régua e os motivos
 * discordarem, quem manda é a lista de motivos — ela é auditável, o número não.
 */
export interface RiscoPesos {
  /** Módulo ligado. Desligado: nada é calculado e o painel some da tela. */
  ativo: boolean;

  // ── Relação com pedido que sofreu CHARGEBACK ──────────────────────────
  cbCpf: number;
  cbTelefone: number;
  cbEndereco: number;
  cbEmail: number;
  cbCartao: number;
  cbTitular: number;
  /**
   * O APARELHO não está no documento — é acréscimo nosso. O `anonymous_id`
   * vive ~2 anos no navegador dela e já era gravado em todo pedido do site.
   * Mesmo aparelho com CPF e e-mail diferentes é o sinal mais duro que a gente
   * tem, e custava zero: o dado já estava na tabela.
   */
  cbAparelho: number;
  /** IP pesa pouco de propósito: 4G troca a cada torre, prédio sai por um NAT. */
  cbIp: number;

  // ── Combinações ───────────────────────────────────────────────────────
  /**
   * Telefone E endereço batendo no MESMO pedido com chargeback. SUBSTITUI os
   * dois pesos individuais em vez de somar — senão a mesma relação pontuaria
   * três vezes (é a "duplicidade de pontuação" que o item 4 manda evitar).
   */
  comboTelefoneEndereco: number;
  /**
   * Cadastro DIFERENTE (CPF/e-mail novos) no mesmo telefone ou endereço de um
   * pedido com chargeback. É o padrão exato do exemplo do documento: mesma
   * casa, mesmo celular, ficha nova pra escapar do casamento por CPF.
   */
  comboCadastroNovo: number;

  // ── Reincidência ──────────────────────────────────────────────────────
  /**
   * QUANTO PESA O SEGUNDO CHARGEBACK — em % sobre o peso do primeiro.
   *
   * Sem isto, "o telefone bate num pedido contestado" e "o telefone bate em
   * DOIS pedidos contestados" valem igual — e não valem: reincidência é
   * justamente o que separa o azar do padrão. É o que faz o cenário do
   * documento (dois chargebacks no mesmo telefone e endereço, com cadastro
   * novo por cima) sair como CRÍTICO em vez de alto.
   *
   * Só vale pras relações COM CHARGEBACK. As regras categóricas (cadastro
   * novo, multiplicidade) não escalam: ou o padrão está lá, ou não está.
   */
  reincidenciaBonus: number;
  /** Teto do multiplicador. 2 = o peso nunca passa do dobro do original. */
  reincidenciaTeto: number;

  // ── Multiplicidade (não depende de chargeback) ────────────────────────
  multiCartoes: number;
  multiCpfs: number;
  multiEmails: number;
  /** A partir de quantos valores distintos a multiplicidade vira alerta. */
  multiMinimo: number;
  /** Janela da multiplicidade, em dias. "Vários cartões em curto período." */
  multiJanelaDias: number;

  // ── Faixas ────────────────────────────────────────────────────────────
  faixaModerado: number;
  faixaAlto: number;
  faixaCritico: number;

  /**
   * Até quantos dias pra trás o cruzamento olha. 0 = sem limite.
   * A fraude reincidente é recente; pedido de 2023 relacionado por endereço é
   * quase sempre a cliente que mudou de casa.
   */
  janelaDias: number;
  /** Teto de pedidos relacionados carregados por análise (proteção da tela). */
  maxRelacionados: number;
}

export const PESOS_PADRAO: RiscoPesos = {
  ativo: true,

  cbCpf: 25,
  cbTelefone: 15,
  cbEndereco: 20,
  cbEmail: 10,
  cbCartao: 20,
  cbTitular: 20,
  cbAparelho: 20,
  cbIp: 5,

  comboTelefoneEndereco: 25,
  comboCadastroNovo: 30,

  reincidenciaBonus: 50,
  reincidenciaTeto: 2,

  multiCartoes: 15,
  multiCpfs: 15,
  multiEmails: 10,
  multiMinimo: 3,
  multiJanelaDias: 90,

  faixaModerado: 30,
  faixaAlto: 60,
  faixaCritico: 80,

  janelaDias: 540,
  maxRelacionados: 50,
};

export type NivelRisco = 'baixo' | 'moderado' | 'alto' | 'critico';

@Injectable()
export class RiscoPesosService {
  private readonly logger = new Logger(RiscoPesosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<RiscoPesos> {
    try {
      const row = await (this.prisma as any).appConfig.findUnique({
        where: { key: APP_CONFIG_KEY },
      });
      if (!row?.valueJson) return { ...PESOS_PADRAO };
      const salvo = JSON.parse(row.valueJson);
      // Merge sobre o padrão: peso novo que o código introduzir passa a valer
      // sozinho, sem precisar que alguém reabra a tela e salve.
      return this.sanear({ ...PESOS_PADRAO, ...salvo });
    } catch (e: any) {
      this.logger.warn(`[risco] pesos ilegíveis, usando padrão: ${e?.message || e}`);
      return { ...PESOS_PADRAO };
    }
  }

  async set(parcial: Partial<RiscoPesos>): Promise<RiscoPesos> {
    const atual = await this.get();
    const novo = this.sanear({ ...atual, ...parcial });
    await (this.prisma as any).appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, valueJson: JSON.stringify(novo) },
      update: { valueJson: JSON.stringify(novo) },
    });
    return novo;
  }

  /**
   * Peso negativo, faixa fora de ordem ou janela absurda quebrariam o motor de
   * um jeito difícil de enxergar (score sempre 0, tudo crítico). A régua se
   * defende aqui, uma vez, em vez de em cada uso.
   */
  private sanear(p: RiscoPesos): RiscoPesos {
    const n = (v: any, padrao: number, min = 0, max = 100) =>
      Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : padrao, min), max);

    const s: RiscoPesos = {
      ativo: p.ativo !== false,
      cbCpf: n(p.cbCpf, PESOS_PADRAO.cbCpf),
      cbTelefone: n(p.cbTelefone, PESOS_PADRAO.cbTelefone),
      cbEndereco: n(p.cbEndereco, PESOS_PADRAO.cbEndereco),
      cbEmail: n(p.cbEmail, PESOS_PADRAO.cbEmail),
      cbCartao: n(p.cbCartao, PESOS_PADRAO.cbCartao),
      cbTitular: n(p.cbTitular, PESOS_PADRAO.cbTitular),
      cbAparelho: n(p.cbAparelho, PESOS_PADRAO.cbAparelho),
      cbIp: n(p.cbIp, PESOS_PADRAO.cbIp),
      comboTelefoneEndereco: n(p.comboTelefoneEndereco, PESOS_PADRAO.comboTelefoneEndereco),
      comboCadastroNovo: n(p.comboCadastroNovo, PESOS_PADRAO.comboCadastroNovo),
      reincidenciaBonus: n(p.reincidenciaBonus, PESOS_PADRAO.reincidenciaBonus, 0, 200),
      reincidenciaTeto: n(p.reincidenciaTeto, PESOS_PADRAO.reincidenciaTeto, 1, 5),
      multiCartoes: n(p.multiCartoes, PESOS_PADRAO.multiCartoes),
      multiCpfs: n(p.multiCpfs, PESOS_PADRAO.multiCpfs),
      multiEmails: n(p.multiEmails, PESOS_PADRAO.multiEmails),
      multiMinimo: n(p.multiMinimo, PESOS_PADRAO.multiMinimo, 2, 20),
      multiJanelaDias: n(p.multiJanelaDias, PESOS_PADRAO.multiJanelaDias, 1, 3650),
      faixaModerado: n(p.faixaModerado, PESOS_PADRAO.faixaModerado, 1, 99),
      faixaAlto: n(p.faixaAlto, PESOS_PADRAO.faixaAlto, 2, 99),
      faixaCritico: n(p.faixaCritico, PESOS_PADRAO.faixaCritico, 3, 100),
      janelaDias: n(p.janelaDias, PESOS_PADRAO.janelaDias, 0, 3650),
      maxRelacionados: n(p.maxRelacionados, PESOS_PADRAO.maxRelacionados, 5, 300),
    };

    // Faixas fora de ordem viram faixas em ordem — a tela não pode ficar com
    // "alto" começando antes de "moderado".
    s.faixaAlto = Math.max(s.faixaAlto, s.faixaModerado + 1);
    s.faixaCritico = Math.max(s.faixaCritico, s.faixaAlto + 1);
    return s;
  }

  nivel(score: number, p: RiscoPesos): NivelRisco {
    if (score >= p.faixaCritico) return 'critico';
    if (score >= p.faixaAlto) return 'alto';
    if (score >= p.faixaModerado) return 'moderado';
    return 'baixo';
  }
}
