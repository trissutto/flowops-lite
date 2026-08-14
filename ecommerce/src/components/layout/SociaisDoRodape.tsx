'use client';

import { MessageCircle } from 'lucide-react';
import { InstagramIcon } from '@/components/ui/icons';
import { trackInstagramClick, trackWhatsAppClick } from '@/lib/tracking';
import { LINK_WHATSAPP_SITE } from '@/data/contato';

/**
 * OS DOIS CANAIS DA MARCA NO RODAPÉ — e por que viraram componente próprio.
 *
 * Estes cliques não eram medidos em lugar NENHUM (13/08/2026). Não apareciam
 * nem como "sem loja" na tela de cliques: o `<a>` era cru, sem `onClick`. Todo
 * botão de Instagram e WhatsApp do site é instrumentado menos estes dois, que
 * ficam na página que mais recebe gente.
 *
 * O `Footer` é server component e evento de clique só existe no cliente —
 * daí a ilha. Fica só isto do lado do cliente; o resto do rodapé continua
 * renderizando no servidor.
 *
 * SEM UNIDADE, de propósito: o @lurdsplussize e o WhatsApp de atendimento são
 * da MARCA, não de uma loja. Caem na linha "Marca — @lurdsplussize" do
 * relatório, junto com o grid de Instagram da home. A origem (`rodape`)
 * separa um do outro no banco.
 *
 * O link do WhatsApp vem de `LINK_WHATSAPP_SITE` e não é remontado aqui: o
 * texto "vim pelo site" é o contrato de parse da automação que vira lead.
 *
 * O terceiro ícone (Nossas lojas) ficou de fora: é link interno pra `/lojas`,
 * e aquela página já mede o que a cliente faz lá dentro. Medir aqui contaria
 * a mesma intenção duas vezes.
 */
const CIRCULO =
  'inline-flex size-10 items-center justify-center rounded-pill border border-border text-ink-soft transition-colors';

export function SociaisDoRodape() {
  return (
    <>
      <a
        href="https://www.instagram.com/lurdsplussize"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Instagram da Lurds"
        onClick={() => trackInstagramClick('rodape')}
        className={`${CIRCULO} hover:border-primary hover:text-primary-strong`}
      >
        <InstagramIcon className="size-4" strokeWidth={1.5} />
      </a>
      <a
        href={LINK_WHATSAPP_SITE}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="WhatsApp da Lurds"
        onClick={() => trackWhatsAppClick('rodape')}
        className={`${CIRCULO} hover:border-success hover:text-success`}
      >
        <MessageCircle className="size-4" strokeWidth={1.5} />
      </a>
    </>
  );
}
