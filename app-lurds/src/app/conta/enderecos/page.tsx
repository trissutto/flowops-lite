'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, MapPin, Star, Loader2, Plus, Pencil, Trash2,
  X, AlertCircle, CheckCircle2,
} from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import {
  getAddresses, createAddress, updateAddress, deleteAddress, lookupCep,
  isLoggedIn, type AppAddress, type AddressPayload,
} from '@/lib/api';

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'residential', label: '🏠 Residencial' },
  { value: 'delivery',    label: '📦 Entrega' },
  { value: 'work',        label: '💼 Trabalho' },
  { value: 'mailing',     label: '📬 Correspondência' },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

export default function EnderecosPage() {
  const router = useRouter();
  const [list, setList] = useState<AppAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAddr, setEditingAddr] = useState<AppAddress | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/entrar?next=/conta/enderecos');
      return;
    }
    refresh();
  }, [router]);

  const refresh = () => {
    setLoading(true);
    getAddresses()
      .then((r) => setList(r.addresses))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Tem certeza que quer remover esse endereço?')) return;
    try {
      await deleteAddress(id);
      refresh();
    } catch (e: any) {
      alert(e?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/conta" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Meus endereços</h1>
      </header>

      {loading && (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-8 h-8 animate-spin mx-auto" />
        </div>
      )}

      {!loading && (
        <div className="mt-5 px-5">
          {/* Botão NOVO no topo, sempre visível */}
          <button
            onClick={() => setShowNew(true)}
            className="btn-gold-lg w-full mb-4"
          >
            <Plus className="w-5 h-5" /> Cadastrar novo endereço
          </button>

          {list.length === 0 ? (
            <div className="mt-8 text-center px-4">
              <MapPin className="w-14 h-14 mx-auto text-gold/40" />
              <h2 className="font-serif text-lg font-bold mt-3">Sem endereços ainda</h2>
              <p className="text-sm text-cream/60 mt-2">
                Cadastra seu endereço pra agilizar suas compras e ver opções de retirada na loja perto de você.
              </p>
            </div>
          ) : (
            <>
              <p className="text-[11px] text-cream/50 uppercase tracking-wider font-bold px-1 mb-2">
                {list.length} endereço{list.length > 1 ? 's' : ''}
              </p>
              <div className="space-y-3">
                {list.map((a) => (
                  <div key={a.id} className={`card-dark ${a.isPrimary ? 'border-gold/40' : ''}`}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-gold">
                        {TYPE_LABEL[a.type] || a.type}
                      </span>
                      {a.isPrimary && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gold">
                          <Star className="w-3 h-3 fill-gold" /> Principal
                        </span>
                      )}
                    </div>
                    <div className="text-sm space-y-0.5">
                      <div className="font-bold">
                        {a.street}{a.number ? `, ${a.number}` : ''}
                        {a.complement && <span className="text-cream/60"> · {a.complement}</span>}
                      </div>
                      {a.district && <div className="text-cream/70">{a.district}</div>}
                      <div className="text-cream/60">
                        {a.city}{a.state ? ` — ${a.state}` : ''}
                        {a.cep && <span className="text-cream/40 ml-2">CEP {a.cep}</span>}
                      </div>
                      {a.reference && (
                        <div className="text-xs text-cream/50 mt-1.5 italic">
                          Ref.: {a.reference}
                        </div>
                      )}
                    </div>

                    {/* Ações */}
                    <div className="mt-3 pt-3 border-t border-ink-600 flex gap-2">
                      <button
                        onClick={() => setEditingAddr(a)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-bold py-2 rounded-lg bg-ink-700 hover:bg-ink-600 transition"
                      >
                        <Pencil className="w-3.5 h-3.5" /> Editar
                      </button>
                      <button
                        onClick={() => handleDelete(a.id)}
                        className="px-3 py-2 rounded-lg bg-rose-900/30 hover:bg-rose-900/50 text-rose-300 transition"
                        aria-label="Remover"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <BottomNav />

      {/* Modais */}
      {(editingAddr || showNew) && (
        <AddressFormModal
          address={editingAddr}
          onClose={() => { setEditingAddr(null); setShowNew(false); }}
          onSaved={() => { setEditingAddr(null); setShowNew(false); refresh(); }}
        />
      )}
    </div>
  );
}

/* ══════════════════ MODAL FORMULÁRIO ══════════════════ */
function AddressFormModal({
  address, onClose, onSaved,
}: {
  address: AppAddress | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!address;
  const [type, setType] = useState(address?.type || 'residential');
  const [cep, setCep] = useState(address?.cep || '');
  const [street, setStreet] = useState(address?.street || '');
  const [number, setNumber] = useState(address?.number || '');
  const [complement, setComplement] = useState(address?.complement || '');
  const [district, setDistrict] = useState(address?.district || '');
  const [city, setCity] = useState(address?.city || '');
  const [state, setState] = useState(address?.state || '');
  const [reference, setReference] = useState(address?.reference || '');
  const [isPrimary, setIsPrimary] = useState(address?.isPrimary || false);

  const [saving, setSaving] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Auto-lookup CEP ao completar 8 dígitos
  const handleCepChange = async (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    const formatted = digits.length > 5
      ? `${digits.slice(0, 5)}-${digits.slice(5, 8)}`
      : digits;
    setCep(formatted);
    if (digits.length === 8) {
      setCepLoading(true);
      setErr(null);
      try {
        const r = await lookupCep(digits);
        if (r.street) setStreet(r.street);
        if (r.district) setDistrict(r.district);
        if (r.city) setCity(r.city);
        if (r.state) setState(r.state);
      } catch (e: any) {
        setErr(e?.message || 'CEP não encontrado');
      } finally {
        setCepLoading(false);
      }
    }
  };

  const handleSave = async () => {
    setErr(null);
    if (!street.trim()) { setErr('Logradouro obrigatório'); return; }
    if (!number.trim()) { setErr('Número obrigatório'); return; }
    if (!city.trim()) { setErr('Cidade obrigatória'); return; }
    if (!state.trim()) { setErr('Estado obrigatório'); return; }

    const payload: AddressPayload = {
      type,
      cep: cep.replace(/\D/g, '') || undefined,
      street: street.trim(),
      number: number.trim(),
      complement: complement.trim() || undefined,
      district: district.trim() || undefined,
      city: city.trim(),
      state: state.trim().toUpperCase().slice(0, 2),
      reference: reference.trim() || undefined,
      isPrimary,
    };

    setSaving(true);
    try {
      if (editing && address) {
        await updateAddress(address.id, payload);
      } else {
        await createAddress(payload);
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-ink/85 backdrop-blur-sm flex items-end sm:items-center justify-center overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md mx-0 sm:mx-4 bg-ink-800 sm:border sm:border-gold/30 rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-serif text-xl font-black text-gold">
            {editing ? 'Editar endereço' : 'Novo endereço'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="p-2 rounded-full bg-ink-700 hover:bg-ink-600 transition"
          >
            <X className="w-5 h-5 text-cream" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Tipo */}
          <div>
            <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
              Tipo
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="input-dark w-full"
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* CEP */}
          <div>
            <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold flex items-center justify-between">
              <span>CEP</span>
              {cepLoading && <Loader2 className="w-3 h-3 animate-spin text-gold" />}
            </label>
            <input
              type="tel"
              inputMode="numeric"
              value={cep}
              onChange={(e) => handleCepChange(e.target.value)}
              placeholder="00000-000"
              maxLength={9}
              className="input-dark w-full"
              autoComplete="postal-code"
            />
            <p className="text-[10px] text-cream/40 mt-1">
              Digita o CEP e a gente completa o resto 💛
            </p>
          </div>

          {/* Rua + Número */}
          <div className="grid grid-cols-[1fr_90px] gap-2">
            <div>
              <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
                Rua/Av
              </label>
              <input
                type="text"
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                placeholder="Av. Brasil"
                className="input-dark w-full"
                autoComplete="address-line1"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
                Nº
              </label>
              <input
                type="text"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="123"
                className="input-dark w-full"
              />
            </div>
          </div>

          {/* Complemento */}
          <div>
            <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
              Complemento <span className="text-cream/30 normal-case">(opcional)</span>
            </label>
            <input
              type="text"
              value={complement}
              onChange={(e) => setComplement(e.target.value)}
              placeholder="Apto 101, Bloco B…"
              className="input-dark w-full"
              autoComplete="address-line2"
            />
          </div>

          {/* Bairro */}
          <div>
            <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
              Bairro
            </label>
            <input
              type="text"
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              placeholder="Centro"
              className="input-dark w-full"
            />
          </div>

          {/* Cidade + UF */}
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <div>
              <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
                Cidade
              </label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="São Paulo"
                className="input-dark w-full"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
                UF
              </label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="SP"
                maxLength={2}
                className="input-dark w-full uppercase"
              />
            </div>
          </div>

          {/* Ponto de referência */}
          <div>
            <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
              Ponto de referência <span className="text-cream/30 normal-case">(opcional)</span>
            </label>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Casa azul ao lado da padaria"
              className="input-dark w-full"
            />
          </div>

          {/* Principal */}
          <label className="flex items-center gap-2 cursor-pointer p-3 rounded-xl bg-gold/5 border border-gold/20">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              className="w-5 h-5 accent-gold"
            />
            <div className="flex items-center gap-1 text-sm">
              <Star className="w-4 h-4 text-gold" />
              Usar como endereço <strong className="text-gold">principal</strong>
            </div>
          </label>
        </div>

        {err && (
          <div className="mt-3 p-2.5 bg-rose-900/30 border border-rose-700/50 rounded-lg text-xs text-rose-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {err}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-3 rounded-xl bg-ink-700 hover:bg-ink-600 text-cream font-bold text-sm"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 btn-gold-lg !py-3"
          >
            {saving ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</>
            ) : (
              <><CheckCircle2 className="w-4 h-4" /> {editing ? 'Salvar' : 'Cadastrar'}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
