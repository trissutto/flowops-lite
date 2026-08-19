import Link from 'next/link';
import { CreditCard, PackageOpen, Truck, Star, RefreshCw } from 'lucide-react';

/**
 * A BARRA DE "MEUS PEDIDOS" — o que está esperando por você, em cinco números.
 *
 * A conta abria como MENU: seis cards do mesmo tamanho, nenhum dizendo se
 * havia algo parado. Quem entrava pra ver "cadê meu pedido" tinha que
 * adivinhar por qual card começar.
 *
 * Aqui o primeiro que se vê é o que está PENDENTE — pagamento não feito, peça
 * a caminho, avaliação esperando — e cada bloco é um caminho de um clique. É a
 * mesma diretriz da fila da loja (`/minha-loja`): tarefa clicável antes de
 * menu.
 *
 * ⚠️ **Número só aparece se for pendência real.** Bolinha que pisca sem motivo
 * ensina a cliente a ignorar a barra inteira — inclusive no dia em que ela
 * importa. Zero é silêncio: o bloco continua clicável, sem selo nenhum.
 */

export interface BlocoDaConta {
  chave: 'a_pagar' | 'preparando' | 'a_caminho' | 'avaliar' | 'trocas';
  rotulo: string;
  quantidade: number;
}

const ICONES = {
  a_pagar: CreditCard,
  preparando: PackageOpen,
  a_caminho: Truck,
  avaliar: Star,
  trocas: RefreshCw,
} as const;

/** Cada bloco leva pra lista JÁ FILTRADA — clicar e ter que filtrar de novo é meio caminho. */
const DESTINOS: Record<BlocoDaConta['chave'], string> = {
  a_pagar: '/conta/pedidos?situacao=aguardando_pagamento',
  preparando: '/conta/pedidos?situacao=preparando',
  a_caminho: '/conta/pedidos?situacao=enviado',
  avaliar: '/conta/avaliacoes',
  trocas: '/trocas',
};

export function BarraTarefas({ blocos }: { blocos: BlocoDaConta[] }) {
  if (!blocos?.length) return null;

  return (
    <section
      aria-labelledby="barra-pedidos-titulo"
      className="rounded-md border border-border bg-surface px-4 py-5 shadow-xs sm:px-6"
    >
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <h2 id="barra-pedidos-titulo" className="text-h4 font-medium">
          Meus pedidos
        </h2>
        <Link
          href="/conta/pedidos"
          className="link-underline text-small text-ink-muted hover:text-ink"
        >
          Ver tudo
        </Link>
      </header>

      <ul className="grid grid-cols-5 gap-1 sm:gap-3">
        {blocos.map((b) => {
          const Icone = ICONES[b.chave] ?? PackageOpen;
          const tem = b.quantidade > 0;
          return (
            <li key={b.chave}>
              <Link
                href={DESTINOS[b.chave]}
                className="group flex flex-col items-center gap-2 rounded-sm px-1 py-2 text-center transition-colors hover:bg-primary-wash"
              >
                <span className="relative inline-flex">
                  <Icone
                    className={
                      tem
                        ? 'size-6 text-primary-strong sm:size-7'
                        : 'size-6 text-ink-soft sm:size-7'
                    }
                    strokeWidth={1.25}
                  />
                  {tem && (
                    <span
                      // Selo em cima do ícone, como no app: a cliente lê o
                      // número antes de ler a palavra.
                      className="absolute -right-2.5 -top-1.5 min-w-[1.125rem] rounded-pill bg-secondary px-1 text-center text-[0.625rem] font-medium leading-[1.125rem] text-light"
                    >
                      {b.quantidade > 99 ? '99+' : b.quantidade}
                    </span>
                  )}
                </span>
                <span
                  className={`text-[0.6875rem] leading-tight sm:text-small ${
                    tem ? 'text-ink' : 'text-ink-muted'
                  }`}
                >
                  {b.rotulo}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
