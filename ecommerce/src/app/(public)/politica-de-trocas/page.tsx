import Link from 'next/link';
import { PaginaLegal } from '@/components/institucional/PaginaLegal';
import { buildMetadata } from '@/lib/seo';

/**
 * POLÍTICA DE TROCAS (itens 81 e 83).
 *
 * ⚠️ O PRAZO DE TROCA É 7 DIAS, não 30 (dono, 12/08/2026).
 *
 * O site inteiro prometia 30 dias — do card ao rodapé — enquanto o portal que
 * recebe o pedido trabalha com 7 (`TrocasService.getPrazoDias`, default 7, e
 * não há `troca.prazoDias` gravado em produção). Ou seja: a vitrine convidava
 * a cliente a voltar no dia 20 e o sistema recusava. Promessa que o próprio
 * sistema nega custa mais caro que prazo curto.
 *
 * Separar o prazo LEGAL (7 dias, dinheiro de volta, qualquer motivo, art. 49
 * do CDC) do COMERCIAL (7 dias, troca por outra peça) continua importando: são
 * direitos diferentes com o mesmo prazo, e a cliente que pede dinheiro de
 * volta está pedindo outra coisa.
 *
 * Se a loja mudar o prazo, muda em `troca.prazoDias` (tela de trocas da
 * equipe) — e ESTE texto tem que mudar junto. Mesma armadilha do "frete grátis
 * acima de R$ 399" que ficou no ar depois da régua virar config.
 */

export const metadata = buildMetadata({
  title: 'Política de trocas e devoluções',
  description:
    'Como trocar ou devolver uma peça comprada no site da Lurd’s Plus Size: prazos, condições e como pedir.',
  path: '/politica-de-trocas',
});

export default function PoliticaTrocasPage() {
  return (
    <PaginaLegal
      titulo="Trocas e devoluções"
      atualizadoEm="2026-08-06"
      resumo="Você tem 7 dias, a partir do recebimento, para desistir da compra e receber o dinheiro de volta ou para trocar por outro tamanho, cor ou peça."
    >
      <h2>Desistiu da compra? 7 dias</h2>
      <p>
        Compra feita pela internet dá direito ao <strong>arrependimento em até 7 dias
        corridos</strong>, contados da data em que você recebeu a peça. É o artigo 49 do
        Código de Defesa do Consumidor, e vale <strong>por qualquer motivo</strong> — não
        precisa justificar, e a peça não precisa ter defeito.
      </p>
      <p>
        Nesse caso devolvemos <strong>tudo que você pagou, incluindo o frete</strong>, e o
        custo de nos enviar a peça de volta é nosso. O estorno sai em até 10 dias após a
        peça chegar aqui: no Pix, na conta que você indicar; no cartão, pela operadora,
        que costuma levar uma ou duas faturas.
      </p>

      <h2>Quer trocar? 7 dias</h2>
      <p>
        Para trocar a peça por outro tamanho, outra cor ou outra peça, o prazo é de{' '}
        <strong>7 dias corridos</strong> a partir do recebimento — o mesmo do
        arrependimento. O que conta é abrir o pedido de troca pelo portal dentro desses 7
        dias.
      </p>
      <p>
        Na troca, a diferença de valor é acertada: se a peça nova custar mais, você
        completa; se custar menos, a diferença vira crédito na sua conta para a próxima
        compra.
      </p>

      <h2>Como a peça precisa estar</h2>
      <ul>
        <li>Sem uso, sem lavar e sem cheiro (perfume e desodorante contam).</li>
        <li>Com a etiqueta presa, do jeito que chegou.</li>
        <li>Na embalagem original, junto com a nota fiscal.</li>
      </ul>
      <p>
        Peça provada não é peça usada — experimentar é o motivo de existir a troca. O que
        não dá para aceitar é peça que já foi vestida no dia a dia.
      </p>

      <h2>Peça com defeito</h2>
      <p>
        Defeito de fabricação tem <strong>90 dias</strong> de garantia, também por lei. Se
        aparecer, fale com a gente: trocamos por outra igual, e se não tivermos, você
        escolhe entre outra peça ou o dinheiro de volta. Aqui o frete dos dois lados é
        nosso.
      </p>

      <h2>Como pedir</h2>
      <p>
        Abra o <Link href="/trocas">portal de trocas</Link> com o número do pedido e o seu
        CPF. Você escolhe o que quer fazer, a gente gera a etiqueta de postagem e você leva
        a peça em qualquer agência dos Correios — sem pagar nada no balcão.
      </p>
      <p>
        Prefere resolver pessoalmente? Leve a peça e a nota em{' '}
        <Link href="/lojas">qualquer uma das nossas lojas</Link>, dentro do mesmo prazo.
      </p>

      <h2>O que não trocamos</h2>
      <ul>
        <li>Peça fora dos prazos acima.</li>
        <li>Peça com sinal de uso, lavagem, ajuste de costura ou sem etiqueta.</li>
        <li>Peça de higiene íntima com o lacre rompido.</li>
      </ul>

      <h2>Falar com a gente</h2>
      <p>
        WhatsApp e telefone estão em <Link href="/lojas">Nossas lojas</Link>. Se preferir
        escrever, é{' '}
        <a href="mailto:atendimento@lurdsplussize.com.br">atendimento@lurdsplussize.com.br</a>
        {' '}— respondemos em até 2 dias úteis.
      </p>
    </PaginaLegal>
  );
}
