'use client';

import { Accordion, AccordionItem } from '@/components/ui/Accordion';
import { Checkbox, ColorSwatch, SizePill, Switch } from '@/components/ui/Choice';
import { formatPrice } from '@/lib/utils';
import type { FilterGroup } from '@/types';
import type { UseProductFiltersResult } from '@/hooks/useProductFilters';

/**
 * FilterPanel — o conteúdo dos filtros, sem casca.
 *
 * O MESMO componente serve a sidebar do desktop e o drawer do mobile: quem
 * decide o container é a página. Isso garante que os dois nunca divirjam.
 *
 * Cada tipo de grupo tem um controle próprio (tamanho = pílula, cor = swatch,
 * preço = faixa, destaque = switch) — checkbox pra tudo empobrece a leitura.
 */
export function FilterPanel({
  groups,
  state,
}: {
  groups: FilterGroup[];
  state: UseProductFiltersResult;
}) {
  return (
    <Accordion>
      {groups.map((group) => {
        const activeInGroup = state.activeChips.filter((c) => c.groupId === group.id).length;

        return (
          <AccordionItem
            key={group.id}
            title={group.label}
            defaultOpen={group.defaultOpen}
            meta={
              activeInGroup > 0 ? (
                <span className="tabular flex size-5 items-center justify-center rounded-pill bg-primary text-[0.625rem] font-semibold text-light">
                  {activeInGroup}
                </span>
              ) : undefined
            }
          >
            {group.type === 'size' && (
              <div className="flex flex-wrap gap-2">
                {group.options?.map((option) => (
                  <SizePill
                    key={option.value}
                    label={option.label}
                    selected={state.isChecked(group.id, option.value)}
                    onSelect={() => state.toggleValue(group.id, option.value)}
                  />
                ))}
              </div>
            )}

            {group.type === 'swatch' && (
              <div className="flex flex-wrap gap-2.5">
                {group.options?.map((option) => (
                  <ColorSwatch
                    key={option.value}
                    hex={option.hex ?? '#ccc'}
                    name={option.label}
                    selected={state.isChecked(group.id, option.value)}
                    onSelect={() => state.toggleValue(group.id, option.value)}
                  />
                ))}
              </div>
            )}

            {group.type === 'checkbox' && (
              <div className="flex flex-col gap-3">
                {group.options?.map((option) => (
                  <Checkbox
                    key={option.value}
                    label={option.label}
                    count={option.count}
                    checked={state.isChecked(group.id, option.value)}
                    onChange={() => state.toggleValue(group.id, option.value)}
                  />
                ))}
              </div>
            )}

            {group.type === 'toggle' && (
              <div className="flex flex-col gap-3.5">
                {group.options?.map((option) => (
                  <Switch
                    key={option.value}
                    label={option.label}
                    checked={state.isFlagOn(option.value)}
                    onChange={() => state.toggleFlag(option.value)}
                  />
                ))}
              </div>
            )}

            {group.type === 'range' && group.range && (
              <PriceRange
                min={group.range.min}
                max={group.range.max}
                value={state.getRange(group.id) ?? [group.range.min, group.range.max]}
                onChange={(range) => state.setRange(group.id, range)}
              />
            )}
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

/**
 * Faixa de preço — dois sliders nativos sobrepostos.
 * Nativo de propósito: acessível por teclado de fábrica e zero JS de arraste.
 */
function PriceRange({
  min,
  max,
  value,
  onChange,
}: {
  min: number;
  max: number;
  value: [number, number];
  onChange: (range: [number, number]) => void;
}) {
  const [from, to] = value;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-small text-ink-soft">
        <span className="tabular">{formatPrice(from)}</span>
        <span className="tabular">{formatPrice(to)}</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-ink-soft">
          Mínimo
          <input
            type="number"
            min={min}
            max={to - 10}
            step={10}
            value={from}
            onChange={(e) => onChange([Math.min(Number(e.target.value), to - 10), to])}
            className="mt-1 min-h-11 w-full rounded-sm border border-border bg-surface px-3 text-small text-ink"
          />
        </label>
        <label className="text-xs text-ink-soft">
          Máximo
          <input
            type="number"
            min={from + 10}
            max={max}
            step={10}
            value={to}
            onChange={(e) => onChange([from, Math.max(Number(e.target.value), from + 10)])}
            className="mt-1 min-h-11 w-full rounded-sm border border-border bg-surface px-3 text-small text-ink"
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-3">
          <span className="eyebrow w-8 text-ink-muted">Mín</span>
          <input
            type="range"
            min={min}
            max={max}
            step={10}
            value={from}
            onChange={(e) => onChange([Math.min(Number(e.target.value), to - 10), to])}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-pill bg-border accent-[var(--color-primary)]"
            aria-label="Preço mínimo"
          />
        </label>
        <label className="flex items-center gap-3">
          <span className="eyebrow w-8 text-ink-muted">Máx</span>
          <input
            type="range"
            min={min}
            max={max}
            step={10}
            value={to}
            onChange={(e) => onChange([from, Math.max(Number(e.target.value), from + 10)])}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-pill bg-border accent-[var(--color-primary)]"
            aria-label="Preço máximo"
          />
        </label>
      </div>
    </div>
  );
}
