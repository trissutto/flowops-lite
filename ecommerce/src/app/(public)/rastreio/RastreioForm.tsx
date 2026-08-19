'use client';

import { useState } from 'react';

/**
 * O formulário do rastreio.
 *
 * Leva o código pro rastreamento oficial dos Correios, em aba nova — a cliente
 * não perde a página da loja. Quando existir endpoint público de status (ver o
 * cabeçalho de `page.tsx`), esta função troca de destino sem mexer no resto.
 *
 * ⚠️ O código dos Correios tem forma fixa: 2 letras + 9 dígitos + 2 letras
 * (`AA123456789BR`). Validar aqui evita o caminho mais frustrante possível —
 * mandar a cliente pro site dos Correios pra ela descobrir lá que digitou
 * errado, e ter que voltar.
 */
const FORMATO_SRO = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

export function RastreioForm() {
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  function limpar(v: string) {
    // Espaço e hífen são o jeito que a cliente copia do WhatsApp.
    return v.replace(/[\s-]/g, '').toUpperCase();
  }

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    const limpo = limpar(codigo);

    if (!limpo) {
      setErro('Digite o código que você recebeu por WhatsApp ou e-mail.');
      return;
    }
    if (!FORMATO_SRO.test(limpo)) {
      setErro(
        'Esse código não parece dos Correios. Ele tem 13 caracteres, assim: AA123456789BR.',
      );
      return;
    }

    setErro(null);
    window.open(
      `https://rastreamento.correios.com.br/app/index.php?objeto=${encodeURIComponent(limpo)}`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  return (
    <form onSubmit={enviar} noValidate>
      <label htmlFor="codigo" className="block text-sm font-medium text-neutral-900">
        Código de rastreio
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id="codigo"
          name="codigo"
          value={codigo}
          onChange={(e) => {
            setCodigo(e.target.value);
            if (erro) setErro(null);
          }}
          placeholder="AA123456789BR"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? 'codigo-erro' : undefined}
          className="w-full rounded-full border border-neutral-300 px-5 py-3 text-base uppercase tracking-wide outline-none focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10"
        />
        <button
          type="submit"
          className="shrink-0 rounded-full bg-neutral-900 px-7 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
        >
          Rastrear
        </button>
      </div>
      {erro ? (
        <p id="codigo-erro" role="alert" className="mt-2 text-sm text-red-700">
          {erro}
        </p>
      ) : (
        <p className="mt-2 text-sm text-neutral-500">
          A consulta abre no site dos Correios, em outra aba.
        </p>
      )}
    </form>
  );
}
