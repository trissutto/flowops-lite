import { Section } from '@/components/layout/Section';
import { AppLink } from '@/components/ui/AppLink';
import { CentroDeAvaliacao, type DadosCentro } from '@/components/conta/CentroDeAvaliacao';
import { api } from '@/lib/api';
import { buildMetadata } from '@/lib/seo';

/**
 * A PÁGINA QUE O LINK DO WHATSAPP ABRE — avaliar sem login.
 *
 * O centro de avaliação em `/conta/avaliacoes` já existia, mas é PASSIVO:
 * descobre a fila quem entra na conta. A maioria compra como visitante e não
 * volta ao site depois de receber a peça. Cinco dias depois da entrega o
 * convite chega no WhatsApp com este link, e ele cai NO MESMO formulário — o
 * que muda é só quem prova a identidade dela (o token, não a senha).
 *
 * `noIndex` e `force-dynamic` de propósito: é uma página POR PEDIDO, com o
 * token na URL. Nada disso pode entrar em índice de busca nem em cache
 * compartilhado — seria o pedido de uma cliente aparecendo pra outra.
 */

export const dynamic = 'force-dynamic';

export const metadata = buildMetadata({
  title: 'Avaliar minhas peças',
  path: '/avaliar',
  noIndex: true,
});

interface Convite extends DadosCentro {
  token: string;
  pedido: string | null;
  cliente: string | null;
  entregueEm: string | null;
}

export default async function AvaliarPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Link quebrado, vencido ou pedido sem CPF: o backend responde 4xx com uma
  // frase pronta. Nada disso é erro de servidor — vira tela, não 500.
  let convite: Convite | null = null;
  let recado: string | null = null;
  try {
    convite = await api<Convite>(`/public/avaliar/${encodeURIComponent(token)}`, { revalidate: 0 });
  } catch (e) {
    recado =
      (e as { mensagemDoBackend?: string })?.mensagemDoBackend ??
      'Ou o link já expirou, ou o endereço veio quebrado no meio da mensagem.';
  }

  if (!convite) {
    return (
      <Section space="lg" width="text">
        <div className="rounded-sm border border-border bg-surface p-8 text-center">
          <h1 className="text-h2">Esse link não vale mais</h1>
          <p className="mt-3 text-body text-ink-soft">{recado}</p>
          <p className="mt-2 text-small text-ink-muted">
            Se quiser avaliar mesmo assim, responde nosso WhatsApp que a gente manda outro.
          </p>
          <AppLink
            href="/"
            className="mt-6 inline-flex items-center justify-center rounded-full bg-ink px-8 py-3.5 text-button uppercase tracking-widest text-light transition hover:bg-primary-strong"
          >
            Ir pra loja
          </AppLink>
        </div>
      </Section>
    );
  }

  return (
    <Section space="lg" width="text">
      <header className="mb-8">
        <p className="eyebrow text-ink-muted">Pedido {convite.pedido ?? ''}</p>
        <h1 className="text-h2">
          {convite.cliente ? `${convite.cliente}, como ficou?` : 'Como ficou?'}
        </h1>
        <p className="mt-2 text-body text-ink-soft">
          Conte como a peça serviu. Sua avaliação aparece na página do produto e ajuda quem está
          na dúvida do tamanho — a pergunta que mais trava a compra no plus size.
        </p>
      </header>

      {/* MESMO componente da conta logada. O que muda é o endereço que prova
          quem ela é: aqui, o token do convite. */}
      <CentroDeAvaliacao dados={convite} endpointBase={`/api/avaliar/${convite.token}`} />
    </Section>
  );
}
