import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import type { ResumoAvaliacoes } from '@/lib/avaliacoes';

/**
 * O QUE AS CLIENTES DIZEM — a prova social que a casa PODE mostrar.
 *
 * ── O QUE ESTAVA AQUI ANTES ──
 *
 * Até 06/08/2026 este espaço tinha depoimentos assinados "Cliente Lurds", com
 * altura, peso e tamanho comprado inventados, sob o título "direto de quem
 * comprou" — e as MESMAS quatro frases em TODAS as peças. Saiu do ar com um
 * compromisso escrito no lugar: volta quando houver avaliação real, amarrada
 * ao pedido entregue e à REF certa.
 *
 * ── O QUE MUDA AGORA ──
 *
 * Toda linha daqui nasceu de um pedido que o rastreio confirmou como ENTREGUE,
 * de um convite mandado pra aquela cliente, e passou por aprovação humana. Por
 * isso o selo "compra verificada" é uma afirmação, não enfeite.
 *
 * A DISTRIBUIÇÃO aparece junto da média de propósito. Média sozinha esconde o
 * formato: 4,5 de duas avaliações e 4,5 de duzentas são coisas diferentes, e
 * quem está decidindo gastar R$ 200 numa peça que não pode provar sabe disso.
 * Mostrar as notas baixas é o que faz as altas valerem alguma coisa.
 *
 * SILÊNCIO É MELHOR QUE POUCO: sem avaliação nenhuma o bloco não aparece (quem
 * chama é a PDP, com `null`). "1 avaliação" trabalha contra a peça — a mesma
 * régua do {@link SeloVendas}.
 */

function Estrelas({ nota, tamanho = 'sm' }: { nota: number; tamanho?: 'sm' | 'lg' }) {
  const px = tamanho === 'lg' ? 'h-5 w-5' : 'h-3.5 w-3.5';
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${nota} de 5 estrelas`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <svg
          key={n}
          viewBox="0 0 24 24"
          aria-hidden
          className={`${px} ${n <= Math.round(nota) ? 'fill-primary text-primary' : 'fill-border text-border'}`}
        >
          <path d="M12 17.3l-6.2 3.7 1.6-7.1L2 9.2l7.2-.6L12 2l2.8 6.6 7.2.6-5.4 4.7 1.6 7.1z" />
        </svg>
      ))}
    </span>
  );
}

function dataCurta(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

export function AvaliacoesProduto({ dados }: { dados: ResumoAvaliacoes }) {
  const { media, total, distribuicao, avaliacoes } = dados;
  const comFoto = avaliacoes.filter((a) => !!a.foto);
  const semFoto = avaliacoes.filter((a) => !a.foto);

  return (
    <Section tone="alt" space="md" width="page" aria-labelledby="avaliacoes-titulo">
      <SectionTitle
        id="avaliacoes-titulo"
        eyebrow="Quem comprou"
        title="O que as clientes dizem"
      />

      <div className="mt-8 grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* Média + distribuição */}
        <div className="lg:sticky lg:top-28 lg:self-start">
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-light text-ink">
              {media.toFixed(1).replace('.', ',')}
            </span>
            <span className="text-sm text-ink-soft">de 5</span>
          </div>
          <div className="mt-2">
            <Estrelas nota={media} tamanho="lg" />
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            {total} avaliação{total > 1 ? 'ões' : ''} de quem recebeu a peça
          </p>

          <ul className="mt-5 space-y-1.5">
            {[5, 4, 3, 2, 1].map((n) => {
              const qtd = distribuicao[String(n)] ?? 0;
              const pct = total ? Math.round((qtd / total) * 100) : 0;
              return (
                <li key={n} className="flex items-center gap-2 text-xs text-ink-soft">
                  <span className="w-3 tabular-nums">{n}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="w-7 text-right tabular-nums">{qtd}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* As avaliações — foto primeiro, porque foto é o que responde a
            pergunta que a foto de estúdio não responde: como fica em gente. */}
        <div className="min-w-0">
          {comFoto.length > 0 && (
            <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {comFoto.map((a) => (
                <figure
                  key={a.id}
                  className="overflow-hidden rounded-xl border border-border bg-surface"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.foto as string}
                    alt={`Foto enviada por ${a.autor ?? 'uma cliente'}`}
                    loading="lazy"
                    className="aspect-[3/4] w-full object-cover"
                  />
                  <figcaption className="p-3">
                    <Estrelas nota={a.nota} />
                    {a.comentario && (
                      <p className="mt-1.5 line-clamp-4 text-sm font-light leading-snug text-ink-soft">
                        {a.comentario}
                      </p>
                    )}
                    <p className="mt-2 text-[11px] uppercase tracking-wide text-ink-muted">
                      {a.autor ?? 'Cliente'}
                      {a.tamanho ? ` · tam ${a.tamanho}` : ''}
                    </p>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          <ul className="space-y-4">
            {semFoto.map((a) => (
              <li key={a.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Estrelas nota={a.nota} />
                  <span className="text-sm font-medium text-ink">{a.autor ?? 'Cliente'}</span>
                  {a.cidade && <span className="text-xs text-ink-muted">· {a.cidade}</span>}
                  <span className="ml-auto text-[11px] uppercase tracking-wide text-primary-strong">
                    compra verificada
                  </span>
                </div>
                {a.comentario && (
                  <p className="mt-2 text-body font-light leading-relaxed text-ink-soft">
                    {a.comentario}
                  </p>
                )}
                <p className="mt-2 text-xs text-ink-muted">
                  {[a.cor, a.tamanho && `tam ${a.tamanho}`, dataCurta(a.data)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
