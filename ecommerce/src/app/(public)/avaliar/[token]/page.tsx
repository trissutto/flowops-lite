import { Section } from '@/components/layout/Section';
import { AppLink } from '@/components/ui/AppLink';
import { FormAvaliacao } from '@/components/avaliacao/FormAvaliacao';
import { buscarConvite } from '@/lib/avaliacoes';
import { buildMetadata } from '@/lib/seo';

/**
 * A PÁGINA QUE O LINK DO WHATSAPP ABRE.
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

export default async function AvaliarPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const convite = await buscarConvite(token);

  if (!convite) {
    return (
      <Section space="lg" width="text">
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <h1 className="text-2xl font-light text-ink">Esse link não vale mais</h1>
          <p className="mt-3 text-body font-light text-ink-soft">
            Ou ele já expirou, ou o endereço veio quebrado no meio da mensagem. Se você quiser
            avaliar mesmo assim, é só responder o WhatsApp que a gente manda outro.
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

  const todasAvaliadas = convite.pecas.length > 0 && convite.pecas.every((p) => !!p.avaliada);
  const { pontosPorAvaliacao, pontosComFoto, pontosPorReal, minimoResgate } = convite.regras;

  return (
    <Section space="lg" width="text">
      <header className="mb-6">
        <p className="text-eyebrow uppercase tracking-[0.2em] text-primary-strong">
          Pedido {convite.pedido ?? ''}
        </p>
        <h1 className="mt-2 text-3xl font-light leading-tight text-ink sm:text-4xl">
          {convite.cliente ? `${convite.cliente}, como ficou?` : 'Como ficou?'}
        </h1>
        <p className="mt-3 text-body font-light text-ink-soft">
          Sua resposta aparece na página da peça e ajuda outra cliente a acertar o tamanho — a
          dúvida que mais trava a compra no plus size. Leva menos de um minuto.
        </p>

        {/* A regra do jogo, dita antes de ela começar */}
        <div className="mt-5 rounded-xl border border-primary/30 bg-primary-wash p-4">
          <p className="text-sm text-ink">
            <strong>{pontosPorAvaliacao} pontos</strong> por peça avaliada e{' '}
            <strong>{pontosComFoto} pontos</strong> quando você manda uma foto usando —{' '}
            <strong>o dobro, em qualquer nota</strong>. A foto é o que mais ajuda quem está
            decidindo.
          </p>
          <p className="mt-2 text-xs text-ink-soft">
            {pontosPorReal} pontos = R$ 1,00 de desconto · resgate a partir de {minimoResgate} pontos
            (R$ {Math.floor(minimoResgate / pontosPorReal)},00).
            {convite.saldoAtual > 0 && (
              <> Você já tem <strong>{convite.saldoAtual} pontos</strong> guardados.</>
            )}
          </p>
        </div>
      </header>

      {todasAvaliadas ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <h2 className="text-2xl font-light text-ink">Você já avaliou este pedido 💛</h2>
          <p className="mt-3 text-body font-light text-ink-soft">
            Obrigada! Suas avaliações entram na página das peças assim que a gente publicar.
          </p>
          <AppLink
            href="/novidades"
            className="mt-6 inline-flex items-center justify-center rounded-full bg-ink px-8 py-3.5 text-button uppercase tracking-widest text-light transition hover:bg-primary-strong"
          >
            Ver novidades
          </AppLink>
        </div>
      ) : (
        <FormAvaliacao convite={convite} />
      )}
    </Section>
  );
}
