import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

/**
 * Carimba no log do boot o estado EFETIVO de cada flag da migração Giga→Flow.
 *
 * Por que isso existe: em 25/07 o crediário sumiu do PDV e o diagnóstico
 * começou errado — assumiu-se que a variável não existia no Railway e o fix
 * mexeu no DEFAULT. Só que variável de ambiente SOBREPÕE default: se ela
 * existe com '1', mexer no `?? '0'` não muda nada. Ninguém tinha onde olhar
 * pra saber o que estava realmente ligado em produção.
 *
 * Agora o log do deploy responde isso em 1 linha por flag: valor cru da env,
 * se está definida, e o que o código decidiu com ela. É o primeiro lugar a
 * conferir quando "sumiu" alguma coisa.
 */

type Flag = {
  nome: string;
  /** Como o código interpreta a env — mesma expressão do service que a usa. */
  ligada: (v: string | undefined) => boolean;
  /** O que acontece quando está LIGADA. */
  efeito: string;
  /** true = ligar sem validar já causou incidente / faz dado sumir da tela. */
  sensivel?: boolean;
};

const FLAGS: Flag[] = [
  // ── Leituras migradas: são as que fazem dado SUMIR quando o espelho falha ──
  {
    nome: 'CREDIARIO_NATIVE_READS',
    ligada: (v) => String(v ?? '0') === '1',
    efeito: 'crediário lê do espelho Postgres (incidente 25/07)',
    sensivel: true,
  },
  {
    nome: 'MARCADOS_NATIVE_READS',
    ligada: (v) => String(v ?? '0').trim() === '1',
    efeito: 'marcados leem da tabela nativa — se falhar, PDV libera acima do limite',
    sensivel: true,
  },
  {
    nome: 'PRODUCT_NATIVE_READS',
    ligada: (v) => String(v ?? '').trim() === '1',
    efeito: 'busca de produto lê da tabela Product nativa',
    sensivel: true,
  },
  {
    nome: 'GIGA_MIRROR_READS',
    ligada: (v) => String(v ?? '').trim() === '1',
    efeito: 'estoque + faturamento bruto leem dos espelhos',
    sensivel: true,
  },
  {
    nome: 'PDV_MIRROR_READS',
    ligada: (v) => String(v ?? '').trim() !== '0',
    efeito: 'bipe e busca do PDV leem o espelho (fallback Giga no miss)',
  },

  // ── Escritas: não fazem sumir da tela, mudam POR ONDE grava ──
  {
    nome: 'PRODUCT_NATIVE_WRITES',
    ligada: (v) => String(v ?? '').trim() === '1',
    efeito: 'edição de produto grava na tabela nativa (dual-write pro Giga)',
  },
  {
    nome: 'PDV_ERP_OUTBOX',
    ligada: (v) => String(v ?? '').trim() !== '0',
    efeito: 'venda finaliza no Postgres e replica no Giga por fila',
  },
  {
    nome: 'CREDIARIO_ERP_OUTBOX',
    ligada: (v) => String(v ?? '0') === '1',
    efeito: 'baixa/estorno do crediário replicam no Giga por fila',
  },
  {
    nome: 'ERP_STOCK_WRITES_ASYNC',
    ligada: (v) => String(v ?? '1') !== '0',
    efeito: 'baixa de estoque no Giga vai por fila',
  },
  {
    nome: 'PO_RECEIVE_ERP_OUTBOX',
    ligada: (v) => String(v ?? '1') !== '0',
    efeito: 'recebimento de pedido de compra replica no Giga por fila',
  },

  // ── Crons dos espelhos: sem eles o espelho envelhece calado ──
  {
    nome: 'WINCRED_MIRROR_CRON_ENABLED',
    ligada: (v) => String(v ?? '').trim() === '1',
    efeito: 'crons dos espelhos rodam (OBRIGATÓRIA em produção)',
  },
  {
    nome: 'ESTOQUE_SYNC_GIGA',
    ligada: (v) => String(v ?? '').trim() === '1',
    efeito: 'sync de estoque com o Giga',
  },
];

@Injectable()
export class MigrationFlagsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('MigrationFlags');

  /** Estado efetivo — usado no log do boot e pelo endpoint de saúde. */
  snapshot() {
    return FLAGS.map((f) => {
      const bruto = process.env[f.nome];
      return {
        nome: f.nome,
        definida: bruto !== undefined,
        valor: bruto ?? null,
        ligada: f.ligada(bruto),
        // Ligada SEM a variável existir = ninguém decidiu isso. Foi o que
        // deixou MARCADOS_NATIVE_READS ativo em produção sem querer.
        ligadaPorOmissao: bruto === undefined && f.ligada(bruto),
        sensivel: !!f.sensivel,
        efeito: f.efeito,
      };
    });
  }

  onApplicationBootstrap() {
    const flags = this.snapshot();
    const ligadas = flags.filter((f) => f.ligada);
    const omissao = flags.filter((f) => f.ligadaPorOmissao);
    const sensiveisOn = flags.filter((f) => f.ligada && f.sensivel);

    this.logger.log(
      `estado da migração Giga→Flow — ${ligadas.length}/${flags.length} ligadas`,
    );
    for (const f of flags) {
      const valor = f.definida ? `="${f.valor}"` : ' (não definida)';
      const marca = f.ligadaPorOmissao ? ' ⚠ LIGADA POR OMISSÃO' : '';
      this.logger.log(
        `  ${f.ligada ? 'ON ' : 'off'} ${f.nome}${valor}${marca}${f.ligada ? ` — ${f.efeito}` : ''}`,
      );
    }

    if (omissao.length) {
      this.logger.warn(
        `${omissao.length} flag(s) LIGADAS sem a variável existir no ambiente: ` +
        `${omissao.map((f) => f.nome).join(', ')}. Migração de leitura tem que ser decisão, não default.`,
      );
    }
    if (sensiveisOn.length) {
      this.logger.warn(
        `leitura migrada ATIVA em: ${sensiveisOn.map((f) => f.nome).join(', ')}. ` +
        'Se algum dado "sumir" da tela, comece desligando estas.',
      );
    }
    if (!flags.find((f) => f.nome === 'WINCRED_MIRROR_CRON_ENABLED')?.ligada) {
      this.logger.warn(
        'WINCRED_MIRROR_CRON_ENABLED desligada — os espelhos NÃO estão atualizando. ' +
        'Qualquer leitura migrada está servindo dado velho.',
      );
    }
  }
}
