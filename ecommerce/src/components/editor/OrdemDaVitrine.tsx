'use client';

/**
 * ORDEM DA VITRINE — arrastar as peças na ordem que a cliente vai ver, de
 * dentro da própria página da categoria (dono, 18/08/2026).
 *
 * ── POR QUE UMA LISTA, E NÃO A GRADE ──
 *
 * Ele escolheu lista quando perguntei. Arrastar card grande numa grade de 4
 * colunas move uma peça por vez e obriga a rolar; a lista compacta (foto de
 * 48px + nome) mostra ~12 peças na tela e move a 20ª pro topo num gesto só.
 * A grade continua sendo o que a cliente vê — a lista é a mesa de trabalho.
 *
 * ── QUEM VÊ ──
 *
 * Ninguém, até provar que é admin. O botão só aparece depois que
 * `/api/editor/session` confirma a sessão (o mesmo login por e-mail e senha do
 * CRM que o editor de produto já usa). Cliente nunca vê nada disso — e o
 * carimbo é do servidor, não um `if` no navegador.
 *
 * ── O QUE ACONTECE COM QUEM NÃO FOI ARRASTADO ──
 *
 * Vai depois, na ordem de Novidades. Peça nova não pode sumir da vitrine só
 * porque ninguém a moveu ainda — e salvar a lista vazia devolve a categoria
 * inteira pro automático.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, GripVertical, Loader2, RotateCcw, Save, X } from 'lucide-react';

type Peca = { ref: string; name: string; image?: string | null; price?: number | null };

export function OrdemDaVitrine({
  categoria, pecas, onSalvo,
}: {
  categoria: string;
  /** As peças COMO ESTÃO na vitrine agora — a ordem que ele vai ajustar. */
  pecas: Peca[];
  onSalvo?: () => void;
}) {
  const [podeEditar, setPodeEditar] = useState(false);
  const [aberto, setAberto] = useState(false);
  const [lista, setLista] = useState<Peca[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const arrastado = useRef<string | null>(null);

  // A sessão é conferida no servidor. Falhou? O botão simplesmente não existe.
  useEffect(() => {
    fetch('/api/editor/session', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setPodeEditar(Boolean(s?.editor)))
      .catch(() => {});
  }, []);

  const abrir = useCallback(() => {
    setLista(pecas);
    setAviso(null);
    setAberto(true);
  }, [pecas]);

  function soltarEm(ref: string) {
    const de = arrastado.current;
    arrastado.current = null;
    if (!de || de === ref) return;
    setLista((atual) => {
      const copia = [...atual];
      const iDe = copia.findIndex((p) => p.ref === de);
      const iPara = copia.findIndex((p) => p.ref === ref);
      if (iDe < 0 || iPara < 0) return atual;
      copia.splice(iPara, 0, ...copia.splice(iDe, 1));
      return copia;
    });
  }

  /** Mandar pro topo: com 240 peças, arrastar da posição 80 até em cima é sofrimento. */
  function paraOTopo(ref: string) {
    setLista((atual) => {
      const i = atual.findIndex((p) => p.ref === ref);
      if (i <= 0) return atual;
      const copia = [...atual];
      copia.unshift(...copia.splice(i, 1));
      return copia;
    });
  }

  async function salvar(refs: string[] | null) {
    setSalvando(true);
    setAviso(null);
    try {
      const r = await fetch(`/api/editor/ordem-categoria/${encodeURIComponent(categoria)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // `null` = voltar ao automático (o backend apaga a linha).
        body: JSON.stringify({ refs: refs ?? [] }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Não consegui salvar');
      setAviso(refs ? 'Ordem salva — a vitrine já mudou.' : 'Voltou pra ordem automática.');
      onSalvo?.();
    } catch (e: unknown) {
      setAviso((e as Error)?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  if (!podeEditar) return null;

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={abrir}
        className="fixed right-4 bottom-24 z-40 flex items-center gap-2 rounded-pill bg-ink px-4 py-2.5 text-[0.6875rem] font-medium tracking-[0.14em] text-light uppercase shadow-lg"
      >
        <GripVertical className="size-3.5" /> Ordenar vitrine
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/40">
      <div className="flex h-full w-full max-w-md flex-col bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <p className="text-[0.6875rem] font-medium tracking-[0.14em] text-ink-muted uppercase">
              Ordem da vitrine
            </p>
            <p className="text-body font-medium text-ink">{categoria}</p>
          </div>
          <button type="button" onClick={() => setAberto(false)} aria-label="Fechar"
            className="flex size-9 items-center justify-center rounded-pill hover:bg-border/40">
            <X className="size-4" />
          </button>
        </div>

        <p className="border-b border-border px-5 py-2 text-[0.6875rem] text-ink-soft">
          Arraste pra ordenar · a seta manda pro topo · quem você não mover entra depois, por
          novidade
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {lista.map((p, i) => (
            <div
              key={p.ref}
              draggable
              onDragStart={() => { arrastado.current = p.ref; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); soltarEm(p.ref); }}
              className="flex cursor-grab items-center gap-3 border-b border-border/60 px-4 py-2 active:cursor-grabbing hover:bg-border/20"
            >
              <span className="w-6 shrink-0 text-right text-[0.6875rem] tabular-nums text-ink-muted">
                {i + 1}
              </span>
              <GripVertical className="size-4 shrink-0 text-ink-muted" />
              {/* Miniatura de 48px numa tela de trabalho: o next/image aqui só
                  somaria requisição de otimização pra imagem que já veio na
                  grade da cliente. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.image ? (
                <img src={p.image} alt="" className="size-12 shrink-0 rounded-xs object-cover" />
              ) : (
                <span className="size-12 shrink-0 rounded-xs bg-border/40" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small text-ink">{p.name}</span>
                <span className="block font-mono text-[0.625rem] text-ink-muted">{p.ref}</span>
              </span>
              <button type="button" onClick={() => paraOTopo(p.ref)} aria-label="Mandar pro topo"
                className="flex size-8 shrink-0 items-center justify-center rounded-pill text-ink-muted hover:bg-border/40 hover:text-ink">
                <ArrowUp className="size-4" />
              </button>
            </div>
          ))}
        </div>

        {aviso && <p className="px-5 py-2 text-small text-ink-soft">{aviso}</p>}

        <div className="flex items-center gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={() => void salvar(lista.map((p) => p.ref))}
            disabled={salvando}
            className="flex flex-1 items-center justify-center gap-2 rounded-xs bg-ink px-4 py-3 text-[0.6875rem] font-medium tracking-[0.14em] text-light uppercase disabled:opacity-50"
          >
            {salvando ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Salvar ordem
          </button>
          <button
            type="button"
            onClick={() => void salvar(null)}
            disabled={salvando}
            title="Voltar pra ordem automática desta categoria"
            className="flex items-center gap-1.5 rounded-xs border border-border px-3 py-3 text-[0.6875rem] font-medium tracking-[0.14em] text-ink-soft uppercase disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" /> Automático
          </button>
        </div>
      </div>
    </div>
  );
}
