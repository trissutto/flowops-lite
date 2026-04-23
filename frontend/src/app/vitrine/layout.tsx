/**
 * Layout específico da /vitrine — anula o padding-left da sidebar aplicado
 * no layout.tsx raiz.
 *
 * O root layout injeta <div className="md:pl-60"> pra não sobrepor a sidebar
 * de matriz. Na vitrine (simula site público), a sidebar é escondida e o
 * conteúdo precisa ocupar 100% da largura.
 *
 * Solução: este layout aninhado aplica uma margem negativa equivalente no
 * desktop pra cancelar o padding do pai. Simples e reversível.
 */
export default function VitrineLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="md:-ml-60 md:w-[calc(100%+15rem)]">
      {children}
    </div>
  );
}
