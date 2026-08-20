import Image from 'next/image';
import { Star } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { apiSafe } from '@/lib/api';

/**
 * O QUE DIZ QUEM LEVOU — a prova social que voltou, agora de verdade.
 *
 * A seção antiga saiu do ar em 06/08/2026: eram depoimentos assinados
 * "Cliente Lurds", com altura e peso inventados e as MESMAS quatro frases em
 * toda peça. Quem percebe isso passa a duvidar do preço e do estoque também.
 *
 * Esta só mostra o que uma cliente escreveu sobre uma peça que ela COMPROU —
 * o backend só aceita avaliação amarrada a um item de pedido entregue.
 *
 * Peça sem avaliação não rende seção nenhuma: "seja a primeira a avaliar" em
 * toda página é ruído que empurra o feed pra baixo e não vende.
 */

interface Avaliacao {
  id: string;
  nome: string;
  nota: number;
  texto: string | null;
  fotos: string[];
  cor: string | null;
  tamanho: string | null;
  caimento: string | null;
  alturaCm: number | null;
  pesoKg: number | null;
  data: string;
}

interface Resposta {
  total: number;
  media: number;
  distribuicao: Array<{ estrelas: number; quantas: number }>;
  caimento: { total: number; pequeno: number; fiel: number; grande: number };
  avaliacoes: Avaliacao[];
}

/**
 * Abaixo disto, porcentagem mente: "100% disseram que veste fiel" com duas
 * respostas é um número que a cliente confere e perde a confiança.
 */
const MINIMO_PRA_CAIMENTO = 3;

const VAZIO: Resposta = {
  total: 0,
  media: 0,
  distribuicao: [],
  caimento: { total: 0, pequeno: 0, fiel: 0, grande: 0 },
  avaliacoes: [],
};

function Estrelas({ nota, className = '' }: { nota: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`} aria-label={`${nota} de 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`size-4 ${n <= Math.round(nota) ? 'fill-primary text-primary' : 'text-border-strong'}`}
          strokeWidth={1.5}
        />
      ))}
    </span>
  );
}

export async function AvaliacoesDaPeca({ slug }: { slug: string }) {
  // Catálogo fora do ar não pode derrubar a página do produto — a lição da
  // live de 01/07 vale pra toda dependência: falha vira seção ausente.
  const dados = await apiSafe<Resposta>(`/public/loja/avaliacoes/${encodeURIComponent(slug)}`, VAZIO, {
    revalidate: 300,
  });

  if (!dados.total) return null;

  const fiel = dados.caimento.total >= MINIMO_PRA_CAIMENTO
    ? Math.round((dados.caimento.fiel / dados.caimento.total) * 100)
    : null;

  return (
    <Section tone="alt" space="sm" width="text" aria-labelledby="avaliacoes-titulo">
      <SectionTitle
        id="avaliacoes-titulo"
        eyebrow="Avaliações"
        title="Quem levou, conta"
        align="left"
      />

      <div className="mt-8 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <p className="text-h2 tabular-nums leading-none">
            {dados.media.toFixed(1).replace('.', ',')}
          </p>
          <Estrelas nota={dados.media} className="mt-2" />
          <p className="mt-1 text-small text-ink-muted">
            {dados.total} {dados.total === 1 ? 'avaliação' : 'avaliações'}
          </p>
        </div>

        <div className="min-w-[12rem] flex-1">
          {dados.distribuicao.map((d) => {
            const pct = dados.total ? Math.round((d.quantas / dados.total) * 100) : 0;
            return (
              <div key={d.estrelas} className="flex items-center gap-2 py-0.5">
                <span className="w-3 text-small tabular-nums text-ink-muted">{d.estrelas}</span>
                <Star className="size-3 fill-primary text-primary" strokeWidth={1.5} />
                <span className="h-1.5 flex-1 overflow-hidden rounded-pill bg-champagne">
                  <span
                    className="block h-full rounded-pill bg-primary"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="w-6 text-right text-small tabular-nums text-ink-muted">
                  {d.quantas}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {fiel !== null && (
        <p className="mt-6 rounded-sm border border-border bg-surface px-4 py-3 text-body text-ink-soft">
          <strong className="font-medium text-ink">{fiel}%</strong> disseram que a peça veste
          fiel ao tamanho.
        </p>
      )}

      <ul className="mt-8 divide-y divide-border border-t border-border">
        {dados.avaliacoes.map((a) => (
          <li key={a.id} className="py-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-body font-medium">{a.nome}</p>
              <Estrelas nota={a.nota} />
            </div>

            <p className="mt-1 text-small text-ink-muted">
              {[
                a.tamanho ? `Comprou ${a.tamanho}` : null,
                a.cor,
                // Altura e peso só aparecem quando a cliente autorizou — é
                // o dado que mais ajuda a decidir tamanho e o mais pessoal
                // que ela entrega.
                a.alturaCm && a.pesoKg ? `${a.alturaCm} cm · ${a.pesoKg} kg` : null,
                new Date(a.data).toLocaleDateString('pt-BR'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>

            {a.texto && <p className="mt-3 text-body font-light text-ink-soft">{a.texto}</p>}

            {a.fotos.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {a.fotos.map((url) => (
                  <Image
                    key={url}
                    src={url}
                    alt={`Foto de ${a.nome}`}
                    width={96}
                    height={128}
                    className="h-32 w-24 rounded-sm object-cover"
                    unoptimized
                  />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-6 text-small text-ink-muted">
        Só quem comprou a peça pode avaliar. Quem avalia ganha pontos na conta — o prêmio é por
        avaliar, não por elogiar.
      </p>
    </Section>
  );
}
