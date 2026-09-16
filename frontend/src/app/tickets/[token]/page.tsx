'use client';

/**
 * /tickets/<token> — o celular da operadora manda as fotos dos tickets
 * (16/09/2026). Chega aqui pelo QR da abertura do caixa.
 *
 * Página PÚBLICA: o token (aleatório, 36h) só deixa mandar foto e ver o
 * andamento desta loja × dia. Nenhum dado de venda ou de cliente aparece.
 *
 * O andamento vem do NOSSO backend a cada 4s, e só enquanto alguma foto está
 * sendo lida — parado não consulta nada.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Camera, CheckCircle2, ImagePlus, Loader2, RotateCw } from 'lucide-react';
import { api } from '@/lib/api';
import { comprimirFotoProduto } from '@/lib/comprimir-foto';

const OURO = '#B8912B';

type FotoServidor = {
  id: string;
  status: 'pendente' | 'lendo' | 'lida' | 'ilegivel' | 'erro';
  erro: string | null;
  observacao: string | null;
  origem: string;
  tickets: number;
};

type Estado = {
  loteId: string;
  storeCode: string;
  storeName: string | null;
  dia: string;
  diaCurto: string;
  status: string;
  finalizadoEm: string | null;
  fotos: FotoServidor[];
};

type Local = {
  chave: string;
  url: string;
  arquivo: File;
  fase: 'enviando' | 'enviada' | 'falhou';
  fotoId?: string;
  erro?: string;
};

export default function EnviarTicketsPage() {
  const { token } = useParams<{ token: string }>();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [locais, setLocais] = useState<Local[]>([]);
  const [terminado, setTerminado] = useState(false);
  const [finalizando, setFinalizando] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const galeria = useRef<HTMLInputElement>(null);
  const fila = useRef<Promise<void>>(Promise.resolve());

  const carregar = useCallback(async () => {
    try {
      const e = await api<Estado>(`/public/conferencia-tickets/envio/${encodeURIComponent(token)}`);
      setEstado(e);
      setErro(null);
    } catch (e: any) {
      setErro(e?.body?.message || 'Não consegui abrir este link. Confira a internet e tente de novo.');
    }
  }, [token]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const lendo =
    locais.some((l) => l.fase === 'enviando') ||
    (estado?.fotos || []).some((f) => f.status === 'pendente' || f.status === 'lendo');
  useEffect(() => {
    if (!lendo) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') carregar();
    }, 4000);
    return () => window.clearInterval(t);
  }, [lendo, carregar]);

  useEffect(() => () => locais.forEach((l) => URL.revokeObjectURL(l.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  function enviarUma(local: Local) {
    // Uma de cada vez: celular em 4G de loja não aguenta 10 envios paralelos.
    fila.current = fila.current.then(async () => {
      try {
        const foto = await comprimirFotoProduto(local.arquivo);
        const fd = new FormData();
        fd.append('file', foto);
        const r = await api<{ fotoId: string }>(
          `/public/conferencia-tickets/envio/${encodeURIComponent(token)}/fotos`,
          { method: 'POST', body: fd },
        );
        setLocais((ls) => ls.map((l) => (l.chave === local.chave ? { ...l, fase: 'enviada', fotoId: r.fotoId, erro: undefined } : l)));
        carregar();
      } catch (e: any) {
        setLocais((ls) =>
          ls.map((l) =>
            l.chave === local.chave ? { ...l, fase: 'falhou', erro: e?.body?.message || 'não enviou — toque pra tentar de novo' } : l,
          ),
        );
      }
    });
  }

  function adicionar(lista: FileList | null) {
    if (!lista?.length) return;
    const novos: Local[] = Array.from(lista).map((arquivo, i) => ({
      chave: `${Date.now()}-${i}-${arquivo.name}`,
      url: URL.createObjectURL(arquivo),
      arquivo,
      fase: 'enviando',
    }));
    setTerminado(false);
    setLocais((ls) => [...novos.reverse(), ...ls]);
    novos.slice().reverse().forEach(enviarUma);
  }

  function reenviar(local: Local) {
    setLocais((ls) => ls.map((l) => (l.chave === local.chave ? { ...l, fase: 'enviando', erro: undefined } : l)));
    enviarUma({ ...local, fase: 'enviando' });
  }

  async function terminar() {
    setFinalizando(true);
    try {
      await fila.current;
      await api(`/public/conferencia-tickets/envio/${encodeURIComponent(token)}/terminei`, { method: 'POST' });
      setTerminado(true);
      carregar();
    } catch (e: any) {
      setErro(e?.body?.message || 'Não consegui finalizar — tente de novo.');
    } finally {
      setFinalizando(false);
    }
  }

  if (erro && !estado) {
    return (
      <Casca>
        <div className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-center text-amber-900">
          <AlertTriangle className="mx-auto h-8 w-8" />
          <p className="mt-3 text-base font-semibold">{erro}</p>
        </div>
      </Casca>
    );
  }
  if (!estado) {
    return (
      <Casca>
        <div className="mt-16 flex items-center justify-center gap-2 text-stone-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Abrindo…
        </div>
      </Casca>
    );
  }

  const porId = new Map(estado.fotos.map((f) => [f.id, f]));
  const locaisIds = new Set(locais.map((l) => l.fotoId).filter(Boolean));
  const doOutroAparelho = estado.fotos.filter((f) => !locaisIds.has(f.id));
  const total = estado.fotos.length;
  const lidas = estado.fotos.filter((f) => f.status === 'lida').length;
  const problemas = estado.fotos.filter((f) => f.status === 'ilegivel' || f.status === 'erro').length;
  const enviandoAgora = locais.filter((l) => l.fase === 'enviando').length;

  return (
    <Casca>
      <header className="pt-5">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Tickets do caixa</p>
        <h1 className="mt-1 text-2xl font-bold leading-tight text-stone-900">
          {estado.storeCode} {estado.storeName || ''}
        </h1>
        <p className="mt-0.5 text-base text-stone-600">Movimento de {estado.diaCurto}</p>
      </header>

      {terminado ? (
        <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center text-emerald-900">
          <CheckCircle2 className="mx-auto h-10 w-10" />
          <p className="mt-2 text-lg font-bold">Pronto! Pode voltar pro caixa.</p>
          <p className="mt-1 text-sm">A leitura e a conferência continuam sozinhas. Achou mais algum ticket? É só fotografar aqui.</p>
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        <button
          type="button"
          onClick={() => camera.current?.click()}
          className="flex min-h-[64px] items-center justify-center gap-3 rounded-2xl text-lg font-bold text-white shadow-sm active:translate-y-px"
          style={{ backgroundColor: OURO }}
        >
          <Camera className="h-7 w-7" /> Tirar foto
        </button>
        <button
          type="button"
          onClick={() => galeria.current?.click()}
          className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl border-2 border-stone-300 bg-white text-base font-semibold text-stone-800 active:translate-y-px"
        >
          <ImagePlus className="h-6 w-6" /> Escolher da galeria
        </button>
        <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { adicionar(e.target.files); e.target.value = ''; }} />
        <input ref={galeria} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { adicionar(e.target.files); e.target.value = ''; }} />
      </div>

      <ul className="mt-4 space-y-1 rounded-2xl bg-stone-100 p-4 text-sm text-stone-700">
        <li>• Fotografe <b>todos</b> os tickets do dia: maquininha, cupons de dinheiro/PIX, recibos de crediário e comprovantes de PIX.</li>
        <li>• Até <b>4 tickets por foto</b>, esticados, um do lado do outro.</li>
        <li>• Luz boa, sem reflexo e com o <b>valor bem visível</b>.</li>
      </ul>

      <section className="mt-6" aria-live="polite">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-bold text-stone-900">Fotos ({total + enviandoAgora})</h2>
          <p className="text-sm text-stone-600">
            {lidas > 0 && `${lidas} lida${lidas > 1 ? 's' : ''}`}
            {problemas > 0 && <span className="ml-2 font-semibold text-amber-700">{problemas} pra tirar de novo</span>}
          </p>
        </div>

        {locais.length === 0 && doOutroAparelho.length === 0 && (
          <p className="mt-3 rounded-2xl border-2 border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">
            Nenhuma foto ainda.
          </p>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          {locais.map((l) => {
            const s = l.fotoId ? porId.get(l.fotoId) : undefined;
            return (
              <button
                type="button"
                key={l.chave}
                onClick={() => l.fase === 'falhou' && reenviar(l)}
                className="relative aspect-[3/4] overflow-hidden rounded-xl bg-stone-200 text-left"
                aria-label={rotuloDaFoto(l, s)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={l.url} alt="" className="h-full w-full object-cover" />
                <Selo local={l} servidor={s} />
              </button>
            );
          })}
          {doOutroAparelho.map((f) => (
            <div key={f.id} className="relative grid aspect-[3/4] place-items-center rounded-xl bg-stone-200 p-2 text-center text-xs text-stone-600">
              foto enviada {f.origem === 'pc' ? 'pelo PC' : 'antes'}
              <Selo servidor={f} />
            </div>
          ))}
        </div>

        {estado.fotos.some((f) => f.status === 'ilegivel' || f.status === 'erro') && (
          <ul className="mt-3 space-y-1 text-sm text-amber-800">
            {estado.fotos
              .filter((f) => f.status === 'ilegivel' || f.status === 'erro')
              .map((f) => (
                <li key={f.id}>• {f.status === 'ilegivel' ? f.observacao || 'não deu pra ler' : f.erro} — tire essa foto de novo</li>
              ))}
          </ul>
        )}
      </section>

      <div className="sticky bottom-0 -mx-4 mt-8 border-t border-stone-200 bg-white/95 px-4 pb-[max(env(safe-area-inset-bottom),16px)] pt-3 backdrop-blur">
        <button
          type="button"
          onClick={terminar}
          disabled={finalizando || total + enviandoAgora === 0}
          className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-2xl bg-stone-900 text-lg font-bold text-white disabled:opacity-40"
        >
          {finalizando ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-6 w-6" />}
          {enviandoAgora > 0 ? `Terminei (enviando ${enviandoAgora}…)` : 'Terminei'}
        </button>
        {erro && <p className="mt-2 text-center text-sm text-red-700">{erro}</p>}
      </div>
    </Casca>
  );
}

function rotuloDaFoto(l: Local, s?: FotoServidor): string {
  if (l.fase === 'enviando') return 'Enviando';
  if (l.fase === 'falhou') return `Não enviou: ${l.erro}. Toque para tentar de novo`;
  if (!s || s.status === 'pendente' || s.status === 'lendo') return 'Enviada, lendo';
  if (s.status === 'lida') return `Lida: ${s.tickets} ticket(s)`;
  return 'Precisa tirar de novo';
}

function Selo({ local, servidor }: { local?: Local; servidor?: FotoServidor }) {
  let cor = 'bg-stone-900/75';
  let conteudo: React.ReactNode;
  if (local?.fase === 'enviando') {
    conteudo = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> enviando
      </>
    );
  } else if (local?.fase === 'falhou') {
    cor = 'bg-red-700/90';
    conteudo = (
      <>
        <RotateCw className="h-3.5 w-3.5" /> tentar de novo
      </>
    );
  } else if (!servidor || servidor.status === 'pendente' || servidor.status === 'lendo') {
    conteudo = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> lendo
      </>
    );
  } else if (servidor.status === 'lida') {
    cor = 'bg-emerald-700/90';
    conteudo = (
      <>
        <CheckCircle2 className="h-3.5 w-3.5" /> {servidor.tickets} ticket{servidor.tickets === 1 ? '' : 's'}
      </>
    );
  } else {
    cor = 'bg-amber-600/95';
    conteudo = (
      <>
        <AlertTriangle className="h-3.5 w-3.5" /> tirar de novo
      </>
    );
  }
  return (
    <span className={`absolute inset-x-1 bottom-1 flex items-center justify-center gap-1 rounded-lg px-1 py-1 text-[11px] font-semibold text-white ${cor}`}>
      {conteudo}
    </span>
  );
}

function Casca({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[#FAFAF7]">
      <div className="mx-auto max-w-md px-4 pb-6">{children}</div>
    </main>
  );
}
