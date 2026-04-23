'use client';

/**
 * /retaguarda/vendedoras
 *
 * CRUD de vendedoras (Karine, Manu, etc.) pra atribuir aos pedidos WC.
 *
 * Porquê: algumas clientes tiram dúvida com vendedora mas fecham no site.
 * Pra saber quanto cada uma vendeu online no fim do mês, o pedido WC ganha
 * uma "tag" de vendedora. Aqui é o cadastro dessas vendedoras.
 *
 * Soft-delete (active=false) mantém histórico de vendas passadas intacto.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Plus, Users, Phone, Check, X, Edit2, Trash2, Power,
} from 'lucide-react';
import { api } from '@/lib/api';

type Seller = {
  id: string;
  name: string;
  whatsapp: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export default function VendedorasPage() {
  const router = useRouter();
  const [items, setItems] = useState<Seller[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [novoNome, setNovoNome] = useState('');
  const [novoWhatsapp, setNovoWhatsapp] = useState('');
  const [criando, setCriando] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [editNome, setEditNome] = useState('');
  const [editWhatsapp, setEditWhatsapp] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Seller[]>(
        `/sellers${showInactive ? '?includeInactive=1' : ''}`,
      );
      setItems(Array.isArray(data) ? data : []);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('401')) {
        router.push('/login');
        return;
      }
      setError('Não foi possível carregar as vendedoras.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInactive]);

  const criar = async () => {
    const nome = novoNome.trim();
    if (!nome) {
      alert('Digite um nome.');
      return;
    }
    setCriando(true);
    try {
      await api('/sellers', {
        method: 'POST',
        body: JSON.stringify({ name: nome, whatsapp: novoWhatsapp.trim() || undefined }),
      });
      setNovoNome('');
      setNovoWhatsapp('');
      await load();
    } catch (err: any) {
      alert(`Erro ao criar: ${err?.message || err}`);
    } finally {
      setCriando(false);
    }
  };

  const iniciarEdicao = (s: Seller) => {
    setEditId(s.id);
    setEditNome(s.name);
    setEditWhatsapp(s.whatsapp || '');
  };

  const cancelarEdicao = () => {
    setEditId(null);
    setEditNome('');
    setEditWhatsapp('');
  };

  const salvarEdicao = async () => {
    if (!editId) return;
    const nome = editNome.trim();
    if (!nome) {
      alert('Nome não pode ficar vazio.');
      return;
    }
    try {
      await api(`/sellers/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: nome,
          whatsapp: editWhatsapp.trim() || null,
        }),
      });
      cancelarEdicao();
      await load();
    } catch (err: any) {
      alert(`Erro ao salvar: ${err?.message || err}`);
    }
  };

  const toggleAtivo = async (s: Seller) => {
    const msg = s.active
      ? `Desativar "${s.name}"? Ela some da lista de atribuição, mas o histórico de vendas dela fica preservado.`
      : `Reativar "${s.name}"?`;
    if (!confirm(msg)) return;
    try {
      await api(`/sellers/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !s.active }),
      });
      await load();
    } catch (err: any) {
      alert(`Erro: ${err?.message || err}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-5xl mx-auto">
          <Link href="/" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 font-bold">
              <Users className="w-5 h-5" />
              Vendedoras
            </div>
            <div className="text-xs opacity-80">
              Atendentes que influenciam venda online — usadas na atribuição de pedidos WC
            </div>
          </div>
          <button
            onClick={load}
            className="p-2 hover:bg-white/10 rounded"
            title="Atualizar"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-3 sm:p-4 space-y-3">
        {/* Criar */}
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="text-sm font-bold text-slate-800 mb-2 flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Cadastrar nova vendedora
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
            <input
              type="text"
              value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
              placeholder="Nome (ex: Karine)"
              maxLength={60}
              className="border border-slate-200 rounded-lg text-sm py-2 px-3 focus:outline-none focus:border-brand"
              onKeyDown={(e) => {
                if (e.key === 'Enter') criar();
              }}
            />
            <input
              type="text"
              value={novoWhatsapp}
              onChange={(e) => setNovoWhatsapp(e.target.value)}
              placeholder="WhatsApp (opcional)"
              className="border border-slate-200 rounded-lg text-sm py-2 px-3 focus:outline-none focus:border-brand"
              onKeyDown={(e) => {
                if (e.key === 'Enter') criar();
              }}
            />
            <button
              onClick={criar}
              disabled={criando || !novoNome.trim()}
              className="bg-brand text-white rounded-lg px-4 py-2 text-sm font-bold hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 justify-center"
            >
              <Plus className="w-4 h-4" /> Adicionar
            </button>
          </div>
        </div>

        {/* Toggle inativas */}
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Mostrar desativadas
          </label>
        </div>

        {/* Lista */}
        {error ? (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
            {error}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="text-center text-slate-500 py-10 text-sm">Carregando…</div>
        ) : items.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500 text-sm">
            Nenhuma vendedora cadastrada ainda. Comece adicionando acima.
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Nome</th>
                  <th className="text-left px-3 py-2">WhatsApp</th>
                  <th className="text-center px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Ações</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const editando = editId === s.id;
                  return (
                    <tr
                      key={s.id}
                      className={`border-t border-slate-100 ${!s.active ? 'bg-slate-50 text-slate-400' : ''}`}
                    >
                      <td className="px-3 py-2">
                        {editando ? (
                          <input
                            type="text"
                            value={editNome}
                            onChange={(e) => setEditNome(e.target.value)}
                            maxLength={60}
                            className="border border-slate-200 rounded text-sm py-1 px-2 w-full focus:outline-none focus:border-brand"
                          />
                        ) : (
                          <span className="font-semibold">{s.name}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {editando ? (
                          <input
                            type="text"
                            value={editWhatsapp}
                            onChange={(e) => setEditWhatsapp(e.target.value)}
                            placeholder="(opcional)"
                            className="border border-slate-200 rounded text-sm py-1 px-2 w-full focus:outline-none focus:border-brand"
                          />
                        ) : s.whatsapp ? (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                            <Phone className="w-3 h-3" /> {s.whatsapp}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {s.active ? (
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                            Ativa
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 border border-slate-300">
                            Desativada
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 justify-end">
                          {editando ? (
                            <>
                              <button
                                onClick={salvarEdicao}
                                className="p-1.5 rounded hover:bg-emerald-100 text-emerald-700"
                                title="Salvar"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                              <button
                                onClick={cancelarEdicao}
                                className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
                                title="Cancelar"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => iniciarEdicao(s)}
                                className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
                                title="Editar"
                                disabled={!s.active}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => toggleAtivo(s)}
                                className={`p-1.5 rounded hover:bg-slate-100 ${s.active ? 'text-amber-700' : 'text-emerald-700'}`}
                                title={s.active ? 'Desativar' : 'Reativar'}
                              >
                                <Power className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="text-xs text-slate-500 pt-2">
          <strong>Dica:</strong> para ver quanto cada uma vendeu no mês, abra{' '}
          <Link href="/relatorios/vendedoras" className="text-brand hover:underline font-semibold">
            /relatorios/vendedoras
          </Link>
          .
        </div>
      </main>
    </div>
  );
}
