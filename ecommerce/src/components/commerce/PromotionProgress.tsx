import { Gift } from 'lucide-react';
import { formatPrice } from '@/lib/utils';
import type { BuyFourPayThreePreview } from '@/types/promotion';

export function PromotionProgress({ preview }: { preview: BuyFourPayThreePreview }) {
  const progress = Math.min(100, (preview.distinctProducts / 4) * 100);
  return (
    <section className="rounded-md border border-primary/30 bg-primary/5 p-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <Gift className="mt-0.5 size-5 shrink-0 text-primary-strong" strokeWidth={1.6} />
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium text-ink">Leve 4, Pague 3</p>
          <p className="mt-0.5 text-small font-light text-ink-soft">
            {preview.applied
              ? `A peça de ${formatPrice(preview.discountValue)} será grátis.`
              : `Adicione mais ${preview.productsToGo} ${preview.productsToGo === 1 ? 'produto diferente' : 'produtos diferentes'} para ganhar a peça de menor valor.`}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-pill bg-border" aria-hidden="true">
            <div className="h-full rounded-pill bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1.5 text-[0.6875rem] text-ink-muted">{preview.distinctProducts}/4 produtos diferentes</p>
        </div>
      </div>
    </section>
  );
}
