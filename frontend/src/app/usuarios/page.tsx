'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Plus, Pencil, Trash2, Users as UsersIcon, X, KeyRound } from 'lucide-react';

type Role = 'admin' | 'operator' | 'store' | 'supervisor' | 'contador' | 'franquias';

interface Store {
  id: string;
  code: string;
  name: string;
}

interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  storeId: string | null;
  active: boolean;
  createdAt: string;
  store?: { id: string; code: string; name: string } | null;
}

interface EditingUser {
  id?: string;
  email: string;
  name: string;
  role: Role;
  storeId: string | null;
  active: boolean;
  password?: string;
}

const EMPTY: EditingUser = {
  email: '',
  name: '',
  role: 'operator',
  storeId: null,
  active: true,
  password: '',
};

const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  operator: 'Operador',
  store: 'Loja',
  supervisor: 'Supervisor',
  contador: 'Contador',
  franquias: 'Adm. Franquias',
};

const ROLE_COLORS: Record<Role, string> = {
  admin: 'bg-red-100 text-red-700',
  operator: 'bg-blue-100 text-blue-700',
  store: 'bg-green-100 text-green-700',
  supervisor: 'bg-amber-100 text-amber-700',
  contador: 'bg-violet-100 text-violet-700',
  franquias: 'bg-amber-100 text-amber-800',
};

export default function UsuariosPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [editing, setEditing] = useState<EditingUser | null>(null);
  const [resettingPwd, setResettingPwd] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError(null);
    try {
      const [usersData, storesData] = await Promise.all([
        api<User[]>('/users'),
        api<Store[]>('/stores'),
      ]);
      setUsers(usersData);
      setStores(storesData.filter((s: any) => s.active !== false));
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      if (editing.id) {
        // update (sem senha aqui)
        const payload: any = {
          email: editing.email,
          name: editing.name,
          role: editing.role,
          storeId: editing.role === 'store' ? editing.storeId : null,
          active: editing.active,
        };
        await api(`/users/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        // create
        const payload: any = {
          email: editing.email,
          name: editing.name,
          role: editing.role,
          storeId: editing.role === 'store' ? editing.storeId : null,
          password: editing.password,
          active: editing.active,
        };
        await api('/users', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setEditing(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetPassword() {
    if (!resettingPwd || !newPassword) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/users/${resettingPwd.id}/password`, {
        method: 'PATCH',
        body: JSON.stringify({ password: newPassword }),
      });
      setResettingPwd(null);
      setNewPassword('');
      alert('Senha redefinida com sucesso.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(u: User) {
    if (!confirm(`Remover o usuário ${u.name} (${u.email})?`)) return;
    setError(null);
    try {
      const res = await api<{ deleted: boolean; deactivated: boolean; reason?: string }>(
        `/users/${u.id}`,
        { method: 'DELETE' },
      );
      if (res.deactivated && res.reason) alert(res.reason);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  function openEdit(u: User) {
    setEditing({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      storeId: u.storeId,
      active: u.active,
    });
  }

  const canSave = Boolean(
    editing &&
      editing.email.trim() &&
      editing.name.trim() &&
      editing.role &&
      (editing.role !== 'store' || editing.storeId) &&
      (editing.id || (editing.password && editing.password.length >= 6)),
  );

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UsersIcon className="w-6 h-6" /> Usuários ({users.length})
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Gerencie quem pode acessar o sistema e com qual papel.
          </p>
        </div>
        <button
          onClick={() => setEditing({ ...EMPTY })}
          className="bg-brand text-white px-4 py-2 rounded hover:bg-brand-dark flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Novo usuário
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm">{error}</div>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3 text-left">Nome</th>
              <th className="p-3 text-left">Email</th>
              <th className="p-3 text-left">Papel</th>
              <th className="p-3 text-left">Loja</th>
              <th className="p-3 text-center">Ativo</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-400">
                  Nenhum usuário cadastrado.
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr
                key={u.id}
                className={`border-t hover:bg-slate-50 ${!u.active ? 'opacity-40' : ''}`}
              >
                <td className="p-3 font-medium">{u.name}</td>
                <td className="p-3 font-mono text-xs">{u.email}</td>
                <td className="p-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${ROLE_COLORS[u.role]}`}
                  >
                    {ROLE_LABELS[u.role]}
                  </span>
                </td>
                <td className="p-3 text-xs">
                  {u.store ? `${u.store.code} — ${u.store.name}` : '—'}
                </td>
                <td className="p-3 text-center">{u.active ? '✓' : '—'}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  <button
                    onClick={() => openEdit(u)}
                    className="text-slate-600 hover:text-brand p-1"
                    title="Editar"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setResettingPwd(u)}
                    className="text-slate-600 hover:text-brand p-1 ml-1"
                    title="Redefinir senha"
                  >
                    <KeyRound className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => remove(u)}
                    className="text-slate-600 hover:text-red-600 p-1 ml-1"
                    title="Remover"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* Modal criar/editar usuário */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-bold text-lg">
                {editing.id ? 'Editar usuário' : 'Novo usuário'}
              </h3>
              <button onClick={() => setEditing(null)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-sm max-h-[70vh] overflow-y-auto">
              <div>
                <label className="block font-medium mb-1">Nome *</label>
                <input
                  className="w-full border rounded px-3 py-2"
                  placeholder="Maria Silva"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-medium mb-1">Email *</label>
                <input
                  type="email"
                  className="w-full border rounded px-3 py-2"
                  placeholder="maria@empresa.com"
                  value={editing.email}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                />
                <p className="text-xs text-slate-500 mt-1">Será usado pra fazer login.</p>
              </div>

              <div>
                <label className="block font-medium mb-1">Papel *</label>
                <select
                  className="w-full border rounded px-3 py-2"
                  value={editing.role}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      role: e.target.value as Role,
                      storeId: e.target.value === 'store' ? editing.storeId : null,
                    })
                  }
                >
                  <option value="admin">Administrador — vê tudo, gerencia usuários</option>
                  <option value="operator">Operador — operação geral</option>
                  <option value="store">Loja — acesso restrito à loja vinculada</option>
                  <option value="supervisor">Supervisor — ve fiscal + operacional (sem config)</option>
                  <option value="contador">Contador — só relatório fiscal (notas + XMLs)</option>
                  <option value="franquias">Adm. Franquias — só leitura dos dados das franquias</option>
                </select>
              </div>

              {editing.role === 'store' && (
                <div>
                  <label className="block font-medium mb-1">Loja vinculada *</label>
                  <select
                    className="w-full border rounded px-3 py-2"
                    value={editing.storeId || ''}
                    onChange={(e) => setEditing({ ...editing, storeId: e.target.value || null })}
                  >
                    <option value="">-- escolha uma loja --</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} — {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!editing.id && (
                <div>
                  <label className="block font-medium mb-1">Senha inicial *</label>
                  <input
                    type="text"
                    className="w-full border rounded px-3 py-2 font-mono"
                    placeholder="mínimo 6 caracteres"
                    value={editing.password || ''}
                    onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Passa essa senha pro usuário. Ele pode trocar depois.
                  </p>
                </div>
              )}

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                Usuário ativo (pode fazer login)
              </label>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t bg-slate-50">
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 border rounded hover:bg-white"
              >
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={saving || !canSave}
                className="px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark disabled:opacity-50"
              >
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal redefinir senha */}
      {resettingPwd && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-bold text-lg">Redefinir senha</h3>
              <button
                onClick={() => {
                  setResettingPwd(null);
                  setNewPassword('');
                }}
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-sm">
              <p>
                Usuário: <strong>{resettingPwd.name}</strong> ({resettingPwd.email})
              </p>
              <div>
                <label className="block font-medium mb-1">Nova senha *</label>
                <input
                  type="text"
                  className="w-full border rounded px-3 py-2 font-mono"
                  placeholder="mínimo 6 caracteres"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t bg-slate-50">
              <button
                onClick={() => {
                  setResettingPwd(null);
                  setNewPassword('');
                }}
                className="px-4 py-2 border rounded hover:bg-white"
              >
                Cancelar
              </button>
              <button
                onClick={resetPassword}
                disabled={saving || newPassword.length < 6}
                className="px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark disabled:opacity-50"
              >
                {saving ? 'Salvando...' : 'Redefinir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
