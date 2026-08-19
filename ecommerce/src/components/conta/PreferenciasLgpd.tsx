'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * O QUE VOCÊ AUTORIZA RECEBER (item 67).
 *
 * Cada clique vira uma LINHA NOVA no CRM, com data e IP — o histórico nunca é
 * sobrescrito. É ele que responde "quando ela autorizou?" numa fiscalização;
 * atualizar a linha anterior apagaria justamente a prova.
 *
 * Aviso de pedido e nota fiscal NÃO aparecem aqui: são execução da compra, não
 * marketing, e não dependem de autorização. Misturar os dois faria a cliente
 * desmarcar tudo e depois reclamar que não recebeu o rastreio.
 *
 * Otimista na tela e revertendo no erro: esperar o servidor pra mover um
 * interruptor faz a cliente clicar duas vezes e desfazer o que acabou de fazer.
 */

interface Canal {
  channel: string;
  rotulo: string;
  granted: boolean;
  em: string | null;
}

export function PreferenciasLgpd() {
  const [canais, setCanais] = useState<Canal[] | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    fetch('/api/conta/consentimentos')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (vivo) setCanais(d?.canais ?? []);
      })
      .catch(() => {
        if (vivo) setCanais([]);
      });
    return () => {
      vivo = false;
    };
  }, []);

  async function alternar(canal: Canal) {
    const novo = !canal.granted;
    setErro(null);
    setSalvando(canal.channel);
    setCanais((l) =>
      (l ?? []).map((c) => (c.channel === canal.channel ? { ...c, granted: novo } : c)),
    );

    try {
      const res = await fetch('/api/conta/consentimentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: canal.channel, granted: novo }),
      });
      if (!res.ok) throw new Error();
      const d = await res.json();
      if (d?.canais) setCanais(d.canais);
    } catch {
      // Reverte: interruptor que ficou ligado sem ter salvo é pior que erro.
      setCanais((l) =>
        (l ?? []).map((c) => (c.channel === canal.channel ? { ...c, granted: !novo } : c)),
      );
      setErro('Não consegui salvar sua preferência. Tente de novo em instantes.');
    } finally {
      setSalvando(null);
    }
  }

  if (canais === null) {
    return (
      <p className="flex items-center gap-2 text-small text-ink-muted">
        <Loader2 className="size-4 animate-spin" /> Carregando…
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-border border-y border-border">
        {canais.map((c) => (
          <li key={c.channel} className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0">
              <p className="text-body">{c.rotulo}</p>
              {c.em && (
                <p className="text-small text-ink-muted">
                  {c.granted ? 'Autorizado' : 'Recusado'} em{' '}
                  {new Date(c.em).toLocaleDateString('pt-BR')}
                </p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={c.granted}
              aria-label={c.rotulo}
              disabled={salvando === c.channel}
              onClick={() => void alternar(c)}
              className={`relative h-6 w-11 shrink-0 rounded-pill transition-colors duration-[180ms] disabled:opacity-50 ${
                c.granted ? 'bg-primary' : 'bg-border'
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-0.5 size-5 rounded-pill bg-light transition-transform duration-[180ms] ${
                  c.granted ? 'translate-x-[22px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </li>
        ))}
      </ul>

      {erro && (
        <p role="alert" className="mt-3 text-small text-danger">
          {erro}
        </p>
      )}

      <p className="mt-4 text-small text-ink-muted">
        Avisos do seu pedido e nota fiscal continuam chegando — eles fazem parte da
        compra e não dependem desta escolha.
      </p>
    </div>
  );
}
