import Link from 'next/link';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { comoCliente } from '@/lib/conta';
import { buildMetadata } from '@/lib/seo';

/**
 * ENDEREÇOS — os mesmos que a cliente já usa no app e na loja.
 *
 * Leitura só: cadastrar endereço novo acontece no checkout, onde ela já está
 * digitando CEP de qualquer jeito. Duas telas de cadastro do mesmo dado é
 * como nascem dois endereços diferentes pra mesma pessoa.
 */

export const metadata = buildMetadata({
  title: 'Meus endereços',
  path: '/conta/enderecos',
  noIndex: true,
});

export const dynamic = 'force-dynamic';

interface Endereco {
  id: string;
  label?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  uf?: string | null;
  zip?: string | null;
  zipCode?: string | null;
  isPrimary?: boolean;
}

function linha(e: Endereco): string {
  const rua = [e.street, e.number].filter(Boolean).join(', ');
  const resto = [e.complement, e.district].filter(Boolean).join(' · ');
  const cidade = [e.city, e.state || e.uf].filter(Boolean).join('/');
  const cep = e.zip || e.zipCode;
  return [rua, resto, cidade, cep ? `CEP ${cep}` : null].filter(Boolean).join(' — ');
}

export default async function EnderecosPage() {
  const dados = await comoCliente<{ addresses: Endereco[] }>('/customers/app/addresses');

  if (dados === null) {
    return (
      <Section space="lg">
        <Container>
          <h1 className="mb-8 text-center text-h2">Meus endereços</h1>
          <AcessoConta voltarPara="/conta/enderecos" />
        </Container>
      </Section>
    );
  }

  const enderecos = dados.addresses ?? [];

  return (
    <Section space="lg">
      <Container>
        <header className="mb-8">
          <p className="eyebrow text-muted">
            <Link href="/conta" className="link-underline">Minha conta</Link>
          </p>
          <h1 className="text-h2">Meus endereços</h1>
        </header>

        {enderecos.length === 0 ? (
          <p className="text-body text-muted">
            Nenhum endereço guardado ainda — o primeiro é salvo quando você fecha um pedido.
          </p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {enderecos.map((e) => (
              <li key={e.id} className="py-5">
                <p className="text-body">
                  {e.label || 'Endereço'}
                  {e.isPrimary && <span className="ml-2 text-small text-primary">principal</span>}
                </p>
                <p className="text-small text-muted">{linha(e)}</p>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </Section>
  );
}
