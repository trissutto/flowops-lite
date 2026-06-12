'use client';

import { useEffect, useState } from 'react';
import { Store, MapPin, Loader2, Phone, Truck } from 'lucide-react';
import { checkAvailability, type StoreAvailability } from '@/lib/api';

/**
 * "Disponível em qual loja?" — bloco na página de produto.
 *
 * Cliente informa CEP → backend consulta estoque por loja (ErpService)
 * → mostra lojas ordenadas por proximidade. Plus size adora "vai ter
 * na minha cidade?".
 *
 * MVP atual: distância simbólica (mesma cidade = 0km, outras = sem distância).
 * Próximo nível: integrar geocoding pra distância real em km.
 */
export default function StoreAvailabilityBlock({
  skus,
  defaultCep,
}: {
  skus: string[];
  defaultCep?: string | null;
}) {
  const [cep, setCep] = useState(defaultCep || '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    cidadeCliente: string | null;
    ufCliente: string | null;
    freteSugerido: { valor: number; descricao: string } | null;
    lojas: StoreAvailability[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-consulta se já tem CEP salvo (do perfil)
  useEffect(() => {
    if (defaultCep && skus.length > 0) {
      doCheck(defaultCep);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultCep, skus.join(',')]);

  const doCheck = async (cepValue: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await checkAvailability(skus, cepValue);
      setResult({
        cidadeCliente: r.cidadeCliente,
        ufCliente: r.ufCliente,
        freteSugerido: r.freteSugerido,
        lojas: r.lojas,
      });
    } catch (e: any) {
      setError(e?.message || 'Não conseguimos consultar agora');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = cep.replace(/\D/g, '');
    if (clean.length !== 8) {
      setError('CEP precisa ter 8 dígitos');
      return;
    }
    doCheck(clean);
  };

  return (
    <div className="card-dark">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-gold/15 border border-gold/30 flex items-center justify-center shrink-0">
          <Store className="w-5 h-5 text-gold" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-sm">Disponível na sua região?</h4>
          <p className="text-xs text-cream/60 mt-0.5">
            Veja em quais lojas tem essa peça pra você ir provar ou retirar
          </p>
        </div>
      </div>

      {/* Input CEP */}
      {!result && (
        <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={cep}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 8);
              setCep(v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v);
            }}
            placeholder="00000-000"
            className="input-dark flex-1"
            maxLength={9}
          />
          <button
            type="submit"
            disabled={loading || cep.replace(/\D/g, '').length !== 8}
            className="btn-outline-gold shrink-0 px-4 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Buscar'}
          </button>
        </form>
      )}

      {error && (
        <div className="mt-2 text-xs text-rose-300">{error}</div>
      )}

      {/* Resultado */}
      {result && (
        <div className="mt-3 space-y-2">
          {result.cidadeCliente && (
            <div className="text-xs text-cream/70 flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              CEP em <strong className="text-cream">{result.cidadeCliente}</strong>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setCep('');
                }}
                className="ml-auto text-gold underline"
              >
                Trocar CEP
              </button>
            </div>
          )}

          {/* CARD DE FRETE SUGERIDO — quando não tem loja na cidade da cliente */}
          {result.freteSugerido && (
            <div className="rounded-xl bg-gradient-to-br from-emerald-900/30 via-emerald-900/15 to-ink-900 border border-emerald-500/30 p-3">
              <div className="flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center shrink-0">
                  <Truck className="w-4 h-4 text-emerald-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-black uppercase tracking-widest text-emerald-300">
                    Sem loja na sua cidade? Sem problema
                  </div>
                  <div className="text-sm font-bold text-cream mt-0.5">
                    Frete por apenas{' '}
                    <span className="text-emerald-300 text-base">
                      R$ {result.freteSugerido.valor.toFixed(2).replace('.', ',')}
                    </span>
                  </div>
                  <div className="text-[11px] text-cream/60 mt-0.5">
                    {result.freteSugerido.descricao}
                    {result.ufCliente && (
                      <span className="ml-1 px-1.5 py-0.5 bg-ink-700 rounded text-cream/80 font-mono text-[10px]">
                        {result.ufCliente}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {result.lojas.length === 0 ? (
            <div className="text-xs text-cream/60 bg-ink-900 rounded-xl p-3 text-center">
              {result.freteSugerido ? (
                <>👆 Aproveita o frete acima — chegamos rapidinho</>
              ) : (
                <>
                  😔 Sem estoque nas lojas físicas agora.
                  <br />
                  Recomendamos pedir online pelo app.
                </>
              )}
            </div>
          ) : (
            result.lojas.map((l) => (
              <div
                key={l.code}
                className="bg-ink-900 border border-ink-600 rounded-xl p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-sm flex items-center gap-1.5">
                      {l.distanceKm === 0 && (
                        <span className="text-[10px] font-black uppercase bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded-full">
                          Mesma cidade
                        </span>
                      )}
                      <span className="truncate">{l.name}</span>
                    </div>
                    <div className="text-[11px] text-cream/60 mt-0.5">
                      {l.city || '—'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-black text-emerald-400">
                      ✓ {l.totalQty} {l.totalQty === 1 ? 'peça' : 'peças'}
                    </div>
                    {l.whatsapp && (
                      <a
                        href={`https://wa.me/${l.whatsapp.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 text-[10px] text-gold mt-0.5 underline"
                      >
                        <Phone className="w-3 h-3" />
                        Falar com a loja
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
