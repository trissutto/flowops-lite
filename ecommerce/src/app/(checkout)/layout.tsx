import type { Metadata } from 'next';
import Link from 'next/link';
import { LockKeyhole } from 'lucide-react';
import { Logo } from '@/components/navigation/Logo';

/**
 * Chrome do grupo (checkout) — o MÍNIMO possível, de propósito.
 *
 * A spec do checkout exige foco absoluto: sem menu, sem busca, sem banner,
 * sem footer completo. Cada link a mais aqui é uma porta de saída no momento
 * mais caro do funil. Fica só:
 *   - o logo centrado (âncora emocional + único caminho de volta)
 *   - o selo "Compra segura" (reforço de confiança onde a ansiedade mora)
 *   - uma linha de rodapé com CNPJ e termos (obrigação legal, não navegação)
 *
 * Os Providers (tracking, toasts, query) vêm do layout raiz — o funil de
 * eventos continua inteiro aqui dentro.
 */

export const metadata: Metadata = {
  title: "Checkout — Lurd's Plus Size",
  // Página transacional: nunca indexar.
  robots: { index: false, follow: false },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border bg-surface">
        {/* h-14 no celular (era h-20 em toda tela): 24px que a barra do logo
            tomava da dobra sem entregar nada além do próprio logo — o selo
            "Compra segura" já é `hidden` abaixo de sm. */}
        <div className="relative mx-auto flex h-14 max-w-page items-center justify-center px-gutter sm:h-20 lg:px-gutter-lg">
          <Logo variant="horizontal" />
          <span className="absolute right-gutter hidden items-center gap-2 text-small text-ink-muted sm:flex lg:right-gutter-lg">
            <LockKeyhole className="size-4 text-primary-strong" strokeWidth={1.5} />
            Compra segura
          </span>
        </div>
      </header>

      {/* #conteudo mantém o skip link do layout raiz funcionando. */}
      <main id="conteudo" className="flex-1">
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-page flex-col items-center justify-between gap-2 px-gutter py-5 text-caption font-normal tracking-normal normal-case text-ink-muted sm:flex-row lg:px-gutter-lg">
          <p>© {new Date().getFullYear()} Lurd&apos;s Plus Size · CNPJ 20.104.813/0001-39</p>
          <p className="flex gap-4">
            <Link href="/termos" className="link-underline">
              Termos
            </Link>
            <Link href="/privacidade" className="link-underline">
              Privacidade
            </Link>
            <Link href="/institucional/trocas" className="link-underline">
              Trocas
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
