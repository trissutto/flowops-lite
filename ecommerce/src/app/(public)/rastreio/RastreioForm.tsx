'use client';

import { useState } from 'react';

/**
 * O formulário do rastreio — agora com a resposta DENTRO do site (06/09).
 *
 * O código consulta `GET /api/rastreio/:code` (BFF → `/public/rastreio/:code`
 * do backend, que lê SÓ o cache `rastreio_objetos`). A resposta é o estado
 * atual do objeto — o cache guarda o último evento, não a timeline, então
 * prometemos exatamente o que temos: onde está, quando foi visto, previsão,
 * entregue. O link dos Correios segue como complemento ("ver cada passo"),
 * não mais como única resposta.
 *
 * ⚠️ O código dos Correios tem forma fixa: 2 letras + 9 dígitos + 2 letras
 * (`AA123456789BR`). Validar aqui evita a viagem mais frustrante possível —
 * descobrir só na resposta que digitou errado.
 */
const FORMATO_SRO = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

type StatusDoObjeto = {
  encontrado: boolean;
  codigo: string;
  status?: string | null;
  local?: string | null;
  eventoEm?: string | null;
  previsaoEm?: string | null;
  entregue?: boolean;
  entregueEm?: string | null;
  atualizadoEm?: string | null;
};

function linkCorreios(codigo: string) {
  return `https://rastreamento.correios.com.br/app/index.php?objeto=${encodeURIComponent(codigo)}`;
}

function quando(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dia(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
}

export function RastreioForm() {
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [resultado, setResultado] = useState<StatusDoObjeto | null>(null);
  const [foraDoAr, setForaDoAr] = useState<string | null>(null);

  function limpar(v: string) {
    // Espaço e hífen são o jeito que a cliente copia do WhatsApp.
    return v.replace(/[\s-]/g, '').toUpperCase();
  }

  async function enviar(e: React.FormEvent) {
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
    setConsultando(true);
    setResultado(null);
    setForaDoAr(null);
    try {
      const r = await fetch(`/api/rastreio/${limpo}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setResultado((await r.json()) as StatusDoObjeto);
    } catch {
      /**
       * Backend fora do ar não pode deixar a cliente sem resposta nenhuma.
       * ⚠️ NÃO é `window.open`: depois de um await demorado a ativação do
       * clique expira e o Chrome bloqueia o popup EM SILÊNCIO — a cliente
       * ficaria olhando o botão voltar pro normal sem nada acontecer. O
       * fallback é um LINK renderizado, que clique nenhum bloqueia.
       */
      setForaDoAr(limpo);
    } finally {
      setConsultando(false);
    }
  }

  return (
    <div>
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
            disabled={consultando}
            className="shrink-0 rounded-full bg-neutral-900 px-7 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-60"
          >
            {consultando ? 'Consultando…' : 'Rastrear'}
          </button>
        </div>
        {erro ? (
          <p id="codigo-erro" role="alert" className="mt-2 text-sm text-red-700">
            {erro}
          </p>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">
            A resposta aparece aqui mesmo, sem sair do site.
          </p>
        )}
      </form>

      {foraDoAr && (
        <div role="status" className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5">
          <p className="text-base text-neutral-900">Nossa consulta está fora do ar agora.</p>
          <p className="mt-2 text-sm text-neutral-600">
            Você pode ver o rastreio direto no site dos Correios:
          </p>
          <a
            href={linkCorreios(foraDoAr)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-sm font-medium text-neutral-900 underline underline-offset-4 hover:text-neutral-600"
          >
            Consultar nos Correios ↗
          </a>
        </div>
      )}

      {resultado && (
        <div
          role="status"
          className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5"
        >
          {resultado.encontrado ? (
            <>
              <p
                className={
                  resultado.entregue
                    ? 'inline-block rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium tracking-wide text-emerald-700 uppercase'
                    : 'inline-block rounded-full bg-amber-50 px-3 py-1 text-xs font-medium tracking-wide text-amber-800 uppercase'
                }
              >
                {resultado.entregue ? 'Entregue' : 'A caminho'}
              </p>

              <p className="mt-3 text-base text-neutral-900">
                {resultado.entregue
                  ? `Sua encomenda foi entregue${dia(resultado.entregueEm) ? ` em ${dia(resultado.entregueEm)}` : ''}. 💛`
                  : (resultado.status ?? 'Postada — aguardando o primeiro movimento dos Correios.')}
              </p>

              <dl className="mt-3 space-y-1 text-sm text-neutral-600">
                {!resultado.entregue && resultado.local && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium text-neutral-500">Onde:</dt>
                    <dd>{resultado.local}</dd>
                  </div>
                )}
                {!resultado.entregue && quando(resultado.eventoEm) && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium text-neutral-500">Visto em:</dt>
                    <dd>{quando(resultado.eventoEm)}</dd>
                  </div>
                )}
                {!resultado.entregue && dia(resultado.previsaoEm) && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium text-neutral-500">Previsão:</dt>
                    <dd>{dia(resultado.previsaoEm)}</dd>
                  </div>
                )}
              </dl>

              <a
                href={linkCorreios(resultado.codigo)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block text-sm font-medium text-neutral-900 underline underline-offset-4 hover:text-neutral-600"
              >
                Ver cada passo nos Correios ↗
              </a>
            </>
          ) : (
            <>
              <p className="text-base text-neutral-900">
                Ainda não temos esse código por aqui.
              </p>
              <p className="mt-2 text-sm text-neutral-600">
                Se a etiqueta acabou de ser criada, o primeiro movimento pode levar algumas
                horas pra aparecer. Você também pode conferir direto nos Correios:
              </p>
              <a
                href={linkCorreios(resultado.codigo)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-sm font-medium text-neutral-900 underline underline-offset-4 hover:text-neutral-600"
              >
                Consultar nos Correios ↗
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
