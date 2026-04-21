'use client';

/**
 * Painel de logs de integração.
 * TODO: consumir GET /api/logs com filtros por source (woocommerce|erp) e por período.
 */
export default function LogsPage() {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">Logs de integração</h1>
      <p className="text-slate-600">
        Em breve: tabela com eventos in/out do WooCommerce e ERP, filtros por data e
        destaque para erros.
      </p>
    </div>
  );
}
