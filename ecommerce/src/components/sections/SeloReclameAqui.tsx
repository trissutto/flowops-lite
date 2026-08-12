import { ExternalLink, MessageSquareWarning } from 'lucide-react';

/**
 * RECLAME AQUI — link pra reputação REAL, não logo emprestado.
 *
 * O dono pediu o selo do RA em 12/08/2026 e mandou o endereço da empresa lá.
 * O que entra aqui é um LINK pra página pública: a cliente clica e lê a
 * reputação na fonte, com a nota do dia.
 *
 * ── O QUE NÃO ENTRA, E POR QUÊ ──
 *
 * O logotipo do RA e a nota escrita na página ("Nota 8.5 · Ótimo") não são
 * nossos pra publicar: o selo oficial é gerado no painel do RA e é ele que
 * carrega a nota viva. Nota copiada à mão envelhece no dia seguinte — e nota
 * desatualizada no rodapé é pior que nenhuma, porque a cliente confere.
 *
 * Quando alguém entrar no painel e pegar o código do selo, ele substitui este
 * link: mesmo lugar, mesma função, com a marca deles autorizada por eles.
 *
 * `NEXT_PUBLIC_RECLAME_AQUI_URL` sobrescreve o endereço sem deploy de código;
 * vazio explicitamente ('') esconde o selo.
 */

const URL_PADRAO = 'https://www.reclameaqui.com.br/empresa/lurds-plus-size/lista-reclamacoes/';

export function SeloReclameAqui({ className = '' }: { className?: string }) {
  const url = process.env.NEXT_PUBLIC_RECLAME_AQUI_URL ?? URL_PADRAO;
  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      // `noopener` é segurança (a aba nova não ganha acesso a esta janela);
      // `nofollow` porque é link de terceiro, não recomendação de SEO.
      rel="noopener noreferrer nofollow"
      className={`inline-flex items-center gap-2 text-small font-light text-ink-soft transition-colors hover:text-ink ${className}`}
    >
      <MessageSquareWarning
        className="size-4 shrink-0 text-primary-strong"
        strokeWidth={1.75}
        aria-hidden
      />
      Nossa reputação no Reclame Aqui
      <ExternalLink className="size-3 shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden />
    </a>
  );
}
