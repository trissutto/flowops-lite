import type { ReactNode } from 'react';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';

/**
 * MOLDURA DAS PÁGINAS LEGAIS — trocas, privacidade, termos.
 *
 * Uma peça só porque as três têm exatamente a mesma forma: título, data da
 * última revisão e texto corrido. Página legal com layout diferente a cada
 * versão é página que ninguém mantém.
 *
 * A DATA é obrigatória e fica no topo, não no rodapé: "quando isso mudou?" é
 * a primeira pergunta de quem consulta uma política — inclusive num
 * questionamento de consumidor.
 *
 * Largura de TEXTO (não `wide`): política é pra ler, e linha longa demais é o
 * jeito mais rápido de ninguém ler.
 */
export function PaginaLegal({
  titulo,
  atualizadoEm,
  resumo,
  children,
}: {
  titulo: string;
  /** ISO (YYYY-MM-DD) da última revisão do TEXTO, não do deploy. */
  atualizadoEm: string;
  /** Uma frase respondendo a dúvida principal, antes do texto formal. */
  resumo?: string;
  children: ReactNode;
}) {
  const data = new Date(`${atualizadoEm}T12:00:00`);

  return (
    <Section space="lg">
      <Container width="text">
        <header className="mb-8">
          <h1 className="text-h2">{titulo}</h1>
          <p className="mt-2 text-small text-muted">
            Última atualização: {data.toLocaleDateString('pt-BR')}
          </p>
          {resumo && <p className="mt-5 text-body-lg font-light text-ink-soft">{resumo}</p>}
        </header>

        {/* `prose-lurds` não existe: o espaçamento sai das próprias tags, que é
            o que mantém estas páginas legíveis sem plugin de tipografia. */}
        <div className="flex flex-col gap-5 text-body font-light text-ink-soft [&_a]:text-ink [&_a]:underline [&_h2]:mt-6 [&_h2]:text-h4 [&_h2]:font-normal [&_h2]:text-ink [&_li]:mb-2 [&_strong]:font-medium [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5">
          {children}
        </div>
      </Container>
    </Section>
  );
}
