'use client';

/**
 * /retaguarda/rh/ponto-geofence — matriz define a LOCALIZAÇÃO da loja e o RAIO
 * pra travar o ponto ("só bate perto da loja"). Camada anti-fraude do ponto.
 *
 * Fluxo: escolhe a loja → estando NA loja, clica "usar localização atual"
 * (ou digita lat/lng) → define o raio → liga o geofence. A partir daí, quem
 * bater ponto fora do raio é bloqueado. Plano B: marcação manual da gerente.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, MapPin, Crosshair, Check, AlertCircle, ShieldCheck } from 'lucide-react';

interface Store { id: string; code: string; name: string; }
interface Geofence {
  id: string; name: string;
  pontoGeofence: boolean;
  pontoLat: number | null;
  pontoLng: number | null;
  pontoRaioM: number;
}

export default function PontoGeofencePage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [cfg, setCfg] = useState<Geofence | null>(null);
  const [ativo, setAtivo] = useState(false);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [raio, setRaio] = useState('150');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    (async () => {
      try { setStores((await api<Store[]>('/stores')).sort((a, b) => a.code.localeCompare(b.code))); }
      catch { setErr('Falha ao carregar lojas.'); }
      finally { setLoading(false); }
    })();
  }, []);

  async function selecionar(id: string) {
    setStoreId(id); setErr(null); setOk(null); setCfg(null);
    if (!id) return;
    try {
      const g = await api<Geofence>(`/ponto/geofence/${id}`);
      setCfg(g);
      setAtivo(g.pontoGeofence);
      setLat(g.pontoLat != null ? String(g.pontoLat) : '');
      setLng(g.pontoLng != null ? String(g.pontoLng) : '');
      setRaio(String(g.pontoRaioM || 150));
    } catch { setErr('Falha ao carregar a config da loja.'); }
  }

  function usarLocalizacaoAtual() {
    if (!navigator.geolocation) { setErr('Este aparelho não tem GPS/localização.'); return; }
    setLocating(true); setErr(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { setLat(p.coords.latitude.toFixed(6)); setLng(p.coords.longitude.toFixed(6)); setLocating(false); setOk('Localização capturada — confira e salve.'); },
      () => { setLocating(false); setErr('Não consegui pegar a localização. Permita o acesso e tente na loja.'); },
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  }

  async function salvar() {
    setSaving(true); setErr(null); setOk(null);
    try {
      const g = await api<Geofence>(`/ponto/geofence/${storeId}`, {
        method: 'POST',
        body: JSON.stringify({
          ativo,
          lat: lat === '' ? null : Number(lat),
          lng: lng === '' ? null : Number(lng),
          raioM: Number(raio),
        }),
      });
      setCfg(g);
      setOk('Salvo! 💜');
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Erro ao salvar.';
      try { const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2)); if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message; } catch {}
      setErr(msg);
    } finally { setSaving(false); }
  }

  const temCoord = lat !== '' && lng !== '';

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-xl mx-auto">
        <Link href="/retaguarda/rh" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> RH
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <MapPin className="w-5 h-5 text-[#B8912B]" /> Ponto — travar por localização
        </h1>
        <p className="text-sm text-slate-500 mt-1 mb-5">
          Estando <b>na loja</b>, capture a localização e defina o raio. Quem tentar bater ponto fora do raio é bloqueado.
        </p>

        {loading ? <p className="text-slate-400 text-sm">Carregando…</p> : (
          <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Loja</label>
              <select value={storeId} onChange={(e) => selecionar(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none bg-white">
                <option value="">— escolha a loja —</option>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
              </select>
            </div>

            {cfg && (
              <>
                <button type="button" onClick={usarLocalizacaoAtual} disabled={locating}
                  className="w-full py-2.5 rounded-xl border-2 border-[#B8912B] text-[#8C7325] font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                  <Crosshair className="w-4 h-4" /> {locating ? 'Pegando localização…' : 'Usar minha localização atual'}
                </button>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">Latitude</label>
                    <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-23.5xxxxx" inputMode="decimal"
                      className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">Longitude</label>
                    <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-46.6xxxxx" inputMode="decimal"
                      className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none text-sm" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">Raio permitido (metros)</label>
                  <input value={raio} onChange={(e) => setRaio(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                    className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none" />
                  <p className="text-[11px] text-slate-400 mt-1">Sugestão: 100–200m (GPS dentro de loja erra um pouco).</p>
                </div>

                <label className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer">
                  <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} disabled={!temCoord}
                    className="w-5 h-5 accent-[#B8912B]" />
                  <span className="text-sm">
                    <b className="flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-emerald-600" /> Travar o ponto por localização</b>
                    <span className="text-slate-500 text-xs">{temCoord ? 'Só deixa bater dentro do raio.' : 'Capture a localização primeiro.'}</span>
                  </span>
                </label>

                {err && <p className="text-red-600 text-sm flex items-center gap-1.5"><AlertCircle className="w-4 h-4" />{err}</p>}
                {ok && <p className="text-emerald-600 text-sm flex items-center gap-1.5"><Check className="w-4 h-4" />{ok}</p>}

                <button onClick={salvar} disabled={saving}
                  className="w-full py-2.5 rounded-xl bg-[#B8912B] text-white font-bold disabled:opacity-40 hover:bg-[#8C7325]">
                  {saving ? 'Salvando…' : 'Salvar'}
                </button>
              </>
            )}
            {!cfg && !loading && err && <p className="text-red-600 text-sm">{err}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
