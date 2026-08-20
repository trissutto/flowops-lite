import { Section } from '@/components/layout/Section';
import { ListaDeDesejos } from '@/components/conta/ListaDeDesejos';
import { buildMetadata } from '@/lib/seo';

/**
 * LISTA DE DESEJOS (item 69).
 *
 * O coração já existia no card e na PDP, e o store já guardava — não havia
 * onde VER o que foi guardado. Coração que não leva a lugar nenhum é botão
 * decorativo: a cliente clica, volta depois, e não encontra a peça.
 *
 * Fica fora do login de propósito: guardar peça é o gesto de quem AINDA não
 * decidiu, e exigir cadastro nesse momento é onde se perde a intenção. A
 * página vive em `/conta` porque é ali que ela vai procurar.
 */

export const metadata = buildMetadata({
  title: 'Lista de desejos',
  path: '/conta/favoritos',
  noIndex: true,
});

export default function FavoritosPage() {
  return (
    <Section space="lg">
      <header className="mb-8">
        <p className="eyebrow text-ink-muted">Minha conta</p>
        <h1 className="text-h2">Lista de desejos</h1>
      </header>
      <ListaDeDesejos />
    </Section>
  );
}
