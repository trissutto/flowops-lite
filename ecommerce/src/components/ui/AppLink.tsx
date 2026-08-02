import NextLink from 'next/link';
import { isBuiltRoute } from '@/lib/routes';

/**
 * Substituto do `next/link` em toda a navegação da vitrine.
 *
 * Só faz uma coisa: não prefetcha rota que ainda não existe (ver
 * `lib/routes.ts`). Fora isso é o `Link` do Next, com a mesma API — quem
 * passar `prefetch` explícito continua mandando.
 *
 * Não é client component de propósito: assim continua utilizável dentro de
 * Server Components sem arrastar a árvore pro cliente.
 */
type AppLinkProps = React.ComponentProps<typeof NextLink>;

export function AppLink({ href, prefetch, ...rest }: AppLinkProps) {
  return (
    <NextLink
      href={href}
      prefetch={prefetch ?? (isBuiltRoute(href) ? undefined : false)}
      {...rest}
    />
  );
}
