import Link from 'next/link';
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
 *
 * A barra da conta entra aqui com `?situacao=` — clicar em "A pagar" e cair
 * numa lista com tudo obrigaria a cliente a filtrar de novo na mão.
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

/** As mesmas chaves da barra da conta (common/situacao-pedido.ts no backend). */
const FILTROS = [
  { chave: '', rotulo: 'Todos' },
  { chave: 'aguardando_pagamento', rotulo: 'A pagar' },
  { chave: 'preparando', rotulo: 'Preparando' },
  { chave: 'enviado', rotulo: 'A caminho' },
  { chave: 'entregue', rotulo: 'Entregues' },
];

export default async function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<{ situacao?: string }>;
}) {
  const { situacao: filtro = '' } = await searchParams;
  const dados = await comoCliente<{ orders: Pedido[] }>('/customers/app/orders');

  if (dados === null) {
    return (
      <Section space="lg">
        <h1 className="mb-8 text-center text-h2">Meus pedidos</h1>
        <AcessoConta voltarPara="/conta/pedidos" />
      </Section>
    );
  }

  const todos = dados.orders ?? [];
  const valido = FILTROS.some((f) => f.chave === filtro) ? filtro : '';
  const pedidos = valido ? todos.filter((p) => p.situacao?.chave === valido) : todos;
  const rotuloFiltro = FILTROS.find((f) => f.chave === valido)?.rotulo ?? 'Todos';

  return (
    <Section space="lg">
      <header className="mb-6">
        <p className="eyebrow text-ink-muted">
          <Link href="/conta" className="link-underline">Minha conta</Link>
        </p>
        <h1 className="text-h2">Meus pedidos</h1>
      </header>

      {/* Filtro só aparece se houver pedido — chip vazio em tela vazia é ruído. */}
      {todos.length > 0 && (
        <nav aria-label="Filtrar por situação" className="mb-8 flex flex-wrap gap-2">
          {FILTROS.map((f) => {
            const quantos = f.chave
              ? todos.filter((p) => p.situacao?.chave === f.chave).length
              : todos.length;
            const ativo = f.chave === valido;
            return (
              <Link
                key={f.chave || 'todos'}
                href={f.chave ? `/conta/pedidos?situacao=${f.chave}` : '/conta/pedidos'}
                aria-current={ativo ? 'page' : undefined}
                className={`rounded-pill border px-4 py-2 text-small transition-colors ${
                  ativo
                    ? 'border-ink bg-ink text-light'
                    : 'border-border text-ink-soft hover:border-primary hover:text-ink'
                }`}
              >
                {f.rotulo}
                <span className={ativo ? 'ml-1.5 text-light/70' : 'ml-1.5 text-ink-muted'}>
                  {quantos}
                </span>
              </Link>
            );
          })}
        </nav>
      )}

      {pedidos.length === 0 ? (
        <p className="text-body text-ink-muted">
          {todos.length === 0 ? (
            <>
              Você ainda não tem pedidos por aqui.{' '}
              <Link href="/novidades" className="link-underline text-ink">Ver novidades</Link>
            </>
          ) : (
            <>
              Nenhum pedido em “{rotuloFiltro}”.{' '}
              <Link href="/conta/pedidos" className="link-underline text-ink">Ver todos</Link>
            </>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {pedidos.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-4 py-5">
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">
                  {p.firstItem || 'Pedido'}
                  {p.itemsCount > 1 && (
                    <span className="text-ink-muted"> +{p.itemsCount - 1}</span>
                  )}
                </p>
                <p className="text-small text-ink-muted">
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
                  <p className="text-small text-ink-muted">
                    Rastreio {p.tracking.code}
                    {p.tracking.carrier ? ` · ${p.tracking.carrier}` : ''}
                  </p>
                )}
                {p.pix && (
                  <PixSegundaVia copyPaste={p.pix.copyPaste} expiresAt={p.pix.expiresAt} />
                )}
                <div className="mt-1 flex flex-wrap gap-4">
                  {/* Entregue = peça na mão: é aqui que a avaliação faz
                      sentido, e é daqui que sai a maior parte delas. */}
                  {p.situacao?.chave === 'entregue' && (
                    <Link
                      href="/conta/avaliacoes"
                      className="link-underline inline-block text-small text-ink-soft hover:text-ink"
                    >
                      Avaliar as peças
                    </Link>
                  )}
                  {/* Atalho pra troca (10/08). O portal decide prazo e direito;
                      aqui é só o caminho — e ele existe porque procurar "como
                      trocar" no rodapé é onde a cliente desiste e vai pro
                      WhatsApp. Quem está logada não digita nada lá. */}
                  <Link
                    href="/trocas"
                    className="link-underline inline-block text-small text-ink-soft hover:text-ink"
                  >
                    Precisa trocar?
                  </Link>
                </div>
              </div>
              <p className="text-body tabular-nums">{formatPrice(p.total)}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
