import Link from 'next/link';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { comoCliente } from '@/lib/conta';
import { formatPrice } from '@/lib/utils';
import { buildMetadata } from '@/lib/seo';

/**
 * MEUS PEDIDOS — site, loja e live no mesmo lugar.
 *
 * O backend cruza por CPF, então aparece tudo que é daquela pessoa,
 * independente de onde ela comprou. É o argumento do login: quem compra na
 * loja física também tem o que ver aqui.
 */

export const metadata = buildMetadata({
  title: 'Meus pedidos',
  path: '/conta/pedidos',
  noIndex: true,
});

export const dynamic = 'force-dynamic';

interface Pedido {
  id: string;
  number: string | null;
  status: string | null;
  total: number;
  date: string | null;
  tracking: { code: string; carrier: string | null } | null;
  itemsCount: number;
  firstItem: string | null;
}

const STATUS: Record<string, string> = {
  pending: 'Aguardando pagamento',
  processing: 'Pagamento confirmado',
  'on-hold': 'Em análise',
  completed: 'Entregue',
  cancelled: 'Cancelado',
  refunded: 'Estornado',
  failed: 'Não concluído',
};

export default async function PedidosPage() {
  const dados = await comoCliente<{ orders: Pedido[] }>('/customers/app/orders');

  if (dados === null) {
    return (
      <Section space="lg">
        <Container>
          <h1 className="mb-8 text-center text-h2">Meus pedidos</h1>
          <AcessoConta voltarPara="/conta/pedidos" />
        </Container>
      </Section>
    );
  }

  const pedidos = dados.orders ?? [];

  return (
    <Section space="lg">
      <Container>
        <header className="mb-8">
          <p className="eyebrow text-muted">
            <Link href="/conta" className="link-underline">Minha conta</Link>
          </p>
          <h1 className="text-h2">Meus pedidos</h1>
        </header>

        {pedidos.length === 0 ? (
          <p className="text-body text-muted">
            Você ainda não tem pedidos por aqui.{' '}
            <Link href="/novidades" className="link-underline text-ink">Ver novidades</Link>
          </p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {pedidos.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
                <div className="min-w-0">
                  <p className="text-body font-medium">
                    {p.firstItem || 'Pedido'}
                    {p.itemsCount > 1 && (
                      <span className="text-muted"> +{p.itemsCount - 1}</span>
                    )}
                  </p>
                  <p className="text-small text-muted">
                    {p.number ? `Nº ${p.number} · ` : ''}
                    {p.date ? new Date(p.date).toLocaleDateString('pt-BR') : ''}
                    {p.status ? ` · ${STATUS[p.status] ?? p.status}` : ''}
                  </p>
                  {p.tracking && (
                    <p className="text-small text-muted">
                      Rastreio {p.tracking.code}
                      {p.tracking.carrier ? ` · ${p.tracking.carrier}` : ''}
                    </p>
                  )}
                </div>
                <p className="text-body tabular-nums">{formatPrice(p.total)}</p>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </Section>
  );
}
