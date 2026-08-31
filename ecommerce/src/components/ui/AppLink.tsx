import NextLink from 'next/link';

/**
 * Substituto do `next/link` em toda a navegação da vitrine.
 *
 * O prefetch automático foi desligado por padrão depois de medição na home:
 * links visíveis do menu puxavam 40 KiB de uma rota com Framer Motion antes
 * do LCP. Quem tiver evidência de que uma navegação merece antecipação pode
 * continuar passando `prefetch` explicitamente.
 *
 * Não é client component de propósito: assim continua utilizável dentro de
 * Server Components sem arrastar a árvore pro cliente.
 */
type AppLinkProps = React.ComponentProps<typeof NextLink>;

export function AppLink({ href, prefetch, ...rest }: AppLinkProps) {
  return (
    <NextLink
      href={href}
      prefetch={prefetch ?? false}
      {...rest}
    />
  );
}
