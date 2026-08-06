import Link from 'next/link';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { PreferenciasLgpd } from '@/components/conta/PreferenciasLgpd';
import { getClienteLogada } from '@/lib/conta';
import { buildMetadata } from '@/lib/seo';

/**
 * MEUS DADOS (item 67) — o que a loja tem e o que a cliente autorizou.
 *
 * Duas coisas que a LGPD exige e que não existiam no site: ela precisa VER o
 * que guardamos, e precisa poder mudar o que autorizou receber.
 *
 * O CPF aparece MASCARADO mesmo pra dona dele. Não é desconfiança — é que a
 * tela fica aberta no celular, em ônibus e em loja, e documento inteiro na
 * tela é documento fotografado por cima do ombro.
 */

export const metadata = buildMetadata({
  title: 'Meus dados',
  path: '/conta/dados',
  noIndex: true,
});

export const dynamic = 'force-dynamic';

function mascararCpf(cpf?: string | null): string {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return '—';
  return `***.***.**${d[8]}-${d.slice(9)}`;
}

export default async function MeusDadosPage() {
  const cliente = await getClienteLogada();

  if (!cliente) {
    return (
      <Section space="lg">
        <Container>
          <h1 className="mb-8 text-center text-h2">Meus dados</h1>
          <AcessoConta voltarPara="/conta/dados" />
        </Container>
      </Section>
    );
  }

  const campos: Array<[string, string]> = [
    ['Nome', String(cliente.name || '—')],
    ['CPF', mascararCpf(cliente.cpf)],
    ['E-mail', String(cliente.email || '—')],
    ['Celular', String(cliente.phone || '—')],
  ];

  return (
    <Section space="lg">
      <Container>
        <header className="mb-8">
          <p className="eyebrow text-muted">
            <Link href="/conta" className="link-underline">Minha conta</Link>
          </p>
          <h1 className="text-h2">Meus dados</h1>
        </header>

        <dl className="divide-y divide-border border-y border-border">
          {campos.map(([rotulo, valor]) => (
            <div key={rotulo} className="flex items-baseline justify-between gap-4 py-4">
              <dt className="text-small text-muted">{rotulo}</dt>
              <dd className="text-body">{valor}</dd>
            </div>
          ))}
        </dl>

        <h2 className="mt-10 mb-3 text-h4">O que você quer receber</h2>
        <PreferenciasLgpd />

        <h2 className="mt-10 mb-3 text-h4">Seus direitos</h2>
        <p className="text-body text-muted">
          Você pode pedir uma cópia dos seus dados ou apagar sua conta quando quiser.
          Fale com a gente em{' '}
          <a href="mailto:privacidade@lurdsplussize.com.br" className="link-underline text-ink">
            privacidade@lurdsplussize.com.br
          </a>{' '}
          — respondemos em até 15 dias.
        </p>
      </Container>
    </Section>
  );
}
