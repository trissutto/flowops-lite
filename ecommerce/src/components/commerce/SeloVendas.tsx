import { ShoppingBag } from 'lucide-react';

/**
 * PROVA SOCIAL REAL — quantas peças desta já saíram (dono, 12/08/2026).
 *
 * O pedido original era "avaliação fake por enquanto". Isso já esteve no ar e
 * foi removido em 06/08: eram depoimentos assinados "Cliente Lurds" com altura
 * e peso inventados, e as MESMAS quatro frases em toda peça — a cliente que
 * percebe passa a duvidar do preço e do estoque também.
 *
 * Este número é verdade conferível no caixa: soma loja física, site e o
 * histórico do ERP antigo (02/01/2025 em diante), por família — as cores da
 * peça são REFs irmãs e a cliente lê "esta peça", não "esta cor".
 *
 * ── O PISO ──
 *
 * Medido nas 727 peças publicadas: mediana 80, 83% passam de 20 e 62% passam
 * de 50. Abaixo de {@link PISO} o selo não aparece: "3 já levaram" trabalha
 * CONTRA a peça, e uma vitrine onde metade dos cards mostra número fraco ensina
 * a cliente a ignorar o selo justamente na peça campeã.
 *
 * O piso mora AQUI porque card e página usam o mesmo componente — número que
 * aparece num lugar e some no outro vira suspeita de erro.
 */

/** Abaixo disso o silêncio vende mais que o número. */
const PISO = 20;

export function SeloVendas({
  vendas,
  className = '',
  variant = 'bloco',
}: {
  vendas?: number | null;
  className?: string;
  /**
   * `linha` (dono, 14/08): na coluna de compra da PDP a caixa empurrava o
   * botão de comprar pra longe do seletor de tamanho — no meio de Fit AI,
   * pills e garantias, era mais uma caixa disputando atenção. Vira uma linha
   * de texto colada no botão: mantém o argumento, devolve o espaço. O card
   * da vitrine continua com o bloco.
   */
  variant?: 'bloco' | 'linha';
}) {
  const n = Number(vendas) || 0;
  if (n < PISO) return null;

  /**
   * Arredonda pra baixo na casa cheia a partir de 100 ("mais de 300"). Número
   * redondo lê como estimativa honesta; "317 clientes" parece precisão de
   * laboratório e convida a cliente a duvidar da conta.
   */
  const quantidade = n >= 100 ? `Mais de ${Math.floor(n / 100) * 100}` : String(n);

  /**
   * ── DESTAQUE (dono, 13/08/2026) ──
   *
   * Nasceu como uma linha cinza no meio dos selos de garantia, e sumia: era o
   * argumento mais forte da página tratado como rodapé. Agora é um bloco com
   * fundo próprio, colado no botão de comprar, com o NÚMERO em corpo maior —
   * é ele que carrega a informação, não a frase.
   *
   * Continua sóbrio de propósito: fundo suave da marca em vez de vermelho de
   * urgência. O número é verdadeiro e não precisa gritar; card de e-commerce
   * que grita é o que a cliente aprendeu a ignorar.
   */
  if (variant === 'linha') {
    return (
      <p className={`flex items-center gap-2 text-small text-ink-soft ${className}`}>
        <ShoppingBag className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} aria-hidden />
        <span>
          <strong className="font-medium text-ink">{quantidade} clientes</strong> já compraram
          esta peça
        </span>
      </p>
    );
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-sm border border-primary/25 bg-primary-soft/25 px-4 py-3 ${className}`}
    >
      <ShoppingBag className="size-5 shrink-0 text-primary-strong" strokeWidth={1.75} aria-hidden />
      <p className="text-body font-light text-ink">
        <strong className="font-medium">{quantidade} clientes</strong> já compraram esta peça
      </p>
    </div>
  );
}
