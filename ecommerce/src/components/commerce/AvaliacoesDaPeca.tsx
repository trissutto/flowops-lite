import Image from 'next/image';
import { FlaskConical, Star } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { apiSafe } from '@/lib/api';
import { AVALIACOES_DEMO } from '@/services/avaliacoes';

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

/**
 * CONJUNTO DE EXEMPLO — ligado só por `NEXT_PUBLIC_AVALIACOES_DEMO=1`.
 *
 * ⚠️ NÃO É AVALIAÇÃO DE CLIENTE, e a tela diz isso em cima, em letra grande.
 * Existe por um motivo só: a seção nunca pôde ser vista, porque a loja ainda
 * não tem avaliação nenhuma, e desenho que ninguém viu não se aprova. Com a
 * flag ligada dá pra olhar a página pronta e decidir.
 *
 * O que ele NÃO faz, de propósito:
 *  - não vira `aggregateRating` no JSON-LD (nota falsa no Google derruba o
 *    rich snippet do domínio inteiro, não só da peça);
 *  - não acende as estrelas do topo da PDP (a nota do `BuyBox` vem de
 *    `resumoDeAvaliacoes`, que só lê o banco);
 *  - não aparece sem o aviso.
 *
 * COMO ISTO SE ENCHE DE AVALIAÇÃO REAL: sozinho. O `PosVendaConviteCron` já
 * roda de hora em hora e manda "como ficou?" no WhatsApp alguns dias depois
 * de cada entrega confirmada pelo rastreio. Não existe script de disparo em
 * massa aqui de propósito — convidar em lote quem recebeu semanas atrás foi
 * exatamente o que o dono vetou em 22/08, quando a reconciliação do rastreio
 * fechou 255 pedidos de uma vez.
 */
const EXEMPLO: Resposta = {
  total: 4,
  media: 5,
  distribuicao: [
    { estrelas: 5, quantas: 4 },
    { estrelas: 4, quantas: 0 },
    { estrelas: 3, quantas: 0 },
    { estrelas: 2, quantas: 0 },
    { estrelas: 1, quantas: 0 },
  ],
  caimento: { total: 4, pequeno: 0, fiel: 4, grande: 0 },
  avaliacoes: [
    {
      id: 'exemplo-1',
      nome: 'Exemplo A.',
      nota: 5,
      texto:
        'Texto de exemplo para conferir o desenho da seção. Aqui apareceria o que a cliente escreveu sobre o caimento da peça.',
      fotos: [],
      cor: 'Preto',
      tamanho: '52',
      caimento: 'fiel',
      alturaCm: 165,
      pesoKg: 92,
      data: '2026-08-20',
    },
    {
      id: 'exemplo-2',
      nome: 'Exemplo B.',
      nota: 5,
      texto: 'Texto de exemplo, curto, para ver como fica uma avaliação de uma linha só.',
      fotos: [],
      cor: 'Marrom',
      tamanho: '56',
      caimento: 'fiel',
      alturaCm: null,
      pesoKg: null,
      data: '2026-08-18',
    },
    {
      id: 'exemplo-3',
      nome: 'Exemplo C.',
      nota: 5,
      texto: null,
      fotos: [],
      cor: 'Royal',
      tamanho: '48',
      caimento: 'fiel',
      alturaCm: 172,
      pesoKg: 88,
      data: '2026-08-15',
    },
    {
      id: 'exemplo-4',
      nome: 'Exemplo D.',
      nota: 5,
      texto:
        'Texto de exemplo mais longo, para conferir a quebra de linha e o espaçamento quando a cliente escreve um parágrafo inteiro contando como a peça vestiu, com que ela combinou e se recomendaria para outra pessoa do mesmo manequim.',
      fotos: [],
      cor: 'Preto',
      tamanho: '54',
      caimento: 'fiel',
      alturaCm: 160,
      pesoKg: 95,
      data: '2026-08-11',
    },
  ],
};

function AvisoDeExemplo() {
  return (
    <p className="mt-6 flex items-start gap-2.5 rounded-sm border border-warning/40 bg-warning/10 px-4 py-3 text-small text-ink">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.75} />
      <span>
        <strong className="font-medium">Avaliações de exemplo.</strong> Nenhuma destas foi
        escrita por uma cliente — servem só para conferir o desenho da seção. Desligue com{' '}
        <code>NEXT_PUBLIC_AVALIACOES_DEMO=0</code>.
      </span>
    </p>
  );
}

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
  const reais = await apiSafe<Resposta>(`/public/loja/avaliacoes/${encodeURIComponent(slug)}`, VAZIO, {
    revalidate: 300,
  });

  /**
   * O exemplo só entra quando NÃO há avaliação real — avaliação de verdade
   * sempre vence, e nunca se misturam na mesma lista.
   */
  const usandoExemplo = AVALIACOES_DEMO && !reais.total;
  const dados = usandoExemplo ? EXEMPLO : reais;

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

      {usandoExemplo && <AvisoDeExemplo />}

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
