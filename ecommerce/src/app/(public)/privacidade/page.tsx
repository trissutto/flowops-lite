import Link from 'next/link';
import { PaginaLegal } from '@/components/institucional/PaginaLegal';
import { buildMetadata } from '@/lib/seo';

/**
 * POLÍTICA DE PRIVACIDADE (itens 108 e 110).
 *
 * ⚠️ Escrita a partir do que o código REALMENTE faz — não de um modelo
 * genérico. Cada afirmação aqui corresponde a algo que existe: o CPF que o
 * checkout exige, o cookie httpOnly da sessão, o cartão que é tokenizado no
 * navegador e nunca toca nosso servidor, os consentimentos gravados em
 * `customer_consents`.
 *
 * Política que promete o que o sistema não faz é pior que nenhuma: ela vira a
 * prova contra a empresa no dia da reclamação.
 *
 * PENDÊNCIA DO DONO: razão social, CNPJ e endereço do controlador. Não invento
 * dado cadastral — está marcado no texto.
 */

export const metadata = buildMetadata({
  title: 'Política de privacidade',
  description:
    'Quais dados a Lurd’s Plus Size coleta no site, para que usa, com quem compartilha e como você controla.',
  path: '/privacidade',
});

export default function PrivacidadePage() {
  return (
    <PaginaLegal
      titulo="Política de privacidade"
      atualizadoEm="2026-08-06"
      resumo="Coletamos o mínimo para entregar seu pedido e emitir sua nota. Você pode ver, corrigir ou apagar seus dados quando quiser."
    >
      <h2>Quem é responsável</h2>
      <p>
        A Lurd’s Plus Size, <strong>CNPJ 20.104.813/0001-39</strong>, é a controladora dos
        seus dados. Para falar sobre privacidade, escreva para{' '}
        <a href="mailto:privacidade@lurdsplussize.com.br">privacidade@lurdsplussize.com.br</a>.
      </p>

      <h2>O que coletamos</h2>
      <ul>
        <li>
          <strong>Para o pedido:</strong> nome, CPF, e-mail, telefone e endereço. O CPF é
          exigência da nota fiscal, não escolha nossa.
        </li>
        <li>
          <strong>Da compra:</strong> o que você comprou, quanto pagou e o status da
          entrega.
        </li>
        <li>
          <strong>Da navegação:</strong> páginas vistas e peças que você olhou, para medir
          o que funciona na loja e recomendar melhor.
        </li>
      </ul>
      <p>
        <strong>Dados de cartão não passam por aqui.</strong> O número é enviado
        direto do seu navegador para o nosso meio de pagamento, que devolve um código
        temporário — é esse código que o nosso sistema recebe. Nós nunca vemos, e nunca
        guardamos, o número do seu cartão.
      </p>

      <h2>Para que usamos</h2>
      <ul>
        <li>Separar, faturar e entregar o que você comprou.</li>
        <li>Atender você quando precisar, inclusive em troca e devolução.</li>
        <li>Cumprir obrigação fiscal — a nota fiscal fica guardada pelo prazo da lei.</li>
        <li>
          Mandar novidades e ofertas <strong>só se você autorizar</strong>. Aviso de pedido
          e nota fiscal não entram nessa conta: fazem parte da compra.
        </li>
      </ul>

      <h2>Com quem compartilhamos</h2>
      <p>
        Só com quem é necessário para a compra acontecer: o meio de pagamento, a
        transportadora que leva a peça até você, e os serviços que hospedam a loja. Não
        vendemos e não cedemos sua lista para ninguém.
      </p>

      <h2>Cookies</h2>
      <p>
        Usamos cookies para manter sua sacola e sua sessão funcionando — esses são
        necessários e não dá para desligar sem quebrar a loja. Os de medição só entram
        depois que você aceita no aviso que aparece na primeira visita, e você pode mudar
        de ideia a qualquer momento.
      </p>
      <p>
        O cookie da sua sessão é <strong>httpOnly</strong>: nenhum script da página
        consegue ler, o que impede que uma tag de terceiro pegue carona no seu login.
      </p>

      <h2>Seus direitos</h2>
      <p>A LGPD te dá o direito de, a qualquer momento:</p>
      <ul>
        <li>Ver quais dados temos sobre você.</li>
        <li>Corrigir o que estiver errado.</li>
        <li>Pedir uma cópia dos seus dados.</li>
        <li>Pedir que apaguemos sua conta.</li>
        <li>Retirar uma autorização que você tinha dado.</li>
      </ul>
      <p>
        As autorizações você muda sozinha em{' '}
        <Link href="/conta/dados">Meus dados</Link>. Para cópia ou exclusão, escreva para{' '}
        <a href="mailto:privacidade@lurdsplussize.com.br">privacidade@lurdsplussize.com.br</a>{' '}
        — respondemos em até 15 dias.
      </p>
      <p>
        Apagar a conta não apaga a nota fiscal das compras já feitas: a lei fiscal manda
        guardar, e ela é mais forte que o pedido de exclusão nesse ponto específico.
      </p>

      <h2>Por quanto tempo guardamos</h2>
      <p>
        Enquanto você tiver conta conosco, e depois pelo prazo que a lei exigir para nota
        fiscal e garantia. Passado isso, apagamos.
      </p>
    </PaginaLegal>
  );
}
