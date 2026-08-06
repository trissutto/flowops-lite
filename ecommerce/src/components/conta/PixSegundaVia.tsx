'use client';

import { useState } from 'react';
import { Check, Copy, QrCode } from 'lucide-react';

/**
 * SEGUNDA VIA DO PIX (item 65).
 *
 * A cliente fecha o pedido, o QR aparece uma vez, ela fecha a aba — e não tem
 * mais como pagar. Hoje o caminho é o WhatsApp: alguém gera de novo, em
 * horário comercial, se responder. Enquanto isso o pedido vence sozinho.
 *
 * O botão entrega o copia-e-cola, que é o que o app do banco aceita. Não
 * redesenhamos o QR aqui de propósito: quem está em "Meus pedidos" já está no
 * celular, e apontar a câmera pra própria tela não funciona.
 *
 * Só aparece enquanto o código VALE — o backend não devolve vencido. Copia-e-
 * cola expirado é pior que nenhum: a cliente cola, o banco recusa, e ela acha
 * que a loja errou.
 */
export function PixSegundaVia({ copyPaste, expiresAt }: { copyPaste: string; expiresAt: string }) {
  const [copiado, setCopiado] = useState(false);

  const vence = new Date(expiresAt);
  const valido = Number.isFinite(vence.getTime());

  async function copiar() {
    try {
      await navigator.clipboard.writeText(copyPaste);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      // Clipboard bloqueado (iOS antigo, contexto inseguro): seleciona o texto
      // pra cliente copiar na mão em vez de deixar o botão morto.
      const campo = document.getElementById('pix-copia-cola') as HTMLInputElement | null;
      campo?.select();
    }
  }

  return (
    <div className="mt-2 rounded-sm border border-border bg-surface-alt/60 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-small font-medium text-ink">
        <QrCode className="size-3.5 text-primary-strong" strokeWidth={1.75} />
        Pix ainda aberto
        {valido && (
          <span className="font-light text-ink-muted">
            · vale até {vence.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </p>

      <div className="mt-2 flex items-center gap-2">
        {/* readOnly, não disabled: campo desabilitado não deixa selecionar,
            e a seleção é justamente o plano B do clipboard. */}
        <input
          id="pix-copia-cola"
          readOnly
          value={copyPaste}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full min-w-0 flex-1 truncate rounded-sm border border-border bg-surface px-2.5 py-1.5 text-small text-ink-soft"
        />
        <button
          type="button"
          onClick={() => void copiar()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-small font-medium text-ink transition-colors hover:border-border-strong"
        >
          {copiado ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          {copiado ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}
