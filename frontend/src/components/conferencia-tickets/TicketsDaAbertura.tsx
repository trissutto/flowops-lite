'use client';

/**
 * Etapa "tickets do movimento anterior" (16/09/2026) — mora no modal de
 * abertura do caixa e na página /minha-loja/tickets.
 *
 * A operadora fotografa os tickets do último dia de caixa (maquininha, cupom
 * das vendas em dinheiro/PIX, recibo de crediário, comprovante de PIX) pelo
 * PC ou pelo celular (QR). A leitura e a conferência acontecem no servidor —
 * aqui só se envia e se acompanha.
 *
 * Nunca trava a venda: se a etapa não carregar, o caixa abre com um aviso; e
 * sem os tickets em mãos a operadora diz o motivo e segue.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { AlertTriangle, CheckCircle2, ImagePlus, Loader2, Smartphone } from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { comprimirFotoProduto } from '@/lib/comprimir-foto';

type Fotos = { total: number; pendentes: number; lidas: number; erro: number; ilegiveis: number };

type Painel = {
  dia: string | null;
  diaCurto?: string;
  semMovimento?: boolean;
  loteId?: string;
  token?: string;
  linkCelular?: string | null;
  status?: string;
  semTicketsMotivo?: string | null;
  fotos?: Fotos;
  esperado?: { cartoes: number; cupons: number; pix: number; recibos: number; total: number };
};

export type EstadoTickets = {
  /** o modal pode abrir o caixa */
  pronto: boolean;
  loteId?: string;
  fotos?: number;
  /** a etapa não carregou — o caixa abre mesmo assim */
  aviso?: string;
};

const MOTIVOS = [
  'Vou fotografar mais tarde',
  'Os tickets ficaram com outra funcionária',
  'A maquininha não imprimiu',
  'Outro motivo',
];

function linkDoCelular(token: string, doServidor?: string | null): string | null {
  if (typeof window !== 'undefined' && /^https?:\/\//.test(window.location.origin)) {
    return `${window.location.origin}/tickets/${token}`;
  }
  return doServidor || null;
}

function listaEsperada(e: NonNullable<Painel['esperado']>): string {
  const partes: string[] = [];
  if (e.cartoes) partes.push(`${e.cartoes} da maquininha`);
  if (e.cupons) partes.push(`${e.cupons} cupo${e.cupons > 1 ? 'ns' : 'm'} de dinheiro/PIX`);
  if (e.pix) partes.push(`${e.pix} comprovante${e.pix > 1 ? 's' : ''} de PIX`);
  if (e.recibos) partes.push(`${e.recibos} recibo${e.recibos > 1 ? 's' : ''} de crediário`);
  return partes.join(' · ');
}

export default function TicketsDaAbertura({
  storeCode,
  dia,
  onEstado,
}: {
  /** só pra admin operando outra loja */
  storeCode?: string;
  /** dia específico (tarefa da home); sem ele, o último movimento */
  dia?: string;
  onEstado?: (e: EstadoTickets) => void;
}) {
  const [painel, setPainel] = useState<Painel | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [mostrarQr, setMostrarQr] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [enviando, setEnviando] = useState<{ feitas: number; total: number } | null>(null);
  const [falhas, setFalhas] = useState<string[]>([]);
  const [abrirMotivo, setAbrirMotivo] = useState(false);
  const [motivo, setMotivo] = useState(MOTIVOS[0]);
  const [motivoTexto, setMotivoTexto] = useState('');
  const [salvandoMotivo, setSalvandoMotivo] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = new URLSearchParams();
  if (storeCode) query.set('storeCode', storeCode);
  if (dia) query.set('dia', dia);
  const qs = query.toString() ? `?${query.toString()}` : '';

  const carregar = useCallback(async () => {
    try {
      const p = await api<Painel>(`/pdv/conferencia-tickets/abertura${qs}`);
      setPainel(p);
      setErro(null);
    } catch (e: any) {
      setErro(
        e?.body?.message
          ? String(e.body.message)
          : 'Não consegui carregar a etapa de tickets — abra o caixa e envie as fotos depois pela tela inicial.',
      );
    }
  }, [qs]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const loteId = painel?.loteId;
  useEffect(() => {
    if (!loteId) return;
    const socket = getSocket();
    const onLote = (p: any) => {
      if (p?.loteId !== loteId) return;
      setPainel((prev) =>
        prev ? { ...prev, status: p.status, fotos: p.fotos, semTicketsMotivo: p.semTicketsMotivo } : prev,
      );
    };
    socket.on('conferencia-tickets:lote', onLote);
    // O celular manda foto por outro caminho: ao voltar pro PC, relê o placar.
    const aoFocar = () => carregar();
    window.addEventListener('focus', aoFocar);
    return () => {
      socket.off('conferencia-tickets:lote', onLote);
      window.removeEventListener('focus', aoFocar);
    };
  }, [loteId, carregar]);

  const link = painel?.token ? linkDoCelular(painel.token, painel.linkCelular) : null;
  useEffect(() => {
    if (!mostrarQr || !link) return;
    let vivo = true;
    QRCode.toDataURL(link, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
      .then((url) => vivo && setQr(url))
      .catch(() => vivo && setQr(null));
    return () => {
      vivo = false;
    };
  }, [mostrarQr, link]);

  const totalFotos = painel?.fotos?.total || 0;
  useEffect(() => {
    if (!onEstado) return;
    if (erro) return onEstado({ pronto: true, aviso: erro });
    if (!painel) return onEstado({ pronto: false });
    if (!painel.dia || painel.semMovimento) return onEstado({ pronto: true });
    onEstado({
      pronto: !enviando && (totalFotos > 0 || !!painel.semTicketsMotivo),
      loteId: painel.loteId,
      fotos: totalFotos,
    });
  }, [painel, erro, enviando, totalFotos, onEstado]);

  async function enviarArquivos(lista: FileList | null) {
    if (!lista?.length || !loteId) return;
    const arquivos = Array.from(lista);
    setFalhas([]);
    setEnviando({ feitas: 0, total: arquivos.length });
    const erros: string[] = [];
    for (let i = 0; i < arquivos.length; i++) {
      try {
        const foto = await comprimirFotoProduto(arquivos[i]);
        const fd = new FormData();
        fd.append('file', foto);
        const r = await api<{ fotos: Fotos }>(`/pdv/conferencia-tickets/lote/${loteId}/fotos`, {
          method: 'POST',
          body: fd,
        });
        setPainel((prev) => (prev ? { ...prev, fotos: r.fotos, status: 'lendo' } : prev));
      } catch (e: any) {
        erros.push(`${arquivos[i].name}: ${e?.body?.message || 'não enviou'}`);
      }
      setEnviando({ feitas: i + 1, total: arquivos.length });
    }
    setEnviando(null);
    setFalhas(erros);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function salvarMotivo() {
    if (!loteId) return;
    const texto = motivo === 'Outro motivo' ? motivoTexto.trim() : motivo;
    if (texto.length < 3) return;
    setSalvandoMotivo(true);
    try {
      await api(`/pdv/conferencia-tickets/lote/${loteId}/sem-tickets`, {
        method: 'POST',
        body: JSON.stringify({ motivo: texto }),
      });
      setPainel((prev) => (prev ? { ...prev, semTicketsMotivo: texto } : prev));
      setAbrirMotivo(false);
    } catch (e: any) {
      setFalhas([e?.body?.message || 'Não consegui salvar o motivo']);
    } finally {
      setSalvandoMotivo(false);
    }
  }

  if (erro) {
    return (
      <div className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>{erro}</span>
      </div>
    );
  }
  if (!painel) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-gray-200 p-3 text-xs text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Conferindo os tickets do último movimento…
      </div>
    );
  }
  if (!painel.dia) return null;
  if (painel.semMovimento) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          Nada pra fotografar de {painel.diaCurto}: sem venda no cartão, em dinheiro ou PIX, nem recebimento de crediário.
        </span>
      </div>
    );
  }

  const f = painel.fotos || { total: 0, pendentes: 0, lidas: 0, erro: 0, ilegiveis: 0 };
  const problemas = f.erro + f.ilegiveis;

  return (
    <section className="mt-4 rounded-xl border-2 border-rose-200 bg-rose-50/40 p-4" aria-label="Tickets do último movimento">
      <h3 className="text-sm font-bold text-rose-900">📸 Tickets de {painel.diaCurto}</h3>
      {painel.esperado && painel.esperado.total > 0 && (
        <p className="mt-1 text-xs leading-relaxed text-gray-700">
          Fotografe <b>todos</b> os tickets desse dia. O sistema espera {listaEsperada(painel.esperado)}.
          <span className="text-gray-500"> Até 4 tickets por foto, esticados e com boa luz.</span>
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setMostrarQr((v) => !v)}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-lg border-2 border-rose-300 bg-white px-3 text-sm font-semibold text-rose-800 hover:bg-rose-50"
        >
          <Smartphone className="h-5 w-5" /> {mostrarQr ? 'Esconder QR' : 'Fotografar com o celular'}
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={!!enviando}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-lg border-2 border-rose-300 bg-white px-3 text-sm font-semibold text-rose-800 hover:bg-rose-50 disabled:opacity-50"
        >
          <ImagePlus className="h-5 w-5" /> Escolher fotos neste PC
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => enviarArquivos(e.target.files)}
        />
      </div>

      {mostrarQr && (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-lg bg-white p-3 text-center sm:flex-row sm:text-left">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR para enviar as fotos pelo celular" className="h-40 w-40 shrink-0" />
          ) : (
            <div className="grid h-40 w-40 shrink-0 place-items-center text-xs text-gray-400">
              {link ? 'Gerando QR…' : 'Sem link'}
            </div>
          )}
          <div className="text-xs leading-relaxed text-gray-700">
            <b>Aponte a câmera do celular pro QR</b> e tire as fotos por lá. Elas aparecem aqui sozinhas.
            <br />
            <span className="text-gray-500">O link vale até amanhã e só serve pra mandar as fotos desta loja.</span>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
        {enviando ? (
          <span className="flex items-center gap-1.5 font-semibold text-rose-800">
            <Loader2 className="h-4 w-4 animate-spin" /> Enviando {enviando.feitas + 1 > enviando.total ? enviando.total : enviando.feitas + 1} de {enviando.total}…
          </span>
        ) : f.total > 0 ? (
          <span className="flex items-center gap-1.5 font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4" /> {f.total} foto{f.total > 1 ? 's' : ''} recebida{f.total > 1 ? 's' : ''}
          </span>
        ) : (
          <span className="font-semibold text-gray-600">Nenhuma foto ainda</span>
        )}
        {f.lidas > 0 && <span className="text-gray-600">{f.lidas} lida{f.lidas > 1 ? 's' : ''}</span>}
        {f.pendentes > 0 && (
          <span className="flex items-center gap-1 text-gray-600">
            <Loader2 className="h-3 w-3 animate-spin" /> {f.pendentes} lendo
          </span>
        )}
        {problemas > 0 && (
          <span className="font-semibold text-amber-800">
            {problemas} precisa{problemas > 1 ? 'm' : ''} ser tirada{problemas > 1 ? 's' : ''} de novo
          </span>
        )}
      </div>

      {f.total > 0 && !enviando && (
        <p className="mt-1 text-[11px] text-gray-500">
          Pode abrir o caixa: a leitura e a conferência continuam sozinhas. Faltou algum ticket? Mande a foto a qualquer hora.
        </p>
      )}

      {falhas.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-red-700">
          {falhas.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      {painel.semTicketsMotivo ? (
        <p className="mt-3 text-xs text-gray-600">
          Sem tickets agora: <i>{painel.semTicketsMotivo}</i>
        </p>
      ) : f.total === 0 && !abrirMotivo ? (
        <button
          type="button"
          onClick={() => setAbrirMotivo(true)}
          className="mt-3 text-xs font-semibold text-gray-600 underline underline-offset-2 hover:text-gray-900"
        >
          Estou sem os tickets agora
        </button>
      ) : null}

      {abrirMotivo && !painel.semTicketsMotivo && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
          <label className="block text-xs font-semibold text-gray-700" htmlFor="motivo-sem-tickets">
            Por que os tickets não vão agora?
          </label>
          <select
            id="motivo-sem-tickets"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="mt-1 w-full rounded-lg border p-2 text-sm"
          >
            {MOTIVOS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          {motivo === 'Outro motivo' && (
            <input
              value={motivoTexto}
              onChange={(e) => setMotivoTexto(e.target.value)}
              placeholder="Escreva o motivo"
              className="mt-2 w-full rounded-lg border p-2 text-sm"
            />
          )}
          <p className="mt-2 text-[11px] text-gray-500">A matriz vê este motivo na conferência. A tarefa de mandar as fotos continua na tela inicial.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setAbrirMotivo(false)}
              className="flex-1 rounded-lg bg-gray-100 py-2 text-xs font-semibold hover:bg-gray-200"
            >
              Voltar
            </button>
            <button
              type="button"
              onClick={salvarMotivo}
              disabled={salvandoMotivo || (motivo === 'Outro motivo' && motivoTexto.trim().length < 3)}
              className="flex-1 rounded-lg bg-gray-800 py-2 text-xs font-semibold text-white hover:bg-gray-900 disabled:opacity-50"
            >
              {salvandoMotivo ? 'Salvando…' : 'Confirmar'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
