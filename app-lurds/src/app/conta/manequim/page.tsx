'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Ruler, CheckCircle2, Sparkles, RefreshCw, Info, Shirt, AlertTriangle,
} from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import {
  calcularManequim, getManequim, setManequim, mensagemConfianca, type Manequim,
} from '@/lib/manequim';

export default function ManequimPage() {
  const router = useRouter();
  const [busto, setBusto] = useState('');
  const [cintura, setCintura] = useState('');
  const [quadril, setQuadril] = useState('');
  const [manequim, setManequimState] = useState<Manequim | null>(null);
  const [showVideoModal, setShowVideoModal] = useState(false);

  // Carrega manequim salvo
  useEffect(() => {
    const saved = getManequim();
    if (saved) {
      setManequimState(saved);
      setBusto(String(saved.busto));
      setCintura(String(saved.cintura));
      setQuadril(String(saved.quadril));
    }
  }, []);

  const canCalculate =
    Number(busto) >= 60 && Number(busto) <= 200 &&
    Number(cintura) >= 50 && Number(cintura) <= 200 &&
    Number(quadril) >= 60 && Number(quadril) <= 200;

  const handleCalcular = () => {
    if (!canCalculate) return;
    const m = calcularManequim(Number(busto), Number(cintura), Number(quadril));
    setManequimState(m);
  };

  const handleSalvar = () => {
    if (!manequim) return;
    setManequim(manequim);
    // Volta pra home com tamanho aplicado
    router.push('/?manequim_salvo=1');
  };

  const handleRecalcular = () => {
    setManequimState(null);
  };

  return (
    <div className="pb-24">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/conta" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold flex-1">Meu manequim</h1>
        {manequim && (
          <button
            onClick={handleRecalcular}
            className="p-2 rounded-full bg-ink-800"
            aria-label="Recalcular"
          >
            <RefreshCw className="w-4 h-4 text-gold" />
          </button>
        )}
      </header>

      {!manequim ? (
        /* ─────── ENTRADA: 3 MEDIDAS ─────── */
        <section className="px-5 mt-6">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 rounded-full bg-gold/15 border border-gold/30 flex items-center justify-center mb-3">
              <Ruler className="w-8 h-8 text-gold" />
            </div>
            <h2 className="font-serif text-xl font-bold">
              Descubra seu tamanho <span className="text-gold italic">exato</span>
            </h2>
            <p className="text-sm text-cream/60 mt-1 max-w-xs">
              3 medidas e a gente te diz qual número Lurd's veste em você
            </p>
          </div>

          <div className="space-y-4">
            <MedidaInput
              label="Busto"
              tooltip="Parte mais alta do busto, com sutiã sem enchimento"
              value={busto}
              onChange={setBusto}
            />
            <MedidaInput
              label="Cintura"
              tooltip="Parte mais fina entre as costelas e o quadril"
              value={cintura}
              onChange={setCintura}
            />
            <MedidaInput
              label="Quadril"
              tooltip="Parte mais larga do quadril, ~20cm abaixo da cintura"
              value={quadril}
              onChange={setQuadril}
            />
          </div>

          <button
            onClick={() => setShowVideoModal(true)}
            className="w-full mt-4 text-xs text-gold underline flex items-center justify-center gap-1"
          >
            <Info className="w-3.5 h-3.5" />
            Como medir em casa (30s)
          </button>

          <button
            onClick={handleCalcular}
            disabled={!canCalculate}
            className={`w-full mt-5 btn-gold-lg ${!canCalculate ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <Ruler className="w-5 h-5" />
            Calcular meu tamanho
          </button>

          <div className="mt-4 p-3 rounded-xl bg-ink-800 border border-ink-600 text-xs text-cream/60 leading-relaxed">
            <strong className="text-cream">Sua privacidade:</strong> Suas medidas ficam guardadas só no seu celular.
            Não enviamos pra ninguém — usamos só pra recomendar tamanhos.
          </div>
        </section>
      ) : (
        /* ─────── RESULTADO ─────── */
        <section className="px-5 mt-6">
          {/* Card principal — tamanho geral */}
          <div className="card-gold-border bg-gradient-to-br from-gold/15 via-ink-800 to-ink-900 text-center py-6">
            <div className="text-[10px] font-black uppercase tracking-widest text-gold mb-2">
              Seu tamanho Lurd's
            </div>
            <div className="font-serif text-7xl font-black text-gold leading-none">
              {manequim.tamanhoGeral}
            </div>
            <ConfiancaBadge confianca={manequim.confianca} />
            <p className="text-xs text-cream/70 mt-3 px-4 leading-relaxed">
              {mensagemConfianca(manequim)}
            </p>
          </div>

          {/* Por categoria */}
          <div className="mt-4 card-dark">
            <div className="text-[11px] font-black uppercase tracking-wider text-gold mb-3">
              Por tipo de peça
            </div>
            <CategoriaLinha label="Blusas e T-shirts" tamanho={manequim.porCategoria.blusas} />
            <CategoriaLinha label="Vestidos e Macacões" tamanho={manequim.porCategoria.vestidos} />
            <CategoriaLinha label="Calças" tamanho={manequim.porCategoria.calcas} />
            <CategoriaLinha label="Saias" tamanho={manequim.porCategoria.saias} isLast />
          </div>

          {/* Suas medidas */}
          <div className="mt-4 card-dark">
            <div className="text-[11px] font-black uppercase tracking-wider text-cream/50 mb-3">
              Suas medidas
            </div>
            <div className="grid grid-cols-3 gap-2">
              <MedidaResumo label="Busto" valor={manequim.busto} />
              <MedidaResumo label="Cintura" valor={manequim.cintura} />
              <MedidaResumo label="Quadril" valor={manequim.quadril} />
            </div>
          </div>

          {/* Info de uso futuro */}
          <div className="mt-4 p-3 rounded-xl bg-emerald-900/20 border border-emerald-500/30 flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="text-xs text-emerald-300 leading-relaxed">
              Salvando agora, o app vai <strong>filtrar produtos no seu tamanho automaticamente</strong> e
              mostrar quem do seu manequim já comprou cada peça.
            </div>
          </div>

          <button
            onClick={handleSalvar}
            className="w-full mt-5 btn-gold-lg"
          >
            <CheckCircle2 className="w-5 h-5" />
            Salvar meu manequim
          </button>

          <button
            onClick={handleRecalcular}
            className="w-full mt-2 py-3 text-xs text-cream/60 border border-ink-600 rounded-full"
          >
            Refazer medições
          </button>
        </section>
      )}

      <div className="h-20" />
      <BottomNav />

      {/* Modal "como medir" */}
      {showVideoModal && (
        <div
          className="fixed inset-0 z-[200] bg-ink/90 backdrop-blur-sm flex items-end sm:items-center justify-center"
          onClick={() => setShowVideoModal(false)}
        >
          <div
            className="w-full max-w-md mx-0 sm:mx-4 bg-ink-800 sm:border sm:border-gold/30 rounded-t-3xl sm:rounded-3xl p-6 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
          >
            <h3 className="font-serif text-lg font-bold text-gold mb-3">Como medir em casa</h3>
            <ol className="text-sm text-cream/80 space-y-3 leading-relaxed">
              <li className="flex gap-2">
                <span className="text-gold font-bold shrink-0">1.</span>
                <span><strong>Busto:</strong> use uma fita métrica passando pela parte mais alta do busto, mantendo a fita paralela ao chão.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gold font-bold shrink-0">2.</span>
                <span><strong>Cintura:</strong> meça a parte mais fina do tronco, normalmente acima do umbigo.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gold font-bold shrink-0">3.</span>
                <span><strong>Quadril:</strong> meça a parte mais larga, geralmente 20cm abaixo da cintura.</span>
              </li>
            </ol>
            <div className="mt-4 p-3 rounded-xl bg-ink-900 text-xs text-cream/70">
              <strong className="text-cream">Dica:</strong> Meça com roupa íntima, sem apertar a fita. Se não tem fita métrica, use um barbante e mede com régua depois.
            </div>
            <button
              onClick={() => setShowVideoModal(false)}
              className="w-full mt-4 btn-gold"
            >
              Entendi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════ COMPONENTES AUXILIARES ════════════ */

function MedidaInput({
  label, tooltip, value, onChange,
}: {
  label: string;
  tooltip: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-black uppercase tracking-wider text-gold">
          {label} <span className="text-cream/50 font-normal">(cm)</span>
        </label>
        <button
          onClick={() => setShowTooltip(!showTooltip)}
          className="p-1 text-cream/40 hover:text-gold"
          aria-label={`Ajuda ${label}`}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </div>
      {showTooltip && (
        <div className="mb-2 p-2 rounded-lg bg-ink-700 text-[11px] text-cream/70 leading-relaxed">
          💡 {tooltip}
        </div>
      )}
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 3))}
        placeholder="0"
        className="input-dark text-center text-xl font-black tabular-nums"
        maxLength={3}
      />
    </div>
  );
}

function ConfiancaBadge({ confianca }: { confianca: 'alta' | 'media' | 'baixa' }) {
  const config = {
    alta: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', label: 'Confiança alta', icon: CheckCircle2 },
    media: { bg: 'bg-amber-500/20', text: 'text-amber-300', label: 'Confiança média', icon: Info },
    baixa: { bg: 'bg-rose-500/20', text: 'text-rose-300', label: 'Veja por categoria', icon: AlertTriangle },
  }[confianca];
  const Icon = config.icon;
  return (
    <div className={`inline-flex items-center gap-1 mt-3 px-2.5 py-1 rounded-full ${config.bg}`}>
      <Icon className="w-3 h-3" />
      <span className={`text-[10px] font-bold uppercase tracking-wider ${config.text}`}>
        {config.label}
      </span>
    </div>
  );
}

function CategoriaLinha({ label, tamanho, isLast }: { label: string; tamanho: number; isLast?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-2 ${!isLast ? 'border-b border-ink-700' : ''}`}>
      <span className="text-sm text-cream/80 flex items-center gap-2">
        <Shirt className="w-3.5 h-3.5 text-gold/60" />
        {label}
      </span>
      <span className="font-serif text-lg font-black text-gold tabular-nums">{tamanho}</span>
    </div>
  );
}

function MedidaResumo({ label, valor }: { label: string; valor: number }) {
  return (
    <div className="text-center bg-ink-900 rounded-lg py-2">
      <div className="text-[10px] text-cream/50 uppercase tracking-wider">{label}</div>
      <div className="font-bold text-white tabular-nums mt-0.5">{valor} <span className="text-[10px] text-cream/50 font-normal">cm</span></div>
    </div>
  );
}
