'use client';

import { Sparkles, Truck } from 'lucide-react';
import { freeShippingGap } from '@/lib/commerce/frete';
import { useLojaConfig } from '@/hooks/useLojaConfig';
import { cn, formatPrice } from '@/lib/utils';

/**
 * "Faltam R$ 45 para o frete grátis" — o incentivo mais honesto da sacola.
 *
 * É honesto porque a meta é REAL e porque o número é o que falta de verdade,
 * não um teto inventado pra empurrar peça.
 *
 * ⚠️ A RÉGUA VEM DA CONFIG (item 57, 06/08). Antes ela era a constante do
 * código, e no dia em que o dono mudasse o mínimo na retaguarda esta barra
 * continuaria prometendo o valor velho — **prometendo frete grátis que o
 * checkout não daria**, que é o pior tipo de erro possível aqui.
 *
 * `minimo` chega da cotação (`fetchQuotes().freteGratis.minimo`). Sem ele, cai
 * na constante local — a mesma que serve de paraquedas do frete.
 *
 * `ativo: false` esconde a barra inteira: com o frete grátis desligado, uma
 * barra parada em "faltam R$ 499,90" só ocupa espaço e confunde.
 *
 * DESTAQUE (dono, 26/08: "mais destaque na barra pra estimular vendas
 * maiores"): a barra deixou de ser um card cinza de rodapé — fundo dourado
 * lavado, ícone, o VALOR que falta em Playfair itálico dourado (a ênfase da
 * marca) e trilho 2× mais alto com brilho varrendo o preenchido. A partir de
 * 70% do caminho o texto vira "Quase lá!" — é o trecho em que completar a
 * sacola é decisão de uma peça só. O brilho respeita `prefers-reduced-motion`.
 */

/** De onde em diante a mensagem vira "Quase lá!" (fração do mínimo). */
const QUASE_LA = 0.7;

export function ProgressoFreteGratis({ subtotal, className }: { subtotal: number; className?: string }) {
  const { freteGratis } = useLojaConfig();
  const gap = freeShippingGap(subtotal, freteGratis.minimo);
  if (!freteGratis.ativo || !(freteGratis.minimo > 0)) return null;

  const quaseLa = !gap.reached && gap.progress >= QUASE_LA;

  return (
    <div
      className={cn(
        'rounded-md border bg-gradient-to-br from-primary-wash to-surface-alt/40 px-4 py-4',
        gap.reached ? 'border-primary/40' : 'border-primary/25',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-pill bg-primary/10 text-primary-strong"
        >
          {gap.reached ? (
            <Sparkles className="size-4.5" strokeWidth={1.5} />
          ) : (
            <Truck className="size-4.5" strokeWidth={1.5} />
          )}
        </span>
        {gap.reached ? (
          <div className="min-w-0 flex-1 animate-[widget-enter_560ms_cubic-bezier(0.22,1,0.36,1)_both]">
            <p className="font-display text-h4 italic text-primary-strong">Você ganhou frete grátis</p>
            <p className="text-small font-light text-ink-soft">A entrega desta sacola é por nossa conta.</p>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="text-body text-ink">
              {quaseLa ? 'Quase lá! Faltam só ' : 'Faltam '}
              <span className="font-display text-h4 italic tabular text-primary-strong">
                {formatPrice(gap.missing)}
              </span>{' '}
              para o frete grátis
            </p>
            {/* A RÉGUA POR EXTENSO (dono, 12/08): "faltam R$ 45" não diz de
                quanto é a meta, e quem acabou de abrir a sacola não sabe se
                falta pouco ou se o alvo é inalcançável. Sai da mesma config. */}
            <p className="mt-0.5 text-small font-light text-ink-muted">
              Acima de {formatPrice(freteGratis.minimo)} a entrega sai por nossa conta
            </p>
          </div>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(gap.progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progresso até o frete grátis"
        className="mt-3 h-2 overflow-hidden rounded-pill bg-primary/15"
      >
        <div
          style={{ width: `${gap.progress * 100}%` }}
          className="relative h-full overflow-hidden rounded-pill bg-gradient-to-r from-primary-soft via-primary to-primary-strong"
        >
          {/* Brilho que varre o preenchido — chama o olho pra quanto JÁ andou.
              Some com `prefers-reduced-motion`, e o x é relativo ao próprio
              span (w-1/3): -140% começa fora à esquerda, 340% sai à direita. */}
          <span
              aria-hidden
              className="frete-progress-shine absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/50 to-transparent motion-reduce:hidden"
            />
        </div>
      </div>
    </div>
  );
}
