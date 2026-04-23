/**
 * Layout da /vitrine — passthrough.
 *
 * No passado cancelava o `md:pl-60` do root layout (sidebar fixa). A sidebar
 * foi removida, então esse layout ficou apenas como ponto de extensão futuro
 * (metadata custom, tema, analytics) — hoje só repassa os children.
 */
export default function VitrineLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
