'use client';

import { useEffect, useState } from 'react';
import { Users, ThumbsUp, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { getSizeStats, getPreferredSize, type SizeStats } from '@/lib/api';

/**
 * "Cabe em quem veste 48?" — bloco na página de produto mostrando como o
 * tamanho serviu pra clientes do mesmo manequim. Pega tamanho preferido
 * da cliente (localStorage). Se não tem, sugere salvar pra ter recomendação
 * personalizada na próxima.
 *
 * Diferencial real pro plus size — mata a maior dúvida: "vai servir em mim?"
 */
export default function SizeReviewBlock({ productId }: { productId: number }) {
  const [preferredSize, setPreferredSize] = useState<string | null>(null);
  const [stats, setStats] = useState<SizeStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const size = getPreferredSize();
    setPreferredSize(size);
    setLoading(true);
    getSizeStats(productId, size || undefined)
      .then((r) => setStats(r))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [productId]);

  if (loading) {
    return (
      <div className="card-dark animate-pulse">
        <div className="h-4 bg-ink-700 rounded w-1/2 mb-2" />
        <div className="h-3 bg-ink-700 rounded w-3/4" />
      </div>
    );
  }

  if (!stats || stats.total === 0) {
    // Sem dados ainda — convida a ser a primeira
    return (
      <div className="card-dark text-center">
        <Users className="w-6 h-6 text-gold/50 mx-auto" />
        <h4 className="font-bold text-sm mt-2">Seja a primeira a contar 💛</h4>
        <p className="text-xs text-cream/60 mt-1">
          Comprou essa peça? Conta pra gente como serviu —
          ajuda outras clientes a escolher o tamanho certo.
        </p>
      </div>
    );
  }

  const headline = preferredSize
    ? `Clientes que vestem ${preferredSize}`
    : 'Como serviu pra outras clientes';

  return (
    <div className="card-dark">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-gold/15 border border-gold/30 flex items-center justify-center shrink-0">
          <Users className="w-5 h-5 text-gold" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-sm">{headline}</h4>
          <p className="text-xs text-cream/60 mt-0.5">
            {stats.total} {stats.total === 1 ? 'cliente comprou' : 'clientes compraram'} essa peça
            {preferredSize && ' no seu manequim'}
          </p>
        </div>
      </div>

      {/* Barra visual */}
      <div className="mt-3">
        <div className="h-3 rounded-full overflow-hidden flex bg-ink-900">
          {stats.fits > 0 && (
            <div
              className="bg-emerald-500"
              style={{ width: `${(stats.fits / stats.total) * 100}%` }}
              title={`${stats.fits} disseram que serviu`}
            />
          )}
          {stats.tight > 0 && (
            <div
              className="bg-amber-500"
              style={{ width: `${(stats.tight / stats.total) * 100}%` }}
              title={`${stats.tight} acharam apertado`}
            />
          )}
          {stats.loose > 0 && (
            <div
              className="bg-blue-400"
              style={{ width: `${(stats.loose / stats.total) * 100}%` }}
              title={`${stats.loose} acharam folgado`}
            />
          )}
          {stats.returned > 0 && (
            <div
              className="bg-rose-500"
              style={{ width: `${(stats.returned / stats.total) * 100}%` }}
              title={`${stats.returned} devolveram`}
            />
          )}
        </div>
      </div>

      {/* Legendas */}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        {stats.fits > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-cream/80">
              <strong className="text-emerald-300">{stats.fits}</strong> serviu
            </span>
          </div>
        )}
        {stats.tight > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-cream/80">
              <strong className="text-amber-300">{stats.tight}</strong> apertou
            </span>
          </div>
        )}
        {stats.loose > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-400" />
            <span className="text-cream/80">
              <strong className="text-blue-300">{stats.loose}</strong> folgou
            </span>
          </div>
        )}
        {stats.returned > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            <span className="text-cream/80">
              <strong className="text-rose-300">{stats.returned}</strong> devolveram
            </span>
          </div>
        )}
      </div>

      {/* Recomendação */}
      {stats.recommendation !== 'mixed' && stats.recommendation !== 'no_data' && (
        <div className="mt-3 p-3 rounded-xl border flex items-start gap-2 text-xs leading-relaxed">
          {stats.recommendation === 'buy_size' && (
            <>
              <ThumbsUp className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-emerald-300">
                <strong>Veste normalmente.</strong> {stats.fitsPct}% das clientes do seu tamanho disseram que serviu certinho.
              </div>
            </>
          )}
          {stats.recommendation === 'go_up' && (
            <>
              <TrendingUp className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-amber-300">
                <strong>Recomendamos subir 1 tamanho.</strong> Muitas clientes acharam apertado.
              </div>
            </>
          )}
          {stats.recommendation === 'go_down' && (
            <>
              <TrendingDown className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <div className="text-blue-300">
                <strong>Pode descer 1 tamanho.</strong> Várias clientes acharam folgado.
              </div>
            </>
          )}
        </div>
      )}

      {/* CTA pra cliente sem preferred size */}
      {!preferredSize && (
        <div className="mt-3 text-[11px] text-cream/50 text-center">
          💡 Salva seu manequim no perfil pra recomendação personalizada
        </div>
      )}
    </div>
  );
}
