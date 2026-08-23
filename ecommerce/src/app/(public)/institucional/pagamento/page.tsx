import Link from 'next/link';
import { PaginaLegal } from '@/components/institucional/PaginaLegal';
import { buildMetadata } from '@/lib/seo';
import { PIX_DESCONTO_PCT } from '@/lib/commerce/pix';
import { MAX_PARCELAS } from '@/lib/commerce/cartao';

/**
 * FORMAS DE PAGAMENTO — a página que a faixa do topo prometia e não tinha.
 *
 * "Até 12x sem juros" é o anúncio mais persuasivo do site e apontava pra
 * `/carrinho` — ou seja, pra uma sacola vazia, pra quem ainda nem escolheu a
 * peça. O destino agora é aqui.
 *
 * ⚠️ CREDIÁRIO PRÓPRIO NÃO ENTRA (dono, 22/08/2026). Ele existe na loja
 * física, mas não é oferecido no site — e prometer aqui o que o checkout não
 * faz é o mesmo erro do "30 dias de troca" que o portal recusava.
 *
 * Os números vêm das MESMAS constantes que o checkout usa (`PIX_DESCONTO_PCT`,
 * `MAX_PARCELAS`). Se a régua mudar, este texto muda junto — foi assim que o
 * "frete grátis acima de R$ 399" ficou no ar depois da régua virar config.
 */

export const metadata = buildMetadata({
  title: 'Formas de pagamento',
  description:
    `Como pagar na Lurd's Plus Size: Pix com ${PIX_DESCONTO_PCT}% de desconto, cartão de crédito em até ${MAX_PARCELAS}x sem juros e pagamento na retirada em loja.`,
  path: '/institucional/pagamento',
});

export default function PagamentoPage() {
  return (
    <PaginaLegal
      titulo="Formas de pagamento"
      atualizadoEm="2026-08-22"
      resumo={`No site você paga por Pix, com ${PIX_DESCONTO_PCT}% de desconto à vista, ou no cartão de crédito em até ${MAX_PARCELAS}x sem juros — sem valor mínimo de parcela.`}
    >
      <h2>Pix — {PIX_DESCONTO_PCT}% de desconto</h2>
      <p>
        É a forma mais rápida e a mais barata para você. Ao escolher Pix, o desconto de{' '}
        <strong>{PIX_DESCONTO_PCT}%</strong> já entra no total antes de você confirmar — o
        valor que aparece na tela é o valor do QR Code.
      </p>
      <p>
        {/* Sem prometer minutos: a validade vem do gateway (`pix.expiresAt`) e
            aparece em contagem regressiva na própria tela do QR Code. Número
            chumbado aqui é promessa que o servidor pode desmentir. */}
        O código tem validade, e o tempo que resta aparece na tela junto do QR Code. Assim
        que o pagamento cai, seu pedido entra na fila de separação automaticamente e você
        recebe a confirmação no WhatsApp. Se o prazo passar, nada é cobrado e você pode
        gerar um código novo em <Link href="/conta/pedidos">Meus pedidos</Link>.
      </p>

      <h2>Cartão de crédito — até {MAX_PARCELAS}x sem juros</h2>
      <p>
        Aceitamos as principais bandeiras. O parcelamento vai até{' '}
        <strong>{MAX_PARCELAS} vezes sem nenhum acréscimo</strong>: o total parcelado é
        exatamente o total à vista, dividido. Não há valor mínimo de parcela — você escolhe
        em quantas vezes quer, e o valor de cada uma aparece na própria lista, antes de
        confirmar.
      </p>
      <p>
        A cobrança é feita pelo <strong>PagBank</strong> ou pela <strong>Pagar.me</strong>,
        que são quem processa o cartão. O número do seu cartão não passa pelos nossos
        servidores nem fica guardado aqui.
      </p>

      <h2>Retirada em loja</h2>
      <p>
        Se você escolher retirar em uma das{' '}
        <Link href="/lojas">nossas 14 lojas</Link>, o pagamento pode ser feito no site,
        como em qualquer pedido, e você só passa para buscar a peça — ou pode acertar
        direto no balcão, na hora da retirada. Nesse caso valem também as formas de
        pagamento da loja física.
      </p>

      <h2>É seguro pagar aqui?</h2>
      <ul>
        <li>
          A conexão é criptografada de ponta a ponta — é o cadeado que aparece na barra do
          navegador.
        </li>
        <li>
          Os dados do cartão vão direto para o processador de pagamento. A loja recebe
          apenas a confirmação de que o pagamento passou.
        </li>
        <li>
          A loja <strong>não guarda</strong> o número do seu cartão, nem para recompra.
        </li>
        <li>
          Somos uma rede com <Link href="/lojas">14 lojas de rua</Link> e CNPJ aberto —
          20.104.813/0001-39.
        </li>
      </ul>

      <h2>Quando o pagamento é recusado</h2>
      <p>
        Recusa quase sempre vem do banco emissor, não da loja. Os motivos mais comuns são
        limite indisponível, dados divergentes do cadastro do cartão (nome, CPF ou endereço
        de cobrança) e bloqueio preventivo por compra online.
      </p>
      <p>
        Se acontecer, a tela diz o que o banco respondeu e você pode tentar outro cartão ou
        mudar para Pix sem refazer o pedido. Nenhum valor fica retido: tentativa recusada
        não vira cobrança.
      </p>

      <h2>Nota fiscal</h2>
      <p>
        A nota é emitida em nome do CPF informado no checkout e segue junto com a peça. A
        via eletrônica também fica em <Link href="/conta/pedidos">Meus pedidos</Link>.
      </p>

      <h2>Reembolso</h2>
      <p>
        Em caso de devolução, o dinheiro volta pelo mesmo caminho: no Pix, na conta que
        você indicar, em até 10 dias após a peça chegar aqui; no cartão, pela operadora,
        que costuma levar uma ou duas faturas. As condições completas estão em{' '}
        <Link href="/politica-de-trocas">Trocas e devoluções</Link>.
      </p>

      <h2>Ficou com dúvida?</h2>
      <p>
        Fale com uma consultora pelo WhatsApp da{' '}
        <Link href="/lojas">loja mais perto de você</Link> — quem atende no balcão é quem
        responde. Se preferir escrever, é{' '}
        <a href="mailto:atendimento@lurdsplussize.com.br">atendimento@lurdsplussize.com.br</a>.
      </p>
    </PaginaLegal>
  );
}
