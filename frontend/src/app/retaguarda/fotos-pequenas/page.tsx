'use client';

/**
 * /retaguarda/fotos-pequenas — A FILA DE FOTOS PRA REFAZER.
 *
 * 13/08/2026, o dono na PDP da VLM-222: "está perdendo muito a definição". O
 * arquivo no bucket tinha **700×1000** pra um quadro de 513 CSS px — num
 * monitor a 150% o navegador precisa de ~770px de largura e amplia o que tem.
 * Medido na hora: das 60 fotos mais recentes, 44 tinham 1200px ou menos.
 *
 * O problema não é a entrega. A foto sai do servidor em AVIF com 11 a 16 KB —
 * leve; o que falta é pixel no arquivo, e isso nenhuma configuração recupera.
 *
 * Decisão do dono no mesmo dia: foto pequena **não é recusada** no upload
 * (travar quem só tem aquela foto na mão pararia a operação) — ela entra
 * medida e cai nesta lista. Mínimo: 1400 × 2000, a mesma proporção 7:10 da
 * casa, que cobre monitor a 150% e 200% e ainda sobra pro zoom.
 *
 * Subiu a foto grande na tela master → sai daqui sozinha.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { AlertTriangle, ImageOff, Loader2, RefreshCw, Ruler } from 'lucide-react';

interface FotoPequena {
  id: string;
  ref: string;
  cor: string | null;
  url: string;
  ordem: number;
  larguraPx: number | null;
  alturaPx: number | null;
}

interface Resposta {
  minimo: { largura: number; altura: number };
  total: number;
  semMedida: number;
  abaixoDoMinimo: number;
  fotos: FotoPequena[];
}

interface Medicao {
  olhadas: number;
  medidas: number;
  pequenas: number;
  falharam: number;
  restantes: number;
}

export default function FotosPequenasPage() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [medindo, setMedindo] = useState(false);
  const [medicao, setMedicao] = useState<Medicao | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setDados(await api<Resposta>('/product-photos/baixa-resolucao?limite=300'));
    } catch (e: any) {
      setErro(e?.message || 'Falha ao carregar');
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  /**
   * Mede em lote o acervo antigo (foto anterior a 13/08 entrou sem medida).
   * Em lotes porque o R2 público responde 429 com pressa — o botão continua
   * enquanto `restantes` for maior que zero.
   */
  const medir = async () => {
    setMedindo(true);
    try {
      const r = await api<Medicao>('/product-photos/baixa-resolucao/medir', {
        method: 'POST',
        body: JSON.stringify({ limite: 200 }),
      });
      setMedicao(r);
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Falha ao medir');
    } finally {
      setMedindo(false);
    }
  };

  const min = dados?.minimo;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <ImageOff className="w-5 h-5" /> Fotos pequenas
          </h1>
          <p className="text-sm text-slate-500 max-w-2xl">
            Foto abaixo de{' '}
            <b>{min ? `${min.largura} × ${min.altura}` : '1400 × 2000'}</b> aparece borrada na
            página do produto — o site não inventa o que não está no arquivo. Suba a foto
            grande na tela do produto e a peça sai desta lista.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={carregar}
            disabled={carregando}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} /> Atualizar
          </button>
          <button
            onClick={medir}
            disabled={medindo}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-40"
          >
            {medindo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ruler className="w-4 h-4" />}
            Medir acervo antigo
          </button>
        </div>
      </header>

      {erro && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {erro}
        </div>
      )}

      {dados && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Cartao titulo="Fotos no acervo" valor={dados.total} />
          <Cartao titulo="Abaixo do mínimo" valor={dados.abaixoDoMinimo} destaque />
          <Cartao
            titulo="Ainda sem medir"
            valor={dados.semMedida}
            nota={dados.semMedida > 0 ? 'clique em Medir acervo antigo' : undefined}
          />
        </div>
      )}

      {medicao && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-800">
          Medidas {medicao.medidas} de {medicao.olhadas} — {medicao.pequenas} abaixo do mínimo
          {medicao.falharam > 0 && `, ${medicao.falharam} não deram pra ler`}.{' '}
          {medicao.restantes > 0
            ? `Faltam ${medicao.restantes} — clique de novo.`
            : 'Acervo inteiro medido.'}
        </div>
      )}

      {carregando ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : !dados?.fotos.length ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Nenhuma foto abaixo do mínimo entre as medidas.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {dados.fotos.map((f) => (
            <div key={f.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.url}
                alt={`${f.ref} ${f.cor ?? ''}`}
                className="w-full aspect-[7/10] object-cover bg-slate-100"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
              <div className="p-2 space-y-0.5">
                <div className="font-mono text-sm font-bold text-slate-900">{f.ref}</div>
                <div className="text-xs uppercase text-slate-600 truncate">{f.cor || 'sem cor'}</div>
                <div className="text-xs font-bold text-rose-600">
                  {f.larguraPx} × {f.alturaPx}
                </div>
                {f.ordem === 0 && (
                  <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700">
                    é a capa
                  </div>
                )}
                <Link
                  href={`/retaguarda/produto-master?ref=${encodeURIComponent(f.ref)}`}
                  className="block pt-1 text-xs font-bold text-violet-700 hover:underline"
                >
                  Trocar a foto →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Cartao({
  titulo, valor, nota, destaque,
}: { titulo: string; valor: number; nota?: string; destaque?: boolean }) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        destaque && valor > 0 ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{titulo}</div>
      <div className={`text-2xl font-black ${destaque && valor > 0 ? 'text-rose-700' : 'text-slate-800'}`}>
        {valor}
      </div>
      {nota && <div className="text-[11px] text-slate-500">{nota}</div>}
    </div>
  );
}
