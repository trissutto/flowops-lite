import { AppLink as Link } from '@/components/ui/AppLink';
import { MapPin, MessageCircle } from 'lucide-react';
import { InstagramIcon } from '@/components/ui/icons';
import { Container } from './Container';
import { Logo } from '@/components/navigation/Logo';
import { legalLinks } from '@/data/navigation';
import { filtrarLinksVivos } from '@/lib/routes';

/**
 * Footer — minimalista, muito organizado. Quatro colunas de links, uma linha
 * institucional e os ícones sociais. Nada de muro de texto.
 *
 * As colunas abaixo descrevem o rodapé do desenho FINAL da loja; boa parte
 * dessas páginas ainda não existe. `filtrarLinksVivos` esconde o que levaria a
 * 404 e a coluna que ficar vazia não é renderizada — cada página que nascer
 * reaparece sozinha aqui (ver `lib/routes.ts`). Manter a lista completa é de
 * propósito: ela é o mapa do que falta construir.
 */

const COLUMNS = [
  {
    title: 'Comprar',
    links: [
      { label: 'Novidades', href: '/novidades' },
      { label: 'Vestidos', href: '/categoria/vestidos' },
      { label: 'Looks completos', href: '/looks' },
      { label: 'Por ocasião', href: '/ocasioes' },
      { label: 'Outlet', href: '/outlet' },
    ],
  },
  {
    title: 'Ajuda',
    links: [
      { label: 'Guia de medidas', href: '/tamanhos/guia' },
      { label: 'Trocas e devoluções', href: '/institucional/trocas' },
      { label: 'Formas de pagamento', href: '/institucional/pagamento' },
      { label: 'Prazos e frete', href: '/institucional/frete' },
      { label: 'Perguntas frequentes', href: '/institucional/faq' },
    ],
  },
  {
    title: 'A Lurds',
    links: [
      { label: 'Nossa história', href: '/institucional/sobre' },
      { label: 'Nossas lojas', href: '/lojas' },
      { label: 'Comprar e retirar', href: '/lojas/comprar-e-retirar' },
      { label: 'Trabalhe com a gente', href: '/institucional/trabalhe-conosco' },
      { label: 'Blog', href: '/blog' },
    ],
  },
  {
    title: 'Minha conta',
    links: [
      { label: 'Entrar', href: '/conta' },
      { label: 'Meus pedidos', href: '/conta/pedidos' },
      { label: 'Favoritos', href: '/conta/favoritos' },
      { label: 'Meus endereços', href: '/conta/enderecos' },
    ],
  },
];

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-surface-alt">
      <Container width="wide" className="py-section-sm">
        <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
          {/* Marca */}
          <div>
            <Logo variant="horizontal" className="justify-start" />
            <p className="mt-6 max-w-xs text-body font-light text-ink-soft">
              Moda plus size elegante do 46 ao 60. Peças que vestem super bem e um atendimento que
              acolhe — online e em 14 lojas.
            </p>
            <div className="mt-7 flex items-center gap-2">
              <Link
                href="https://www.instagram.com/lurdsplussize"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Instagram da Lurds"
                className="inline-flex size-10 items-center justify-center rounded-pill border border-border text-ink-soft transition-colors hover:border-primary hover:text-primary-strong"
              >
                <InstagramIcon className="size-4" strokeWidth={1.5} />
              </Link>
              <Link
                href="https://api.whatsapp.com/send?phone=5513996050174"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="WhatsApp da Lurds"
                className="inline-flex size-10 items-center justify-center rounded-pill border border-border text-ink-soft transition-colors hover:border-success hover:text-success"
              >
                <MessageCircle className="size-4" strokeWidth={1.5} />
              </Link>
              <Link
                href="/lojas"
                aria-label="Nossas lojas"
                className="inline-flex size-10 items-center justify-center rounded-pill border border-border text-ink-soft transition-colors hover:border-primary hover:text-primary-strong"
              >
                <MapPin className="size-4" strokeWidth={1.5} />
              </Link>
            </div>
          </div>

          {/* Links */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-4">
            {COLUMNS.map((column) => {
              const links = filtrarLinksVivos(column.links);
              if (links.length === 0) return null;
              return (
                <nav key={column.title} aria-label={column.title}>
                  <p className="eyebrow text-primary-strong">{column.title}</p>
                  <ul className="mt-5 flex flex-col gap-3">
                    {links.map((link) => (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className="link-underline text-small font-light text-ink-soft transition-colors hover:text-ink"
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              );
            })}
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-4 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-small font-light text-ink-muted">
            © {year} Lurd&apos;s Plus Size · CNPJ 20.104.813/0001-39
          </p>
          {/* ⚠️ Apontavam pra /institucional/privacidade e /institucional/termos,
              que NÃO EXISTEM — 404 nos dois links legais do rodapé, que são
              justamente os que precisam estar publicados e alcançáveis. */}
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {legalLinks.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-small font-light text-ink-muted transition-colors hover:text-ink"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </Container>
    </footer>
  );
}
