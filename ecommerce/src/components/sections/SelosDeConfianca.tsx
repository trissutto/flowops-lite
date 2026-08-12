'use client';

import { CreditCard, Lock, MapPin, RefreshCw, ShieldCheck } from 'lucide-react';
import { useLojaConfig } from '@/hooks/useLojaConfig';
import { SeloReclameAqui } from '@/components/sections/SeloReclameAqui';
import { STORE_POLICIES } from '@/data/store-policies';
import { formatPrice } from '@/lib/utils';

/**
 * SELOS DE CONFIANÇA — o que responde "posso comprar aqui?" (dono, 12/08/2026).
 *
 * A cliente que nunca comprou no site chega com três medos: o cartão, a peça
 * que não vem e a peça que não serve. Estes selos respondem os três com o que
 * a loja TEM de verdade.
 *
 * ── SOBRE SELO DE TERCEIRO ──
 *
 * "Site Seguro" e "Reclame Aqui" com logo de terceiro NÃO entram por conta
 * própria: são marcas de outras empresas, e estampá-las sem o selo emitido por
 * elas é dizer que alguém auditou a loja quando ninguém auditou. O Reclame
 * Aqui, quando a loja tiver conta, entrega um script/URL oficial com a nota
 * REAL — aí é só plugar (e a nota passa a ser argumento de verdade, não
 * enfeite).
 *
 * O que está aqui é tudo verificável hoje: HTTPS de ponta a ponta, pagamento
 * processado por PagBank/Pagar.me (a loja não guarda número de cartão), 14
 * lojas físicas com endereço e CNPJ no rodapé, e a régua de troca e frete que
 * o próprio sistema aplica.
 *
 * O CNPJ e o endereço no rodapé valem mais que qualquer selo: é o que separa
 * loja de perfil que some. Ver [[prova-social-e-ficha-por-ia]].
 */

export function SelosDeConfianca({ className = '' }: { className?: string }) {
  const { freteGratis } = useLojaConfig();

  const selos = [
    {
      icone: Lock,
      titulo: 'Compra 100% segura',
      texto: 'Conexão criptografada e pagamento processado por PagBank e Pagar.me — a loja não guarda o número do seu cartão.',
    },
    {
      icone: CreditCard,
      titulo: 'Até 12x sem juros',
      texto: 'No cartão, sem acréscimo. No Pix, 5% de desconto à vista.',
    },
    {
      icone: RefreshCw,
      titulo: `Troca em ${STORE_POLICIES.exchangeWindowDays} dias`,
      texto: 'Não serviu, troca. Pelo portal ou em qualquer uma das lojas, sem burocracia.',
    },
    {
      icone: MapPin,
      titulo: `${STORE_POLICIES.storeCount} lojas físicas`,
      texto: 'Somos loja de rua desde antes do site. Dá pra provar e retirar perto de você.',
    },
  ];

  return (
    <section aria-label="Por que comprar na Lurd's" className={className}>
      <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        {selos.map((selo) => (
          <li key={selo.titulo} className="flex gap-3">
            <selo.icone
              className="mt-0.5 size-5 shrink-0 text-primary-strong"
              strokeWidth={1.5}
              aria-hidden
            />
            <div>
              <p className="text-small font-medium text-ink">{selo.titulo}</p>
              <p className="mt-1 text-small font-light text-ink-soft">{selo.texto}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center sm:gap-8">
        {freteGratis.ativo && freteGratis.minimo > 0 && (
          <p className="flex items-center gap-2 text-small text-ink-soft">
            <ShieldCheck className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
            Frete grátis acima de {formatPrice(freteGratis.minimo)} — a régua vale pro Brasil todo.
          </p>
        )}
        {/* Reputação na FONTE: link pro perfil público, com a nota do dia. Ver
            o cabeçalho do componente sobre por que não vai logo nem nota
            escrita à mão. */}
        <SeloReclameAqui />
      </div>
    </section>
  );
}
