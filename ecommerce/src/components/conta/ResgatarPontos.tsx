'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * TROCAR PONTOS POR DESCONTO.
 *
 * O resgate gera um cupom NOMINAL — só o CPF dela usa. É a mesma máquina do
 * vale-troca (`site_cupons` com CPF), checada pelo backend no carrinho E no
 * fechamento: quem cobra é quem recalcula. Um segundo tipo de desconto seria
 * uma segunda regra de dinheiro pra manter em dia.
 *
 * O botão só aparece com saldo suficiente, e o resgate é em múltiplos exatos —
 * ninguém perde fração de ponto no arredondamento.
 */
export function ResgatarPontos({
  saldo,
  pontosPorReal,
  minimoResgate,
}: {
  saldo: number;
  pontosPorReal: number;
  minimoResgate: number;
}) {
  const maximo = Math.floor(saldo / pontosPorReal) * pontosPorReal;
  const [pontos, setPontos] = useState(maximo);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [cupom, setCupom] = useState<{ code: string; valor: number } | null>(null);

  async function resgatar() {
    setErro(null);
    setEnviando(true);
    try {
      const r = await fetch('/api/conta/pontos/resgatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pontos }),
      });
      const dados = await r.json();
      if (!r.ok || dados?.ok === false) throw new Error(dados?.erro || dados?.error || 'Não deu certo.');
      setCupom({ code: dados.code, valor: dados.valor });
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui gerar seu cupom.');
    } finally {
      setEnviando(false);
    }
  }

  if (cupom) {
    return (
      <div className="mt-5 rounded-sm border border-primary bg-primary-wash p-5">
        <p className="text-small text-muted">Seu cupom de R$ {cupom.valor},00</p>
        <p className="mt-1 select-all font-mono text-2xl tracking-wider text-ink">{cupom.code}</p>
        <p className="mt-2 text-small text-ink-soft">
          É só digitar no carrinho. Ele é seu — só funciona no seu CPF, e vale por 90 dias.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="pontos-resgate" className="text-small text-muted">
          Trocar
        </label>
        <select
          id="pontos-resgate"
          value={pontos}
          onChange={(e) => setPontos(Number(e.target.value))}
          className="rounded-sm border border-border bg-surface px-3 py-2 text-body"
        >
          {Array.from(
            { length: Math.floor((maximo - minimoResgate) / pontosPorReal) + 1 },
            (_, i) => minimoResgate + i * pontosPorReal,
          )
            .reverse()
            .map((p) => (
              <option key={p} value={p}>
                {p} pontos · R$ {Math.floor(p / pontosPorReal)},00
              </option>
            ))}
        </select>
        <button
          type="button"
          onClick={resgatar}
          disabled={enviando}
          className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3 text-button uppercase tracking-widest text-light transition hover:bg-primary-strong disabled:opacity-40"
        >
          {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
          Gerar cupom
        </button>
      </div>
      {erro && <p className="mt-2 text-small text-secondary">{erro}</p>}
    </div>
  );
}
