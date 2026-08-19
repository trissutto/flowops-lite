import Link from 'next/link';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { comoCliente } from '@/lib/conta';
import { formatPrice } from '@/lib/utils';
import { buildMetadata } from '@/lib/seo';

/**
 * MEU CASHBACK — saldo e extrato (item 68).
 *
 * O saldo já existia no CRM e já era creditado a cada compra; o que não
 * existia era a tela. Cashback que a cliente não vê não muda comportamento
 * nenhum — é custo sem retorno.
 *
 * O EXTRATO importa tanto quanto o saldo: sem ele, "R$ 23,40" é um número que
 * a cliente não sabe de onde veio, e número que ela não entende ela não gasta.
 *
 * A EXPIRAÇÃO vem primeiro e destacada. É o único dado com prazo, e descobrir
 * que venceu depois é a maneira mais rápida de transformar um benefício em
 * reclamação.
 */

export const metadata = buildMetadata({
  title: 'Meu cashback',
  path: '/conta/cashback',
  noIndex: true,
});

export const dynamic = 'force-dynamic';

interface Movimento {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  date: string | null;
  expiresAt: string | null;
}

interface Extrato {
  balance: number;
  earned: number;
  spent: number;
  rate: number;
  ttlDays: number;
  nextExpiration: { amount: number; expiresAt: string; daysLeft: number } | null;
  transactions: Movimento[];
}

/** Vocabulário do banco → o que a cliente entende. */
const TIPO: Record<string, string> = {
  earn: 'Ganho na compra',
  welcome: 'Bônus de boas-vindas',
  spend: 'Usado na compra',
  expire: 'Expirou',
  adjust: 'Ajuste',
  refund: 'Devolvido',
};

export default async function CashbackPage() {
  const extrato = await comoCliente<Extrato>('/customers/app/cashback');

  if (extrato === null) {
    return (
      <Section space="lg">
        <Container>
          <h1 className="mb-8 text-center text-h2">Meu cashback</h1>
          <AcessoConta voltarPara="/conta/cashback" />
        </Container>
      </Section>
    );
  }

  const movimentos = extrato.transactions ?? [];

  return (
    <Section space="lg">
      <Container>
        <header className="mb-8">
          <p className="eyebrow text-ink-muted">
            <Link href="/conta" className="link-underline">Minha conta</Link>
          </p>
          <h1 className="text-h2">Meu cashback</h1>
        </header>

        {/* Saldo — o único número grande da página, em verde (a convenção da
            casa reserva verde pra dinheiro). */}
        <div className="rounded-sm border border-border p-6">
          <p className="eyebrow text-ink-muted">Disponível pra usar</p>
          <p className="mt-1 text-h2 tabular-nums text-success">{formatPrice(extrato.balance)}</p>

          {extrato.nextExpiration && (
            <p className="mt-3 text-small text-ink">
              {formatPrice(extrato.nextExpiration.amount)} expira em{' '}
              <span className="font-medium">
                {extrato.nextExpiration.daysLeft} dia
                {extrato.nextExpiration.daysLeft === 1 ? '' : 's'}
              </span>
              .
            </p>
          )}

          <p className="mt-3 text-small text-ink-muted">
            Você recebe {extrato.rate}% de volta em cada compra. O crédito vale por{' '}
            {extrato.ttlDays} dias.
          </p>
        </div>

        <h2 className="mt-10 mb-3 text-h4">Extrato</h2>

        {movimentos.length === 0 ? (
          <p className="text-body text-ink-muted">
            Ainda não há movimento por aqui.{' '}
            <Link href="/novidades" className="link-underline text-ink">Ver novidades</Link>
          </p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {movimentos.map((m) => {
              // `spend` e `expire` chegam com o sinal do banco; o que importa
              // pra leitura é entrar ou sair, então o sinal vem do TIPO.
              const saiu = m.type === 'spend' || m.type === 'expire';
              return (
                <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-3 py-4">
                  <div className="min-w-0">
                    <p className="text-body">{m.description || TIPO[m.type] || 'Movimento'}</p>
                    <p className="text-small text-ink-muted">
                      {m.date ? new Date(m.date).toLocaleDateString('pt-BR') : ''}
                      {m.description && TIPO[m.type] ? ` · ${TIPO[m.type]}` : ''}
                    </p>
                  </div>
                  <p className={`text-body tabular-nums ${saiu ? 'text-ink-muted' : 'text-success'}`}>
                    {saiu ? '−' : '+'}
                    {formatPrice(Math.abs(m.amount))}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Container>
    </Section>
  );
}
