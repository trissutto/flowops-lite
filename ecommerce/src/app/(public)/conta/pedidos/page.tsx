import Link from 'next/link';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { PixSegundaVia } from '@/components/conta/PixSegundaVia';
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
  /** O mesmo status no vocabulário da cliente — quem traduz é o backend. */
  situacao?: { chave: string; rotulo: string } | null;
  total: number;
  date: string | null;
  tracking: { code: string; carrier: string | null } | null;
  /** Copia-e-cola do Pix ainda válido (item 65). */
  pix?: { copyPaste: string; expiresAt: string } | null;
  itemsCount: number;
  firstItem: string | null;
}

/**
 * Tradução de EMERGÊNCIA — cobre só o vocabulário do WooCommerce e existe pra
 * pedido antigo, gravado antes de o backend passar a mandar `situacao`.
 *
 * Ela era a única tradução, e por isso os estados do FlowOps ("awaiting_payment",
 * "routing", "separating") caíam direto na tela, crus, pra cliente ler.
 */
const STATUS_LEGADO: Record<string, string> = {
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
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-4 py-5">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium">
                    {p.firstItem || 'Pedido'}
                    {p.itemsCount > 1 && (
                      <span className="text-muted"> +{p.itemsCount - 1}</span>
                    )}
                  </p>
                  <p className="text-small text-muted">
                    {p.number ? `Nº ${p.number} · ` : ''}
                    {p.date ? new Date(p.date).toLocaleDateString('pt-BR') : ''}
                    {/* `situacao` primeiro: é a tradução completa. O mapa
                        legado só cobre pedido antigo do WooCommerce. */}
                    {p.situacao?.rotulo
                      ? ` · ${p.situacao.rotulo}`
                      : p.status
                        ? ` · ${STATUS_LEGADO[p.status] ?? p.status}`
                        : ''}
                  </p>
                  {p.tracking && (
                    <p className="text-small text-muted">
                      Rastreio {p.tracking.code}
                      {p.tracking.carrier ? ` · ${p.tracking.carrier}` : ''}
                    </p>
                  )}
                  {p.pix && (
                    <PixSegundaVia copyPaste={p.pix.copyPaste} expiresAt={p.pix.expiresAt} />
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
