'use client';

import { Check, CircleDot, ExternalLink, MapPin, Package, Truck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VolumeDoPedido } from '@/types/checkout';

/**
 * ONDE ESTÁ A MINHA PEÇA — respondido DENTRO do site.
 *
 * Até 22/08/2026 a resposta era um aviso: "a consulta abre no site dos
 * Correios, em outra aba". A cliente ansiosa — que abre esta página cinco
 * vezes por dia — era mandada embora, pra um site que ela não conhece, com um
 * código pra colar. Enquanto isso o Flow já tinha o dado: o `RastreioSyncCron`
 * mantém `rastreio_objetos` atualizada de 30 em 30 minutos, com cascata
 * Correios → Mais Envios → LinkeTrack.
 *
 * O QUE MOSTRA, E O QUE NÃO MOSTRA. O cache guarda o ÚLTIMO evento, não o
 * histórico — então aqui é o estado atual (onde está, quando foi visto,
 * previsão) e não uma linha do tempo completa. Prometer histórico que não
 * existe seria pior; o link dos Correios continua ali pra quem quiser cada
 * passo, agora como complemento e não como resposta.
 *
 * PEDIDO DIVIDIDO É O CASO DIFÍCIL. Quando as peças saem de lojas diferentes,
 * cada caixa tem código próprio e chega em dia diferente. A cliente recebia
 * duas mensagens sem nenhuma tela que juntasse as duas e achava que o pedido
 * tinha sido duplicado ou errado. Aqui é "Caixa 1 de 2" e "Caixa 2 de 2", cada
 * uma com o seu estado — e o resumo diz quantas já chegaram.
 */

function quando(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
    ' às ' +
    d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function dia(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
}

function CaixaDoPedido({ v, dividido }: { v: VolumeDoPedido; dividido: boolean }) {
  return (
    <li className="rounded-md border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="flex items-center gap-2 text-small font-medium text-ink">
          {v.entregue ? (
            <Check className="size-4 text-success" strokeWidth={2} />
          ) : (
            <Truck className="size-4 text-primary-strong" strokeWidth={1.75} />
          )}
          {dividido ? `Caixa ${v.posicao} de ${v.total}` : 'Sua encomenda'}
          {v.loja && <span className="font-normal text-ink-muted">· saiu de {v.loja}</span>}
        </p>
        <span
          className={cn(
            'rounded-pill px-2.5 py-1 text-[0.6875rem] font-medium tracking-[0.08em] uppercase',
            v.entregue ? 'bg-accent-wash text-success' : 'bg-primary-wash text-primary-strong',
          )}
        >
          {v.entregue ? 'Entregue' : v.status ? 'A caminho' : 'Postada'}
        </span>
      </div>

      {/* O ESTADO, em uma frase. Sem status no cache (objeto recém-postado, ou
          etiqueta de outro contrato que o SRO não conhece) a caixa não fica
          muda: diz que foi postada e que a atualização vem. */}
      <p className="mt-3 text-body font-light text-ink-soft">
        {v.entregue
          ? `Entregue${v.entregueEm ? ` em ${dia(v.entregueEm)}` : ''}.`
          : v.status
            ? v.status
            : 'Postada. O primeiro registro dos Correios costuma aparecer em até 1 dia útil.'}
      </p>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-small text-ink-muted">
        {v.local && !v.entregue && (
          <div className="flex items-center gap-1.5">
            <MapPin className="size-3.5" strokeWidth={1.75} />
            <dd>{v.local}</dd>
          </div>
        )}
        {v.eventoEm && !v.entregue && (
          <div className="flex items-center gap-1.5">
            <CircleDot className="size-3.5" strokeWidth={1.75} />
            <dd>Visto em {quando(v.eventoEm)}</dd>
          </div>
        )}
        {v.previsaoEm && !v.entregue && (
          <div className="flex items-center gap-1.5">
            <Package className="size-3.5" strokeWidth={1.75} />
            <dd>Previsão: {dia(v.previsaoEm)}</dd>
          </div>
        )}
      </dl>

      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption font-normal tracking-normal normal-case text-ink-muted">
        <span className="tabular">{v.codigo}</span>
        <a
          href={v.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline-offset-4 hover:text-ink hover:underline"
        >
          ver cada passo nos Correios
          <ExternalLink className="size-3" strokeWidth={1.75} />
        </a>
      </p>
    </li>
  );
}

export function RastreioDoPedido({ volumes }: { volumes: VolumeDoPedido[] }) {
  if (!volumes.length) return null;

  const dividido = volumes.length > 1;
  const entregues = volumes.filter((v) => v.entregue).length;

  return (
    <section className="mx-auto mt-6 max-w-text" aria-labelledby="rastreio-titulo">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="rastreio-titulo" className="font-display text-h4 text-ink">
          Onde está sua peça
        </h2>
        {dividido && (
          <p className="tabular text-small text-ink-muted">
            {entregues} de {volumes.length} caixas entregues
          </p>
        )}
      </div>

      {/* A EXPLICAÇÃO DO PEDIDO DIVIDIDO VEM ANTES DAS CAIXAS, não depois:
          quem abre e vê "Caixa 1 de 2" sem contexto acha que comprou duas
          vezes. Uma linha resolve a dúvida antes de ela nascer. */}
      {dividido && (
        <p className="mt-2 text-small font-light text-ink-soft">
          Suas peças saíram de lojas diferentes, então vêm em mais de uma caixa — e podem chegar em
          dias diferentes. Nada foi cobrado a mais por isso.
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-3">
        {volumes.map((v) => (
          <CaixaDoPedido key={v.codigo} v={v} dividido={dividido} />
        ))}
      </ul>
    </section>
  );
}
