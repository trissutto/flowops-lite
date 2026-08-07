import Link from 'next/link';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { api } from '@/lib/api';
import { buildMetadata } from '@/lib/seo';

/**
 * GUIA DE MEDIDAS (`/tamanhos/guia`).
 *
 * 🔴 Estava linkado em QUATRO lugares — o "Guia de tamanhos" da PDP, o rodapé,
 * o menu e a busca — e **a rota não existia**. Ou seja: a dúvida nº 1 da
 * cliente plus size ("serve em mim?"), respondida com 404, no exato momento em
 * que ela estava decidindo comprar.
 *
 * As medidas vêm do cadastro (`grades_medidas`), não daqui. Nenhum número
 * nesta página é inventado — se não houver grade cadastrada, a página mostra
 * COMO se medir e manda pra tabela da própria peça, que é a exata. Guia de
 * medidas com número chutado é troca garantida.
 */

export const revalidate = 3600;

export const metadata = buildMetadata({
  title: 'Guia de medidas',
  description:
    'Como tirar suas medidas e encontrar seu tamanho na Lurd’s Plus Size — do 46 ao 60, com busto, cintura e quadril em centímetros.',
  path: '/tamanhos/guia',
  keywords: ['guia de medidas plus size', 'tabela de medidas 46 ao 60', 'qual meu tamanho plus size'],
});

interface Grade {
  nome: string;
  observacao: string | null;
  linhas: Array<Record<string, string | number>>;
}

/** Rótulo humano pra cada coluna que a grade pode ter. */
const COLUNAS: Array<[string, string]> = [
  ['tamanho', 'Tamanho'],
  ['busto', 'Busto'],
  ['cintura', 'Cintura'],
  ['quadril', 'Quadril'],
  ['comprimento', 'Comprimento'],
];

async function buscarGrades(): Promise<Grade[]> {
  try {
    const r = await api<{ itens: Grade[] }>('/public/loja/grades-medidas', {
      revalidate: 3600,
      tags: ['grades-medidas'],
      timeoutMs: 10000,
    });
    return r?.itens ?? [];
  } catch {
    return [];
  }
}

export default async function GuiaDeMedidasPage() {
  const grades = await buscarGrades();

  return (
    <Section space="lg">
      <Container width="text">
        <header className="mb-10">
          <p className="eyebrow text-muted">Ajuda</p>
          <h1 className="text-h2">Guia de medidas</h1>
          <p className="mt-4 text-body-lg font-light text-ink-soft">
            Na dúvida entre dois tamanhos, vá no maior. Roupa folgada a gente ajusta;
            roupa apertada volta.
          </p>
        </header>

        <h2 className="text-h4">Como se medir</h2>
        <ol className="mt-4 flex list-decimal flex-col gap-3 pl-5 text-body font-light text-ink-soft">
          <li>
            <strong className="font-medium text-ink">Busto:</strong> passe a fita na parte
            mais cheia do busto, com o sutiã que você costuma usar. A fita fica reta nas
            costas.
          </li>
          <li>
            <strong className="font-medium text-ink">Cintura:</strong> na parte mais fina do
            tronco, normalmente logo acima do umbigo. Não prenda a barriga — meça relaxada,
            que é como você vai usar a roupa.
          </li>
          <li>
            <strong className="font-medium text-ink">Quadril:</strong> na parte mais larga,
            com os pés juntos.
          </li>
        </ol>
        <p className="mt-4 text-small text-muted">
          Meça por cima de roupa leve, com a fita justa mas sem apertar. Se puder, peça pra
          alguém medir — medir a si mesma costuma dar 2 a 3 cm a menos.
        </p>

        {grades.length > 0 ? (
          <>
            <h2 className="mt-12 text-h4">Nossas tabelas</h2>
            <p className="mt-2 text-body font-light text-ink-soft">
              Medidas em centímetros, do corpo — não da peça.
            </p>

            {grades.map((g) => {
              // Só as colunas que ESTA grade preenche: coluna vazia numa tabela
              // de medidas parece medida faltando, e a cliente desconfia da
              // tabela inteira.
              const colunas = COLUNAS.filter(([chave]) =>
                g.linhas.some((l) => l[chave] !== undefined && l[chave] !== null && l[chave] !== ''),
              );
              if (!colunas.length) return null;

              return (
                <div key={g.nome} className="mt-8">
                  <h3 className="text-body font-medium text-ink">{g.nome}</h3>
                  {g.observacao && (
                    <p className="mt-1 text-small text-muted">{g.observacao}</p>
                  )}
                  {/* Tabela rola sozinha no celular — a página nunca rola de lado. */}
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[380px] border-collapse text-small">
                      <thead>
                        <tr className="border-b border-border text-left">
                          {colunas.map(([chave, rotulo]) => (
                            <th key={chave} className="py-2 pr-4 font-medium text-ink">
                              {rotulo}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {g.linhas.map((l, i) => (
                          <tr key={i} className="border-b border-border/60">
                            {colunas.map(([chave]) => (
                              <td key={chave} className="tabular py-2 pr-4 text-ink-soft">
                                {l[chave] ?? '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          /* Sem grade cadastrada NÃO se inventa tabela — manda pro lugar exato. */
          <div className="mt-12 rounded-sm border border-border bg-surface-alt/60 p-6">
            <p className="text-body text-ink">
              A tabela varia de peça pra peça — modelagem solta e alfaiataria não vestem
              igual no mesmo número.
            </p>
            <p className="mt-2 text-body font-light text-ink-soft">
              Por isso a medida certa fica na <strong>própria página da peça</strong>, em
              “Tamanhos disponíveis”. Se não achar, chame uma consultora: ela mede a peça na
              mão e te diz.
            </p>
          </div>
        )}

        <h2 className="mt-12 text-h4">Ainda em dúvida?</h2>
        <p className="mt-2 text-body font-light text-ink-soft">
          Você pode <Link href="/lojas" className="link-underline text-ink">provar em qualquer
          uma das 14 lojas</Link> antes de levar — se não vestir, você não leva e não paga
          nada. E se comprar aqui e não servir,{' '}
          <Link href="/politica-de-trocas" className="link-underline text-ink">
            a troca é sua por 30 dias
          </Link>
          .
        </p>
      </Container>
    </Section>
  );
}
