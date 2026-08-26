import { redirect } from 'next/navigation';

/**
 * /retaguarda/top-da-semana → /retaguarda/colecoes (26/08/2026).
 *
 * A curadoria da "Mais Top da Semana" virou UMA das coleções da tela nova —
 * que também cria coleções pontuais ("Coleção Resort" com as peças da JOIN) e
 * decide qual ocupa a vaga do menu do site. Rota antiga fica de redirect pra
 * não quebrar favorito nem memória muscular.
 */
export default function TopDaSemanaRedirect() {
  redirect('/retaguarda/colecoes');
}
