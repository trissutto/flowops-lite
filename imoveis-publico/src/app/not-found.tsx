import { Building2 } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="access-page">
      <div className="access-card">
        <div className="brand-mark"><Building2 /></div>
        <h1>Ficha indisponível</h1>
        <p>Este endereço não existe ou deixou de ser compartilhado. Solicite um link atualizado.</p>
      </div>
    </main>
  );
}
