import Link from 'next/link';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { CentroDeAvaliacao, type DadosCentro } from '@/components/conta/CentroDeAvaliacao';
import { comoCliente } from '@/lib/conta';
import { buildMetadata } from '@/lib/seo';

/**
 * CENTRO DE AVALIAÇÃO — a peça que a cliente levou, contada por ela.
 *
 * A prova social do site é REAL: só avalia quem tem a peça num pedido
 * entregue, e é o backend que confere isso item a item. Depoimento inventado
 * já esteve no ar e saiu em 06/08 — a cliente que percebe uma avaliação
 * repetida passa a duvidar do preço e do estoque também.
 *
 * Quem avalia ganha PONTOS, e quanto vale cada coisa é decisão da matriz na
 * tela /retaguarda/avaliacoes — nada de número chumbado aqui.
 */

export const metadata = buildMetadata({
  title: 'Avaliar peças',
  path: '/conta/avaliacoes',
  noIndex: true,
});

export const dynamic = 'force-dynamic';

export default async function AvaliacoesPage() {
  const dados = await comoCliente<DadosCentro>('/customers/app/avaliacoes');

  if (dados === null) {
    return (
      <Section space="lg">
        <h1 className="mb-8 text-center text-h2">Avaliar peças</h1>
        <AcessoConta voltarPara="/conta/avaliacoes" />
      </Section>
    );
  }

  return (
    <Section space="lg" width="text">
      <header className="mb-8">
        <p className="eyebrow text-ink-muted">
          <Link href="/conta" className="link-underline">Minha conta</Link>
        </p>
        <h1 className="text-h2">Avaliar peças</h1>
        <p className="mt-2 text-body text-ink-soft">
          Conte como a peça serviu. Sua avaliação aparece na página do produto e ajuda quem
          está na dúvida do tamanho.
        </p>
      </header>

      <CentroDeAvaliacao dados={dados} />
    </Section>
  );
}
