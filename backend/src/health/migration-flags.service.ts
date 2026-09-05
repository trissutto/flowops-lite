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
    // default ON desde 03/09/2026 — tem que casar com o getter nativeReads do
    // CrediarioBaixaService, senão este painel relata o contrário do que roda.
    ligada: (v) => String(v ?? '1') === '1',
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
    // default ON desde 03/09/2026 — casa com os getters do ProductSearch,
    // do WincredCatalog e do ProductNative.
    ligada: (v) => String(v ?? '1').trim() !== '0',
    efeito: 'busca de produto lê da tabela Product nativa',
    sensivel: true,
  },
  {
    nome: 'GIGA_MIRROR_READS',
    // default ON desde 03/09/2026 — casa com mirrorReadsEnabled do ErpService.
    ligada: (v) => String(v ?? '1').trim() !== '0',
    efeito: 'estoque + faturamento bruto leem dos espelhos',
    sensivel: true,
  },
  {
    nome: 'PDV_MIRROR_READS',
    ligada: (v) => String(v ?? '').trim() !== '0',
    // Não existe mais "fallback": com `0` a busca do crediário e a Consulta
    // caem num caminho SEM banco atrás, que devolve vazio sem lançar.
    efeito: 'busca do crediário e Consulta de loja leem o espelho Postgres (com 0 devolvem vazio calado)',
    sensivel: true,
  },

  // ── Escritas: não fazem sumir da tela, mudam POR ONDE grava ──
  {
    nome: 'PRODUCT_NATIVE_WRITES',
    // default ON desde 03/09/2026 (Onda 1). ANTES dela o products-editor
    // lia `?? ''` === '1' — era default OFF de verdade, e este painel
    // estava certo em dizer isso.
    ligada: (v) => String(v ?? '1').trim() !== '0',
    efeito: 'edição de produto grava na tabela nativa (com 0 toda edição vira 500)',
  },
  {
    nome: 'PDV_ERP_OUTBOX',
    ligada: (v) => String(v ?? '').trim() !== '0',
    efeito: 'venda enfileira job no erp_outbox — é por ele que a BAIXA DE ESTOQUE roda, com retry',
  },
  {
    nome: 'CREDIARIO_ERP_OUTBOX',
    // default ON desde 03/09/2026 — casa com crediarioOutboxEnabled.
    ligada: (v) => String(v ?? '1') === '1',
    efeito: 'baixa/estorno do crediário passam pela fila (com 0 a baixa espera um servidor que não responde)',
  },
  {
    nome: 'ERP_STOCK_WRITES_ASYNC',
    ligada: (v) => String(v ?? '1') !== '0',
    efeito: 'escritas secundárias de estoque vão por fila (a aplicação no Postgres é a mesma)',
  },
  {
    nome: 'PO_RECEIVE_ERP_OUTBOX',
    ligada: (v) => String(v ?? '1') !== '0',
    efeito: 'recebimento de pedido de compra vai por fila (a aplicação no Postgres é a mesma)',
  },

  // ── Portas da BAIXA DE ESTOQUE ────────────────────────────────────────
  // Estas duas não faziam parte do painel e são as que mais doem quando
  // ficam off: o bipe da separação registra a peça e o estoque NÃO anda.
  // A única pista sem isto aqui era `debitSkippedReason` na linha do tempo
  // do pedido — pista que ninguém procura antes de saber que existe.
  {
    nome: 'ERP_WRITE_ENABLED',
    // Mesma expressão do getter isWriteEnabled do ErpService.
    ligada: (v) => ['true', '1', 'yes'].includes(String(v ?? '').trim().toLowerCase()),
    efeito: 'bipe da separação, approveDebit e a baixa da live tiram a peça do estoque',
    sensivel: true,
  },
  {
    nome: 'PICK_SCAN_DEBIT',
    ligada: (v) => String(v ?? '1').trim() !== '0',
    efeito: 'o bipe da separação baixa estoque na hora (com 0 só no finish-separation)',
  },

  // ── Crons dos espelhos: sem eles o espelho envelhece calado ──
  {
    nome: 'WINCRED_MIRROR_CRON_ENABLED',
    ligada: (v) => String(v ?? '').trim() === '1',
    efeito: 'crons dos espelhos rodam (OBRIGATÓRIA em produção)',
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
        // Ligada SEM a variável existir. Nasceu como alarme (foi assim que
        // MARCADOS_NATIVE_READS ficou ativo em produção sem ninguém decidir).
        // Depois da inversão de defaults de 03/09 isto é ESPERADO nas cinco
        // migradas — lá o default LIGADO é a decisão, e o alçapão seria o
        // contrário. Continua valendo como aviso pras demais.
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
      this.logger.log(
        `${omissao.length} flag(s) valendo pelo DEFAULT do código (variável não existe no ambiente): ` +
        `${omissao.map((f) => f.nome).join(', ')}. Nas leituras migradas isso é o esperado desde 03/09 ` +
        '— o default LIGADO é a decisão; o alçapão seria o contrário.',
      );
    }
    if (sensiveisOn.length) {
      this.logger.log(
        `leitura do Postgres ATIVA em: ${sensiveisOn.map((f) => f.nome).join(', ')}. ` +
        'É o caminho certo — não desligue pra "testar": não há segunda fonte atrás.',
      );
    }
    if (!flags.find((f) => f.nome === 'WINCRED_MIRROR_CRON_ENABLED')?.ligada) {
      this.logger.warn(
        'WINCRED_MIRROR_CRON_ENABLED desligada — os espelhos NÃO estão atualizando. ' +
        'Qualquer leitura migrada está servindo dado velho.',
      );
    }
    if (!flags.find((f) => f.nome === 'ERP_WRITE_ENABLED')?.ligada) {
      this.logger.error(
        'ERP_WRITE_ENABLED desligada — o bipe da separação REGISTRA a peça e NÃO baixa estoque ' +
        '(fica gravado como debitSkippedReason="shadow" na linha do tempo do pedido). ' +
        'Tem que ficar true.',
      );
    }
  }
}
