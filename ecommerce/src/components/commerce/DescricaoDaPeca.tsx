'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A DESCRIÇÃO DA PEÇA, DOBRADA EM 4 LINHAS (dono, 12/08/2026).
 *
 * A descrição da ficha é escrita pra vender e passa de 40 linhas em peça bem
 * cadastrada — "Detalhes da Peça / Modelo / Estampa / Decote / Manga / Cintura
 * / Comprimento / Como Usar". Solta na página, ela empurra pro rodapé tudo que
 * decide a compra (tamanhos, entrega, trocas) e faz a seção parecer um manual.
 *
 * Aqui ela abre em 4 linhas e o resto fica atrás do "Ver mais". Quem quer o
 * detalhe clica; quem quer o preço e o tamanho não rola nada.
 *
 * DECISÕES:
 *
 * 1. O RESUMO fica sempre visível. É a linha que nomeia a peça ("Vestido Longo
 *    Plus Size ... Poá Preto") — cortá-la seria esconder justamente o que
 *    responde "é isso mesmo que eu quero?".
 *
 * 2. O botão SÓ APARECE quando há corte de verdade. Descrição de três linhas
 *    com um "Ver mais" que não revela nada é ruído — e ruído repetido em toda
 *    peça ensina a cliente a ignorar o botão quando ele importa.
 *
 * 3. A medição roda de novo quando a largura muda (`ResizeObserver`): o texto
 *    que cabe em 4 linhas no desktop ocupa 9 no celular. Medir só na montagem
 *    deixaria o botão faltando exatamente onde o corte é maior.
 */

/** Linhas visíveis antes do "Ver mais". */
const LINHAS = 4;
/** `--text-body--line-height` do tema (globals.css). Em `em`, é a altura de uma linha. */
const ALTURA_DA_LINHA = 1.7;

export function DescricaoDaPeca({
  resumo,
  texto,
}: {
  resumo?: string | null;
  texto?: string | null;
}) {
  const [aberto, setAberto] = useState(false);
  const [temCorte, setTemCorte] = useState(false);
  const alvo = useRef<HTMLParagraphElement>(null);

  const medir = useCallback(() => {
    const el = alvo.current;
    // Aberto, `scrollHeight === clientHeight` e a medida diria "não corta" —
    // o botão "Ver menos" sumiria no instante em que fosse usado.
    if (!el || aberto) return;
    // Folga de 4px: arredondamento de subpixel do navegador cria diferença de
    // 1px em texto que cabe inteiro, e isso acenderia o botão à toa.
    setTemCorte(el.scrollHeight - el.clientHeight > 4);
  }, [aberto]);

  useEffect(() => {
    const el = alvo.current;
    if (!el) return;
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, [medir, texto]);

  if (!resumo && !texto) {
    return (
      <p className="text-body font-light text-ink-soft">
        Peça da curadoria Lurd&apos;s. Para detalhes de composição e caimento, fale com uma
        consultora — ela conhece a peça na mão.
      </p>
    );
  }

  return (
    <div>
      {resumo && <p className="text-body-lg font-light text-ink-soft">{resumo}</p>}

      {texto && texto !== resumo && (
        <>
          <p
            ref={alvo}
            id="descricao-da-peca"
            className={`mt-5 text-body font-light text-ink-soft ${aberto ? '' : 'overflow-hidden'}`}
            style={aberto ? undefined : { maxHeight: `${LINHAS * ALTURA_DA_LINHA}em` }}
          >
            {texto}
          </p>

          {temCorte && (
            <button
              type="button"
              onClick={() => setAberto((v) => !v)}
              aria-expanded={aberto}
              aria-controls="descricao-da-peca"
              className="mt-3 text-small text-ink-soft underline decoration-border underline-offset-4 transition-colors hover:text-ink"
            >
              {aberto ? 'Ver menos' : 'Ver mais'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
