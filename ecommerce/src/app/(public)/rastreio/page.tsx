import Link from 'next/link';
import { buildMetadata } from '@/lib/seo';
import { RastreioForm } from './RastreioForm';

/**
 * RASTREIO — a segunda página mais buscada do domínio.
 *
 * ── POR QUE ELA EXISTE ──
 *
 * Medição da Search Console em 19/08/2026: `lurds.com.br/rastreio/` teve
 * **2.060 cliques nos últimos 90 dias**, com CTR de 33% e só 6.231 impressões.
 * Não é gente achando por acaso — é a cliente que JÁ COMPROU digitando
 * "rastreio lurds" no Google pra ver onde está a encomenda. Nos 16 meses
 * inteiros foram 2.064 cliques: quase tudo é dos últimos 3 meses, ou seja,
 * é hábito atual e crescente.
 *
 * No site antigo existia. Aqui não existia, e a virada de domínio a
 * transformaria em 404 pra quem mais merece atenção: cliente com dinheiro já
 * pago esperando uma caixa.
 *
 * ── O QUE ESTA TELA FAZ, E O QUE AINDA NÃO FAZ ──
 *
 * Hoje ela leva o código direto pro rastreamento dos Correios e oferece o
 * caminho de quem não tem o código na mão (entrar com CPF e ver o pedido).
 *
 * O status DENTRO do site, com a cascata que o backend já tem
 * (`TrackingService`: SRO dos Correios → Mais Envios → LinkeTrack), depende de
 * um endpoint público — o `GET /tracking/:code` de hoje é autenticado de
 * propósito, pra não expor token de provedor em tráfego aberto. Abrir um proxy
 * sem trava de taxa na véspera da virada era troca ruim. Quando o endpoint
 * público existir, é só o formulário passar a chamar ele em vez de sair do
 * site: o resto da página não muda.
 */

export const metadata = buildMetadata({
  title: 'Rastrear meu pedido',
  description:
    'Acompanhe a entrega do seu pedido da Lurd’s Plus Size: consulte pelo código de rastreio dos Correios ou entre com seu CPF para ver seus pedidos.',
  path: '/rastreio',
});

export default function RastreioPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-12 sm:py-16">
      <header className="mb-8">
        <h1 className="font-serif text-3xl sm:text-4xl">Rastrear meu pedido</h1>
        <p className="mt-3 text-base text-neutral-600">
          Assim que sua peça é postada, o código de rastreio vai pra você por WhatsApp e
          e-mail. É com ele que dá pra ver onde a encomenda está agora.
        </p>
      </header>

      <RastreioForm />

      <section className="mt-12 border-t border-neutral-200 pt-8">
        <h2 className="font-serif text-xl">Não tenho o código</h2>
        <p className="mt-3 text-base text-neutral-600">
          Entre com seu CPF e veja todos os seus pedidos, com o status de cada um e o
          código de rastreio quando já houver.
        </p>
        <Link
          href="/conta/pedidos"
          className="mt-4 inline-flex items-center justify-center rounded-full bg-neutral-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
        >
          Ver meus pedidos
        </Link>
      </section>

      <section className="mt-10 border-t border-neutral-200 pt-8">
        <h2 className="font-serif text-xl">Quanto tempo leva</h2>
        <ul className="mt-3 space-y-2 text-base text-neutral-600">
          <li>
            <strong className="text-neutral-900">Separação:</strong> até 2 dias úteis
            depois da confirmação do pagamento.
          </li>
          <li>
            <strong className="text-neutral-900">Entrega:</strong> o prazo dos Correios
            começa a contar da postagem, não da compra.
          </li>
          <li>
            <strong className="text-neutral-900">Pedido dividido:</strong> quando as peças
            saem de lojas diferentes, você recebe mais de um código — e mais de uma caixa.
          </li>
        </ul>
      </section>

      <section className="mt-10 border-t border-neutral-200 pt-8">
        <h2 className="font-serif text-xl">Precisa falar com a gente?</h2>
        <p className="mt-3 text-base text-neutral-600">
          Se o rastreio não atualiza há dias ou a data passou, fale com a loja mais perto
          de você — quem separou seu pedido resolve mais rápido.
        </p>
        <Link href="/lojas" className="mt-4 inline-block text-base underline underline-offset-4">
          Ver as lojas e os WhatsApps
        </Link>
      </section>
    </main>
  );
}
