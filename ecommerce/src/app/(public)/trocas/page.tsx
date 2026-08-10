import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { PortalTrocas } from '@/components/trocas/PortalTrocas';
import { chamarTrocas, docDaSessao, type PedidoResumo } from '@/lib/trocas';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * TROCA FÁCIL — agora no site, não mais um desvio pro FlowOps.
 *
 * ── O QUE MUDA PRA CLIENTE ──
 *
 * O portal antigo pedia **nº do pedido + CPF**, sempre. Quem está logada já
 * provou quem é: os pedidos dela aparecem prontos, é só escolher a peça. Quem
 * não tem conta segue pelo caminho de sempre (CPF, celular ou e-mail).
 *
 * Achar o número do pedido no e-mail é o degrau onde se desiste de pedir
 * troca e se manda mensagem no WhatsApp — o que custa atendimento e some do
 * registro.
 *
 * ── O QUE NÃO MUDA ──
 *
 * A REGRA continua inteira no FlowOps: prazo, direito à reversa grátis,
 * motivos aceitos, decisão entre trocar/vale/reembolso. Aqui é só a tela.
 * Duas telas com duas políticas seria duas políticas divergindo sozinhas.
 */

export const dynamic = 'force-dynamic';

export const metadata = buildMetadata({
  title: 'Trocas e devoluções',
  description:
    'Peça sua troca em poucos cliques. Do 44 ao 60, com logística reversa e acompanhamento pelo site.',
  path: '/trocas',
  keywords: ['troca', 'devolução', 'logística reversa', 'plus size'],
});

const trail = [
  { name: 'Início', path: '/' },
  { name: 'Trocas', path: '/trocas' },
];

export default async function TrocasPage() {
  /**
   * Busca os pedidos JÁ NO SERVIDOR pra cliente logada: a tela abre com a
   * lista pronta, sem um segundo de espera nem um formulário no caminho.
   * Falha aqui não é erro de tela — cai no formulário de sempre.
   */
  const doc = await docDaSessao();
  let pedidos: PedidoResumo[] = [];
  if (doc) {
    try {
      const r = await chamarTrocas<{ pedidos?: PedidoResumo[] }>('buscar', { doc });
      pedidos = r?.pedidos ?? [];
    } catch {
      /* segue como visitante */
    }
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdGraph(breadcrumbSchema(trail)) }}
      />

      <Section width="text" space="sm">
        <Breadcrumb
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
        <SectionTitle
          eyebrow="Troca fácil"
          title="Não serviu? A gente resolve."
          description="Escolha a peça, diga o motivo e a gente cuida do resto — com etiqueta de devolução paga pela Lurd's na primeira troca."
          as="h1"
        />
      </Section>

      <Container width="text">
        <PortalTrocas logada={Boolean(doc)} pedidosIniciais={pedidos} />
      </Container>
    </>
  );
}
