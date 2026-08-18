import Link from 'next/link';
import { PaginaLegal } from '@/components/institucional/PaginaLegal';
import { buildMetadata } from '@/lib/seo';

/**
 * TERMOS DE USO (item 108).
 *
 * ⚠️ Descreve o que a loja REALMENTE faz — cada regra aqui corresponde a
 * comportamento implementado: o preço reconferido no catálogo antes de cobrar,
 * o estoque sem reserva (dois pedidos podem disputar a última peça), o Pix com
 * validade de 24 horas, a tabela promocional de frete.
 *
 * O ponto do estoque é o que mais evita briga: como não há reserva (decisão do
 * dono, 03/08), duas clientes podem pagar a mesma última peça. Dizer isso ANTES
 * é o que transforma um problema numa expectativa combinada.
 *
 * PENDÊNCIA DO DONO: razão social, CNPJ e endereço.
 */

export const metadata = buildMetadata({
  title: 'Termos de uso',
  description: 'As regras da loja online da Lurd’s Plus Size: pedido, pagamento, preço, estoque e entrega.',
  path: '/termos',
});

export default function TermosPage() {
  return (
    <PaginaLegal
      titulo="Termos de uso"
      atualizadoEm="2026-08-06"
      resumo="As regras da nossa loja online: como o pedido é fechado, o que acontece com o preço e o estoque, e o que garantimos na entrega."
    >
      <h2>Quem somos</h2>
      <p>
        Esta é a loja online da Lurd’s Plus Size, <strong>CNPJ 20.104.813/0001-39</strong>,
        a mesma rede das lojas físicas. Comprando aqui, você fala com a mesma empresa que
        te atende no balcão.
      </p>

      <h2>Como o pedido é fechado</h2>
      <p>
        O pedido só existe depois do pagamento confirmado. Antes disso, o que você vê é uma
        intenção de compra: no Pix, o código vale <strong>24 horas</strong>; passou disso
        sem pagar, o pedido não segue.
      </p>
      <p>
        No momento de fechar, conferimos de novo o preço e o estoque de cada peça. Se algo
        tiver mudado, avisamos antes de cobrar — nunca cobramos um valor diferente do que
        você viu na tela.
      </p>

      <h2>Preço</h2>
      <p>
        O preço que vale é o que aparece no momento da compra. Se o preço subir entre o
        instante em que você colocou a peça na sacola e o pagamento,{' '}
        <strong>não cobramos a diferença</strong>: o pedido é recusado e você recarrega a
        página para ver o valor novo. Se cair, você paga o menor.
      </p>
      <p>
        Erro evidente de digitação — uma peça de R$ 200 anunciada por R$ 2, por exemplo —
        não gera obrigação de venda. Nesse caso cancelamos, avisamos e devolvemos qualquer
        valor pago.
      </p>

      <h2>Estoque</h2>
      <p>
        O estoque é o mesmo das lojas físicas e é atualizado em tempo real. Como a peça
        <strong> não fica reservada</strong> enquanto está na sua sacola, pode acontecer de
        a última unidade ser vendida no balcão ou para outra cliente antes de você fechar.
        Se isso acontecer depois do pagamento, cancelamos aquele item e devolvemos o valor
        integral — ou, se você preferir, trocamos por outra peça.
      </p>

      <h2>Pagamento</h2>
      <p>
        Aceitamos Pix e cartão de crédito. O número do cartão é enviado direto do seu
        navegador para o nosso meio de pagamento e não passa pelos nossos servidores. A
        aprovação é da operadora do cartão — quando ela recusa, o pedido não é criado e
        nada é cobrado.
      </p>

      <h2>Entrega</h2>
      <p>
        O prazo mostrado no checkout é o do transportador <strong>mais os dias de
        separação</strong> da peça na loja, e conta em dias úteis a partir da confirmação
        do pagamento. Prazo de transportadora é estimativa dele, não promessa nossa — o que
        garantimos é postar dentro do prazo de separação combinado.
      </p>
      <p>
        Você também pode retirar em qualquer loja da lista de retirada, sem custo. Não
        exigimos que a peça já esteja naquela loja: se não estiver, ela vem de outra da
        rede.
      </p>

      <h2>Trocas</h2>
      <p>
        As regras completas estão em{' '}
        <Link href="/politica-de-trocas">Trocas e devoluções</Link>.
      </p>

      <h2>Seus dados</h2>
      <p>
        Estão descritos em <Link href="/privacidade">Política de privacidade</Link>.
      </p>

      <h2>Mudanças nestes termos</h2>
      <p>
        Podemos atualizar este texto. A data no topo diz quando foi a última vez — e o que
        vale para o seu pedido é a versão que estava no ar no dia da compra.
      </p>
    </PaginaLegal>
  );
}
