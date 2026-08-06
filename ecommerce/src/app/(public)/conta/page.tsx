import Link from 'next/link';
import { Package, MapPin, Wallet, Heart, RefreshCw, ShieldCheck, LogOut } from 'lucide-react';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { SairDaConta } from '@/components/conta/SairDaConta';
import { getClienteLogada } from '@/lib/conta';
import { buildMetadata } from '@/lib/seo';

/**
 * MINHA CONTA — a mesma conta da loja física.
 *
 * Não existe base de clientes do site: o CRM do FlowOps é a base, e o login
 * é por CPF. Quem já comprou na loja entra com o CPF que já está lá e vê o
 * histórico junto. Ver [[clientes-pessoa-vs-cadastro]].
 */

export const metadata = buildMetadata({
  title: 'Minha conta',
  path: '/conta',
  noIndex: true,
});

export const dynamic = 'force-dynamic';

export default async function ContaPage() {
  const cliente = await getClienteLogada();

  if (!cliente) {
    return (
      <Section space="lg">
        <Container>
          <h1 className="mb-8 text-center text-h2">Minha conta</h1>
          <AcessoConta />
        </Container>
      </Section>
    );
  }

  const primeiroNome = String(cliente.name || '').split(' ')[0] || 'Bem-vinda';
  const atalhos = [
    { href: '/conta/pedidos', icon: Package, titulo: 'Meus pedidos', texto: 'Acompanhe e rastreie o que você comprou' },
    // O saldo já era creditado a cada compra e nunca teve tela: cashback que a
    // cliente não vê não muda comportamento nenhum — é custo sem retorno.
    { href: '/conta/cashback', icon: Wallet, titulo: 'Meu cashback', texto: 'Seu saldo e de onde ele veio' },
    { href: '/conta/enderecos', icon: MapPin, titulo: 'Endereços', texto: 'Onde a gente entrega' },
    { href: '/conta/favoritos', icon: Heart, titulo: 'Lista de desejos', texto: 'As peças que você guardou' },
    { href: '/conta/dados', icon: ShieldCheck, titulo: 'Meus dados', texto: 'O que a gente tem e o que você autoriza' },
    { href: '/trocas', icon: RefreshCw, titulo: 'Troca fácil', texto: 'Trocar ou devolver uma peça' },
  ];

  return (
    <Section space="lg">
      <Container>
        <header className="mb-10">
          <p className="eyebrow text-muted">Minha conta</p>
          <h1 className="text-h2">Olá, {primeiroNome}</h1>
        </header>

        <div className="grid gap-4 sm:grid-cols-3">
          {atalhos.map(({ href, icon: Icone, titulo, texto }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-sm border border-border p-6 transition-colors hover:border-primary"
            >
              <Icone className="mb-3 size-5 text-primary" strokeWidth={1.5} />
              <p className="text-body font-medium">{titulo}</p>
              <p className="mt-1 text-small text-muted">{texto}</p>
            </Link>
          ))}
        </div>

        <div className="mt-10 flex items-center gap-2 text-small text-muted">
          <LogOut className="size-4" strokeWidth={1.5} />
          <SairDaConta />
        </div>
      </Container>
    </Section>
  );
}
