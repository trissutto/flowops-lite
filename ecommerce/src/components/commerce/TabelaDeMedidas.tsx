'use client';

import { useCallback, useState } from 'react';
import Image from 'next/image';
import { Modal } from '@/components/ui/Modal';

/**
 * TABELA DE MEDIDAS DA PDP — o modal, o que vai dentro dele e o link que abre.
 *
 * Nasceu de um relato de "a tabela não abre / não aparece direito" que ia e
 * voltava (25/09). Não era UM defeito: eram três janelas em que o toque na
 * tabela não entregava a tabela, todas dependentes de TEMPO — por isso o
 * mesmo teste passava num dia e falhava no outro.
 *
 * 1. A IMAGEM SÓ COMEÇAVA A CARREGAR NO CLIQUE. O painel do modal fica sempre
 *    montado e invisível (regra da casa, ver `Overlay`), e o `loading="lazy"`
 *    do next/image não dispara pra imagem invisível — então o pedido só saía
 *    quando a cliente abria. Em 4G fraco ela via o título e um retângulo
 *    branco por alguns segundos, e fechava achando que não abriu. Agora a
 *    imagem é pedida ANTES, quando o passo do tamanho chega perto da tela
 *    (`preparar`), e enquanto não chega o modal DIZ que está carregando. Se o
 *    otimizador de imagem da Vercel falhar, o PNG cru entra no lugar; se nem
 *    ele vier, um link abre a imagem direto.
 * 2. O BANNER DE COOKIES (z 80) subia POR CIMA do modal (z 70), 8 s depois de
 *    carregar a página, só pra quem ainda não tinha decidido — no celular ele
 *    cobria a metade de baixo da tabela. Resolvido em `useLockScroll`
 *    (`data-overlay-open` no `<html>`) + `ConsentBanner`.
 * 3. TOQUE ANTES DA HIDRATAÇÃO. A PDP carrega ~264 KB de JS comprimido (809 KB
 *    reais); até ele rodar, um `<button>` é um botão morto e o toque some sem
 *    nenhum erro. O gatilho agora é um LINK pro próprio PNG: sem JS (ou antes
 *    dele) o toque abre a imagem da tabela; com JS, o `preventDefault` segura
 *    a navegação e abre o modal. O alvo de toque também sobe de 16–20 px pra
 *    30–44 px sem mexer no desenho (padding compensado por margem negativa).
 *
 * O CONTEÚDO e o desenho do modal não mudaram: mesmo título, mesma imagem,
 * mesma largura. Só a robustez de abrir e mostrar.
 */

const IMAGEM = '/images/guia-tamanhos/tabela-medidas-lurds.png';
const LARGURA = 750;
const ALTURA = 1075;
const ALT = "Tabela de medidas Lurd's para os tamanhos 46 a 60";

/**
 * `carregando` → `pronta` é o caminho normal. Erro do otimizador cai em
 * `sem-otimizador` (PNG cru, `unoptimized`); erro do PNG cru cai em `falhou`
 * (texto + link). Nunca um retângulo branco sem explicação.
 */
type Estado = 'carregando' | 'pronta' | 'sem-otimizador' | 'falhou';

export function TabelaDeMedidas({
  open,
  onClose,
  preparar = false,
}: {
  open: boolean;
  onClose: () => void;
  /** Pede a imagem antes do clique — o passo do tamanho entrou na tela. */
  preparar?: boolean;
}) {
  const [estado, setEstado] = useState<Estado>('carregando');
  const crua = estado === 'sem-otimizador';
  // Identidade estável de propósito: o next/image guarda `onError` nas
  // dependências do ref do <img> e, a cada identidade nova, reatribui
  // `img.src = img.src` (é o contorno dele pra erro perdido antes da
  // hidratação). Com função inline isso rodava a cada re-render do BuyBox —
  // toda troca de tamanho. Estável, roda uma vez.
  const aoCarregar = useCallback(() => setEstado('pronta'), []);
  const aoFalhar = useCallback(
    () => setEstado((atual) => (atual === 'sem-otimizador' ? 'falhou' : 'sem-otimizador')),
    [],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Tabela de medidas"
      title="Tabela de medidas"
      size="lg"
      /* `svh` e não `vh`: no Safari do iPhone `94vh` inclui a área atrás da
         barra de endereço, e o pé do modal (o fim da tabela) ficava escondido
         embaixo dela. `svh` é a altura com as barras abertas — o modal cabe
         inteiro. No PC os dois são a mesma coisa. */
      className="max-h-[94svh]"
    >
      {/* A caixa reserva a PROPORÇÃO da imagem antes dela chegar: o modal já
          abre do tamanho certo e não pula quando a imagem entra. */}
      <div className="relative mx-auto aspect-[750/1075] w-full max-w-[750px]">
        {estado !== 'falhou' && (
          <Image
            // Trocar a chave remonta o <img>: é o que faz o navegador tentar
            // de novo com o PNG cru depois que o otimizador falhou.
            key={crua ? 'crua' : 'otimizada'}
            src={IMAGEM}
            alt={ALT}
            width={LARGURA}
            height={ALTURA}
            sizes="(max-width: 640px) 88vw, 750px"
            // `lazy` → `eager` faz o navegador RETOMAR o carregamento adiado
            // (é o comportamento definido na spec pra troca do atributo).
            loading={open || preparar ? 'eager' : 'lazy'}
            unoptimized={crua}
            onLoad={aoCarregar}
            onError={aoFalhar}
            className="h-auto w-full"
          />
        )}
        {(estado === 'carregando' || crua) && (
          <p
            role="status"
            className="absolute inset-0 flex items-center justify-center text-small text-ink-soft"
          >
            Carregando a tabela…
          </p>
        )}
        {estado === 'falhou' && (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-body text-ink-soft"
          >
            <p>Não conseguimos carregar a imagem da tabela agora.</p>
            <a
              href={IMAGEM}
              target="_blank"
              rel="noopener"
              className="text-ink underline decoration-border underline-offset-4"
            >
              Abrir a tabela em outra aba
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * O GATILHO. Um `<a>` pro PNG, não um `<button>`: antes da hidratação (ou sem
 * JavaScript) o toque ainda entrega a tabela — abre a imagem — em vez de
 * morrer calado. Depois da hidratação o `preventDefault` segura a navegação
 * e o modal abre como sempre. As classes vêm de quem chama, porque cada um
 * dos três lugares (passo do tamanho, folha de tamanhos, barra fixa) tem o
 * próprio desenho.
 */
export function AbrirTabelaDeMedidas({
  onAbrir,
  className,
  children,
}: {
  onAbrir: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={IMAGEM}
      onClick={(e) => {
        e.preventDefault();
        onAbrir();
      }}
      className={className}
    >
      {children}
    </a>
  );
}
