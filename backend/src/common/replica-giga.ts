/**
 * RÉPLICA PRO GIGA — DESLIGADA.
 *
 * Ordem do dono (27/08/2026): **"JÁ SAÍMOS DELE FAZ 1 MÊS"**. A saída do
 * Giga/Wincred foi decidida em 02/08 e o Flow é a fonte de estoque, venda,
 * crediário e financeiro desde julho. O que sobrava era a RÉPLICA: cada
 * movimento do Flow ainda era copiado pro MySQL da KingHost, inline ou pelo
 * `erp_outbox`.
 *
 * Essa cópia parou de funcionar sozinha em **25/08 18:09**, quando a KingHost
 * passou a recusar o IP do Railway no login:
 *
 *     Access denied for user 'gigasistemas21'@'52.52.227.69' (using password: YES)
 *
 * Em 27/08 o resultado era **262 de 500 linhas do log de produção** sendo esse
 * erro, uma fila de **105 vendas + 263 movimentos de estoque + 8 baixas de
 * crediário** pendentes, e mais 64 jobs que já tinham desistido no teto de 100
 * tentativas. Nada disso afetava a operação — só empilhava passivo e escondia
 * erro de verdade no meio do barulho.
 *
 * ── O QUE ESTA TRAVA FAZ ──
 *
 * Desliga só a **CÓPIA PRO GIGA**: a escrita no Flow (que é a verdade) segue
 * igual, e é ela que a loja vê. Com a trava ativa:
 *   - `increaseStock`/`decreaseStock` aplicam no Flow e NÃO tentam o MySQL;
 *   - nada novo entra no `erp_outbox` como réplica de estoque;
 *   - o cron do outbox DESCARTA o que já estava na fila, marcando `done` com
 *     o motivo (o registro fica — não é DELETE).
 *
 * Mesmo desenho que os marcados já usavam desde 07/08 ("nunca marque ou puxe
 * nada do Giga"), agora valendo pro resto.
 *
 * ── POR QUE NÃO É O `ERP_WRITE_ENABLED` ──
 *
 * Porque aquela env não significa mais o que o nome diz. `ERP_WRITE_ENABLED=0`
 * hoje faz `increaseStock`/`decreaseStock` caírem no ramo "Giga only", que
 * devolve `success:false` **sem aplicar no Flow** — e ainda joga a bipagem da
 * separação em modo `shadow` (`pick-scan`). Desligar aquela flag pra calar o
 * Giga derrubaria o estoque da rede. Por isso a trava é própria e cirúrgica.
 *
 * Religar (se a KingHost liberar o IP e alguém quiser o Giga em dia de novo):
 * `ERP_REPLICA_GIGA=1` no Railway. A fila recomeça vazia — o que foi descartado
 * não volta.
 */
export function replicaGigaLigada(): boolean {
  return String(process.env.ERP_REPLICA_GIGA ?? '').trim() === '1';
}

/** Texto gravado no job descartado, pra quem for auditar a fila depois. */
export const MOTIVO_REPLICA_DESLIGADA =
  'skipped: replica pro Giga desligada (27/08/2026, ERP_REPLICA_GIGA=1 religa)';

/**
 * "A escrita no Giga está bloqueada?" — pergunta que só faz sentido enquanto a
 * réplica existe.
 *
 * `ERP_WRITE_ENABLED` virou, com o tempo, o interruptor de coisas que NÃO são
 * do Giga: `erpStepBaixarEstoque`, o reconcile do backlog e o marcado usam a
 * flag pra decidir se BAIXAM ESTOQUE — e o estoque mora no Flow desde 14/07.
 * Desligar a env pra calar o Giga faria a loja vender sem dar baixa em lugar
 * nenhum. Com a réplica desligada a flag não governa mais nada, e a baixa no
 * Flow acontece sempre.
 */
export function escritaGigaBloqueada(isWriteEnabled: boolean): boolean {
  return replicaGigaLigada() && !isWriteEnabled;
}

/**
 * PULL DO GIGA — DESLIGADO.
 *
 * A outra metade do problema. Desligar a RÉPLICA (acima) sem desligar o PULL
 * abre um buraco pior que o original: os crons que copiam Giga→Flow fazem
 * `deleteMany` + recarga, e o que eles trazem é um Giga que NÃO recebe mais as
 * baixas, as vendas e os movimentos do Flow.
 *
 * O caso concreto que forçou esta trava (27/08, medido): o cron
 * `crediario-nativo-sync` roda às **04:10**, apaga `crediario_parcelas` onde
 * `flowIsSource=false` e recarrega da `movimento` do Giga. Cliente que pagou
 * hoje no Flow voltaria a aparecer DEVENDO amanhã — e a loja cobraria de novo.
 * Mesmo desenho do incidente em que o Giga carimbava o saldo de estoque por
 * cima do Flow, agora valendo dinheiro de crediário.
 *
 * E não adianta apostar que "o Giga está fora, então o cron não roda": o acesso
 * é INTERMITENTE. Em 27/08, no meio de dois dias de `Access denied`, houve um
 * sync bem-sucedido às 05:20.
 *
 * Religar (só com a réplica religada junto, senão volta o buraco):
 * `ERP_PULL_GIGA=1`.
 */
export function pullGigaLigado(): boolean {
  return String(process.env.ERP_PULL_GIGA ?? '').trim() === '1';
}

/**
 * O SERVIDOR DO GIGA FOI DESLIGADO — nem tenta conectar.
 *
 * Ordem do dono (27/08/2026): **"o servidor desliga hoje meia-noite"**.
 *
 * Enquanto ele recusava login, cada tentativa voltava rápido com
 * `Access denied`. Um servidor DESLIGADO não responde nada: o TCP fica
 * esperando o `connectTimeout` de 12s, e cada chamada que ainda passa por
 * ali segura uma das 15 vagas do pool por 12 segundos. Foi assim que o Giga
 * derrubou a live de 01/07 — pendurado, não caído.
 *
 * Com esta trava o pool NÃO é criado. `this.pool` fica nulo e todo método do
 * ErpService que o consulta sai na hora, como já sai quando o pool não
 * inicializa. Quem lê catálogo, estoque, REF/cor/tamanho e crediário já
 * responde do Postgres — o Giga era só o recuo.
 *
 * `ERP_GIGA_OFF=0` (ou apagar a env) volta a criar o pool, se um dia o
 * servidor voltar.
 */
export function gigaDesligado(): boolean {
  return String(process.env.ERP_GIGA_OFF ?? '1').trim() === '1';
}

/**
 * O SERVIDOR DA KINGHOST (WordPress/WooCommerce legado) também morreu junto
 * com o desligamento de 27/08 — Giga e WP dividiam a hospedagem. Tudo que
 * ainda batia lá (poller de pedidos WC de 1 em 1 min, sync de conteúdo das
 * 04:35, fotos antigas, CPF via Woo) só colhe erro. `KINGHOST_WP=1` religa
 * se um dia houver um WP novo pra apontar.
 */
export function wordpressLegadoLigado(): boolean {
  return String(process.env.KINGHOST_WP ?? '').trim() === '1';
}
