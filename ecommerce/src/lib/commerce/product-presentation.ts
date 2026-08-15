import type { ProductBadge } from '@/types';

export function nomeComReferencia(nome: string, referencia?: string | null): string {
  const titulo = nome.trim().replace(/\s+/g, ' ');
  const ref = String(referencia ?? '').trim();
  if (!ref || titulo.toLocaleLowerCase('pt-BR').includes(ref.toLocaleLowerCase('pt-BR'))) return titulo;
  return `${titulo} — ${ref}`;
}

export function ofertaProduto(
  preco: number,
  precoAnterior: number | null | undefined,
  selecaoComercial = false,
): { compareAtPrice?: number; badge?: ProductBadge } {
  const anterior = Number(precoAnterior);
  const descontoValido = Number.isFinite(anterior) && anterior > 0 && anterior > preco;
  if (descontoValido) return { compareAtPrice: anterior, badge: 'promocao' };
  if (selecaoComercial) return { badge: 'preco-especial' };
  return {};
}
