'use client';

/**
 * FOTOS DA COR + BOLINHA DO SELETOR — bloco da tela master (Produto → ficha).
 *
 * No site a peça é UMA página por REF: todas as cores juntas, escolhidas numa
 * bolinha. Clicar na bolinha troca a galeria pelas fotos daquela cor. Este
 * componente é onde as duas coisas nascem:
 *
 *   1. a GALERIA da cor (até 6 fotos no R2, a primeira é a capa);
 *   2. a BOLINHA — pintada com CONTA-GOTAS na própria foto.
 *
 * Por que conta-gotas e não uma tabela de nomes de cor: "MUSGO", "UVA" e
 * "ROSA QUEIMADO" não têm hex canônico, e mesmo os que têm chegam diferentes
 * do tecido real. A cor tirada da foto é a cor que a cliente vai receber.
 *
 * Estampa não cabe num hex — por isso o segundo modo, "recorte": a bolinha
 * vira um pedaço ampliado da própria foto, e o clique define QUAL pedaço.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Crop, Loader2, Pipette, Star, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

export const MAX_FOTOS_POR_COR = 6;

export type FotoCor = { id: string; url: string; ordem: number };

export type SwatchCor = {
  swatchTipo: 'cor' | 'foto';
  corHex: string | null;
  swatchFocoX: number | null;
  swatchFocoY: number | null;
};

type Props = {
  refSku: string;
  cor: string;
  fotosIniciais: FotoCor[];
  swatch: SwatchCor;
  onSwatchChange: (s: SwatchCor) => void;
  /** Avisa o pai quando a galeria muda — o status "faltam fotos" depende disso. */
  onFotosChange?: (fotos: FotoCor[]) => void;
};

/** Ferramenta ativa sobre a foto. `null` = só olhando. */
type Ferramenta = 'conta-gotas' | 'recorte' | null;

function paraHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * Lê a cor de um ponto da foto desenhando num canvas.
 *
 * Devolve `null` quando o canvas fica "contaminado" — imagem de outro domínio
 * sem cabeçalho CORS (o R2 pode estar sem). Aí o chamador cai pro EyeDropper
 * nativo, que lê a TELA e não se importa com origem.
 */
function corDoPonto(img: HTMLImageElement, fx: number, fy: number): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round(fx * canvas.width)));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round(fy * canvas.height)));
    // Média de um quadradinho de 5px: pixel solto pega costura, brilho e fio
    // solto — a média cai no tecido.
    const lado = 5;
    const d = ctx.getImageData(
      Math.max(0, x - 2), Math.max(0, y - 2),
      Math.min(lado, canvas.width - x + 2), Math.min(lado, canvas.height - y + 2),
    ).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n) return null;
    return paraHex(Math.round(r / n), Math.round(g / n), Math.round(b / n));
  } catch {
    return null; // canvas contaminado
  }
}

/** A bolinha como a cliente vê no site. Serve de preview aqui. */
export function Bolinha({
  swatch, capaUrl, size = 28, className = '',
}: { swatch: SwatchCor; capaUrl?: string | null; size?: number; className?: string }) {
  const estilo: React.CSSProperties =
    swatch.swatchTipo === 'foto' && capaUrl
      ? {
          backgroundImage: `url(${capaUrl})`,
          // 400% + ponto clicado no centro = close-up da estampa naquele ponto.
          backgroundSize: '400%',
          backgroundPosition: `${(swatch.swatchFocoX ?? 0.5) * 100}% ${(swatch.swatchFocoY ?? 0.5) * 100}%`,
        }
      : { backgroundColor: swatch.corHex || '#E2E8F0' };

  return (
    <span
      style={{ width: size, height: size, ...estilo }}
      className={`inline-block rounded-full border border-slate-300 shadow-inner ${className}`}
    />
  );
}

export default function FotosDaCor({
  refSku, cor, fotosIniciais, swatch, onSwatchChange, onFotosChange,
}: Props) {
  const [fotos, setFotos] = useState<FotoCor[]>(fotosIniciais);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ferramenta, setFerramenta] = useState<Ferramenta>(null);
  const [semCanvas, setSemCanvas] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setFotos(fotosIniciais); }, [fotosIniciais]);

  const capa = fotos[0]?.url ?? null;

  const aplicar = useCallback((novas: FotoCor[]) => {
    setFotos(novas);
    onFotosChange?.(novas);
  }, [onFotosChange]);

  async function recarregar() {
    const p = new URLSearchParams({ ref: refSku, cor });
    const lista = await api<FotoCor[]>(`/product-photos/galeria?${p}`);
    aplicar(lista);
  }

  async function subir(arquivos: FileList | File[]) {
    const lista = Array.from(arquivos).filter((f) => f.type.startsWith('image/'));
    if (!lista.length) return;
    const cabem = MAX_FOTOS_POR_COR - fotos.length;
    if (cabem <= 0) {
      setErro(`Esta cor já tem ${MAX_FOTOS_POR_COR} fotos — remova uma antes.`);
      return;
    }
    setOcupado(true);
    setErro(null);
    try {
      // Em série de propósito: a ordem da galeria é a ordem que a pessoa
      // escolheu os arquivos, e upload paralelo embaralha.
      for (const arquivo of lista.slice(0, cabem)) {
        const form = new FormData();
        form.append('file', arquivo);
        form.append('ref', refSku);
        form.append('cor', cor);
        await api(`/product-photos/upload`, {
          method: 'POST',
          body: form as any,
          headers: {} as any, // sem Content-Type: o browser põe o boundary
        });
      }
      if (lista.length > cabem) {
        setErro(`Subiram ${cabem} — o limite por cor é ${MAX_FOTOS_POR_COR}.`);
      }
      await recarregar();
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui subir a foto');
    } finally {
      setOcupado(false);
    }
  }

  async function remover(id: string) {
    if (!confirm('Remover esta foto?')) return;
    setOcupado(true);
    try {
      await api(`/product-photos/${id}`, { method: 'DELETE' });
      await recarregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui remover');
    } finally {
      setOcupado(false);
    }
  }

  async function definirCapa(id: string) {
    setOcupado(true);
    try {
      const ids = [id, ...fotos.filter((f) => f.id !== id).map((f) => f.id)];
      const nova = await api<FotoCor[]>(`/product-photos/reorder`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      aplicar(nova);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui trocar a capa');
    } finally {
      setOcupado(false);
    }
  }

  /** Clique na foto com ferramenta ativa. */
  function clicarNaFoto(ev: React.MouseEvent<HTMLImageElement>) {
    if (!ferramenta) return;
    const img = ev.currentTarget;
    const r = img.getBoundingClientRect();
    const fx = (ev.clientX - r.left) / r.width;
    const fy = (ev.clientY - r.top) / r.height;

    if (ferramenta === 'recorte') {
      onSwatchChange({ ...swatch, swatchTipo: 'foto', swatchFocoX: fx, swatchFocoY: fy });
      setFerramenta(null);
      return;
    }

    const hex = corDoPonto(img, fx, fy);
    if (!hex) {
      setSemCanvas(true);
      setErro('A foto está hospedada sem permissão de leitura — use "conta-gotas da tela" ou digite o código da cor.');
      return;
    }
    onSwatchChange({ ...swatch, swatchTipo: 'cor', corHex: hex });
    setFerramenta(null);
  }

  /**
   * EyeDropper nativo — plano B quando o canvas não pode ler a foto. Lê o pixel
   * da TELA (qualquer lugar, inclusive fora do navegador), então origem não
   * importa. Só existe em Chrome/Edge, que é o que roda na retaguarda.
   */
  async function contaGotasDaTela() {
    const API = (window as any).EyeDropper;
    if (!API) {
      setErro('Este navegador não tem conta-gotas de tela — digite o código da cor.');
      return;
    }
    try {
      const { sRGBHex } = await new API().open();
      onSwatchChange({ ...swatch, swatchTipo: 'cor', corHex: String(sRGBHex).toUpperCase() });
      setErro(null);
    } catch { /* cancelou com Esc */ }
  }

  const cursor = ferramenta ? 'cursor-crosshair' : 'cursor-default';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-slate-500 uppercase">
          Fotos desta cor <span className="text-slate-400">({fotos.length}/{MAX_FOTOS_POR_COR})</span>
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={ocupado || fotos.length >= MAX_FOTOS_POR_COR}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-violet-200 text-violet-700 hover:bg-violet-50 disabled:opacity-40"
        >
          {ocupado ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
          Adicionar fotos
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void subir(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* Galeria. A primeira é a capa — é ela que aparece na vitrine. */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) void subir(e.dataTransfer.files);
        }}
        className="grid grid-cols-3 sm:grid-cols-6 gap-2"
      >
        {fotos.map((f, i) => (
          <div key={f.id} className="relative group aspect-[3/4] rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
            {/* crossOrigin permite o conta-gotas ler o pixel quando o bucket
                manda o cabeçalho CORS; sem ele o canvas contamina sempre. */}
            <img
              src={f.url}
              alt={`${refSku} ${cor}`}
              crossOrigin="anonymous"
              onClick={clicarNaFoto}
              className={`w-full h-full object-cover ${cursor}`}
            />
            {i === 0 && (
              <span className="absolute top-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-600 text-white">
                CAPA
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 p-1 opacity-0 group-hover:opacity-100 transition bg-black/40">
              {i !== 0 && (
                <button
                  type="button" title="Usar como capa" onClick={() => void definirCapa(f.id)}
                  className="p-1 bg-white rounded text-violet-700 hover:bg-violet-50"
                >
                  <Star className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button" title="Remover" onClick={() => void remover(f.id)}
                className="p-1 bg-white rounded text-rose-600 hover:bg-rose-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
        {fotos.length === 0 && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="col-span-3 sm:col-span-6 py-6 rounded-lg border-2 border-dashed border-slate-300 text-xs text-slate-500 hover:border-violet-400 hover:bg-violet-50"
          >
            Arraste as fotos aqui ou clique pra escolher — sem foto esta cor não vai pro site
          </button>
        )}
      </div>

      {/* Bolinha do seletor de cor */}
      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <div className="flex items-center gap-3">
          <Bolinha swatch={swatch} capaUrl={capa} size={32} />
          <div className="min-w-0">
            <p className="text-[10px] font-bold text-slate-600 uppercase">Bolinha no site</p>
            <p className="text-[11px] text-slate-500">
              {swatch.swatchTipo === 'foto'
                ? 'Recorte da foto (estampa)'
                : swatch.corHex
                  ? `Cor ${swatch.corHex}`
                  : 'Ainda sem cor — pegue no conta-gotas'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!fotos.length}
            onClick={() => setFerramenta(ferramenta === 'conta-gotas' ? null : 'conta-gotas')}
            className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border disabled:opacity-40 ${
              ferramenta === 'conta-gotas'
                ? 'bg-violet-600 text-white border-violet-600'
                : 'border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Pipette className="w-3.5 h-3.5" />
            {ferramenta === 'conta-gotas' ? 'Clique na cor da peça…' : 'Conta-gotas'}
          </button>

          <button
            type="button"
            disabled={!fotos.length}
            onClick={() => setFerramenta(ferramenta === 'recorte' ? null : 'recorte')}
            className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border disabled:opacity-40 ${
              ferramenta === 'recorte'
                ? 'bg-violet-600 text-white border-violet-600'
                : 'border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
            title="Pra estampa: a bolinha vira um pedaço da própria foto"
          >
            <Crop className="w-3.5 h-3.5" />
            {ferramenta === 'recorte' ? 'Clique na estampa…' : 'Usar recorte da foto'}
          </button>

          {semCanvas && (
            <button
              type="button"
              onClick={() => void contaGotasDaTela()}
              className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-amber-300 text-amber-800 hover:bg-amber-50"
            >
              <Pipette className="w-3.5 h-3.5" />
              Conta-gotas da tela
            </button>
          )}

          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="color"
              value={swatch.corHex || '#CCCCCC'}
              onChange={(e) => onSwatchChange({
                ...swatch, swatchTipo: 'cor', corHex: e.target.value.toUpperCase(),
              })}
              className="w-7 h-7 rounded border border-slate-300 bg-white p-0.5"
              title="Escolher a cor na mão"
            />
            à mão
          </label>
        </div>

        {ferramenta && (
          <p className="text-[11px] text-violet-700">
            {ferramenta === 'conta-gotas'
              ? 'Clique no ponto da foto que mostra melhor a cor do tecido (evite dobra, sombra e brilho).'
              : 'Clique no ponto da estampa que representa a peça — vira o centro da bolinha.'}
          </p>
        )}
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}
    </div>
  );
}
