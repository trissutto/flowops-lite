'use client';

/**
 * /minha-loja/funcionarias — a GERENTE cadastra Função + PIN das funcionárias
 * DA LOJA DELA (a loja não acessa a retaguarda). Mesma tela da matriz, escopada
 * pelo backend (JWT): loja vê só as suas e não concede MASTER/SUPREMA.
 */
import OperadoresManager from '@/components/rh/OperadoresManager';

export default function FuncionariasLojaPage() {
  return <OperadoresManager backHref="/minha-loja" backLabel="Loja" />;
}
