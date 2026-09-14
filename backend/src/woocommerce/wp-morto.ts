import { GoneException } from '@nestjs/common';
import { wordpressLegadoLigado } from '../common/replica-giga';

/**
 * O WORDPRESS/WOOCOMMERCE FOI APAGADO — a porta fecha AQUI, com motivo.
 *
 * ── O QUE ACONTECEU ──
 *
 * A KingHost apagou o WordPress/WooCommerce em **27/08/2026** e o domínio
 * `lurds.com.br` passou a servir o site novo (Next.js na Vercel). A REST do
 * Woo não "caiu": ela responde, e responde MENTINDO sobre o motivo — medido
 * em 14/09/2026:
 *
 *     GET https://www.lurds.com.br/wp-json/wc/v3/products  → HTTP 403 (server: Vercel)
 *     GET https://lurds.com.br/wp-json/wc/v3/products      → HTTP 403 (server: Vercel)
 *
 * 403 é "sem permissão". Quem lê o log conclui "a chave do Woo venceu" e sai
 * procurando `WC_CONSUMER_KEY` — quando a verdade é que não existe mais
 * WordPress atrás desse endereço. É a mesma família de bug que a regra de ouro
 * do projeto persegue: **fonte morta com cara de outra coisa**.
 *
 * ── POR QUE UMA EXCEÇÃO, E NÃO UM RETORNO VAZIO ──
 *
 * O caminho que morreu calado foi o pior de todos: o bulk sync "ERP → Woo"
 * (`ProductsService.startBulkSync`) engolia a falha da primeira página
 * (`lastError = ...; break`) e **terminava dizendo que deu tudo certo**, com
 * zero produto processado — e o cron das 3h da manhã repetia isso todo dia,
 * sem ninguém pra ler. Erro que não sobe é erro que ninguém conserta.
 *
 * ── POR QUE 410 GONE (e não 500 nem 503) ──
 *
 * 410 é exatamente o que aconteceu: o recurso existia e foi removido de
 * propósito, e não vai voltar. Além da semântica, dois efeitos práticos no
 * frontend deste repo:
 *
 *   • `lib/api.ts` marca a conexão como OFFLINE em qualquer `status >= 500` —
 *     a bolinha de saúde do sistema ficaria VERMELHA por causa de uma tela de
 *     museu, e alarme falso mata a confiança no semáforo inteiro.
 *   • `apiRetry` não retenta 4xx. Um 503 seria retentado 3× pra ouvir a mesma
 *     coisa três vezes.
 *
 * ── A MENSAGEM É TEXTO DE TELA ──
 *
 * Todo chamador deste helper faz `alert(e.message)` ou mostra o corpo do erro
 * na tela, então a frase precisa dizer O QUE FAZER AGORA — e nunca mandar
 * fazer o impossível ("reative o plugin", "conserte no WordPress"). Não
 * existe mais onde.
 *
 * `KINGHOST_WP=1` reabre tudo isto, e só faz sentido se um dia existir um
 * WordPress NOVO pra apontar. Ver `wordpressLegadoLigado()` em
 * `common/replica-giga.ts` — a tranca é a mesma que segura o `WpDbService`.
 */
export const WP_LEGADO_APAGADO_EM = '27/08/2026';

/**
 * Fecha a porta do caminho que ia bater no WooCommerce apagado.
 *
 * @param oQueIaFazer a ação em português, do ponto de vista de quem clicou —
 *   vira a primeira frase da mensagem de erro. Ex.: "Sincronizar o estoque
 *   com o site antigo".
 * @param ondeEstaAVerdadeHoje onde o dado vive agora, pra quem está na tela
 *   saber o próximo passo. Ex.: "o estoque sai do Postgres do Flow".
 */
export function exigirWordpressLegado(
  oQueIaFazer: string,
  ondeEstaAVerdadeHoje: string,
): void {
  if (wordpressLegadoLigado()) return;
  throw new GoneException(
    `${oQueIaFazer}: não existe mais pra onde ir. O WordPress/WooCommerce do site antigo ` +
      `foi apagado em ${WP_LEGADO_APAGADO_EM} e o endereço hoje é o site novo, que responde ` +
      `HTTP 403 em /wp-json — não é chave vencida, é servidor que não existe. ` +
      `Hoje ${ondeEstaAVerdadeHoje}.`,
  );
}
