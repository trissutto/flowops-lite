import Link from 'next/link';
import { RefreshCw, Truck, CalendarDays } from 'lucide-react';
import { Container } from '@/components/layout/Container';
import { RETURN_EXCHANGE_SUMMARY } from '@/data/store-policies';

/**
 * TROCA FÁCIL — a faixa que responde "e se não servir?".
 *
 * Pedido do dono em 10/08/2026 ("um banner em algum local pro troca fácil"),
 * junto com o item no topo.
 *
 * ── POR QUE ISTO VENDE, E NÃO É SÓ RECADO DE SAC ──
 *
 * Em plus size a dúvida de tamanho é a objeção que mais segura a PRIMEIRA
 * compra: a cliente já comprou errado antes, já ficou com a peça encalhada, e
 * decide não arriscar de novo. Quem lê "a troca é fácil" ANTES de escolher
 * compra; quem só descobre depois de um problema já desistiu na dúvida.
 *
 * Por isso fica no caminho de quem está navegando, e não escondido no rodapé —
 * ao rodapé só chega quem já tem problema.
 *
 * ── OS NÚMEROS SÃO OS DE VERDADE ──
 *
 * 7 dias corridos contados da ENTREGA e 1 logística reversa grátis por CPF
 * vêm de `trocas.service.ts` (`DEFAULT_PRAZO_DIAS`, `getBeneficioReversa`).
 * Promessa de vitrine que a regra não cumpre é pior que não prometer nada: a
 * cliente cobra o que leu, e quem atende é quem paga a conta.
 *
 * ⚠️ O prazo é configurável (`troca.prazoDias` nas configs). Se mudar lá, este
 * texto precisa mudar junto — é o preço de escrever o número no HTML em vez de
 * buscar do backend, escolhido pra faixa não depender de requisição.
 */

const ITENS = [
  { icone: CalendarDays, titulo: '7 dias para devolver', texto: 'Arrependimento com reembolso.' },
  { icone: Truck, titulo: 'Primeira devolução grátis', texto: 'A gente paga o frete de volta.' },
  { icone: RefreshCw, titulo: 'Sem digitar nada', texto: 'Logada, é só escolher a peça.' },
];

export function FaixaTrocaFacil() {
  return (
    <section aria-labelledby="troca-facil-titulo" className="bg-surface-alt py-section-sm">
      <Container width="wide">
        <div className="flex flex-col items-center gap-10 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-md text-center lg:text-left">
            <p className="text-small uppercase tracking-[0.2em] text-primary">Troca fácil</p>
            <h2 id="troca-facil-titulo" className="mt-3 font-display text-h3 text-ink">
              Não serviu? A gente resolve.
            </h2>
            <p className="mt-3 text-body text-ink-soft">
              Comprar plus size online não precisa ser aposta. Se a peça não servir, a troca é
              simples — e a primeira devolução é por nossa conta. {RETURN_EXCHANGE_SUMMARY}
            </p>
            <Link
              href="/trocas"
              className="mt-6 inline-flex h-12 items-center rounded-pill bg-primary px-8 text-small font-medium text-light transition-opacity hover:opacity-90"
            >
              Trocar ou devolver
            </Link>
          </div>

          <ul className="grid w-full max-w-xl gap-6 sm:grid-cols-3">
            {ITENS.map(({ icone: Icone, titulo, texto }) => (
              <li key={titulo} className="flex flex-col items-center gap-3 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 text-primary">
                  <Icone className="h-5 w-5" aria-hidden />
                </span>
                <span className="text-small font-medium text-ink">{titulo}</span>
                <span className="text-small text-ink-soft">{texto}</span>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
