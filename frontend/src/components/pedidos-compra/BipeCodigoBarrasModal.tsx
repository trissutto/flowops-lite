'use client';

/**
 * BipeCodigoBarrasModal — o leitor pede o código de barras de cada tamanho
 * na CONFERÊNCIA do pedido de compra (15/10/2026, dono).
 *
 * "Alguns produtos a gente utiliza o próprio código de barras dele": a REF
 * marcada com "código de barras próprio" não imprime etiqueta nossa — o
 * caixa vai bipar a etiqueta do FORNECEDOR. Então, na hora de dar entrada,
 * este modal abre com UMA linha por cor × tamanho com peça, e a pessoa lê
 * uma peça de cada tamanho. O código vai pro cadastro (`ean`) e o bipe do
 * PDV passa a achar a peça por ele.
 *
 * Como funciona com leitor USB (emula teclado + Enter):
 *  - o foco nasce na primeira linha sem código; cada Enter confere o lido
 *    (régua em `lib/codigo-barras-fornecedor.ts`) e pula pra PRÓXIMA linha
 *    sem código, dando a volta;
 *  - erro (curto, símbolo, mesmo EAN já lido em outro tamanho) FICA na tela
 *    até o próximo bipe, e a linha não avança — erro que some sozinho vira
 *    tamanho cadastrado com código errado;
 *  - com tudo lido o foco vai pro "Confirmar": é um Enter HUMANO, não o do
 *    leitor, que dá a entrada.
 *
 * Quem decide se o recebimento sai é o servidor (a mesma régua, mais a
 * conferência contra o catálogo: EAN que já é de OUTRA peça é recusa).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ScanBarcode, X } from 'lucide-react';
import { overlayClose } from '@/lib/overlayClose';
import {
  conferirLeitura,
  linhaComMesmoCodigo,
  montarEansPorGrupo,
  motivoCodigoBarrasInvalido,
  normalizarCodigoBarras,
  proximaLinhaPendente,
  type LinhaBipe,
} from '@/lib/codigo-barras-fornecedor';

export type { LinhaBipe };

export function BipeCodigoBarrasModal({
  titulo,
  linhas,
  onConfirmar,
  onCancelar,
  confirmando = false,
}: {
  /** Ex.: "REF 7031" ou "Pedido #123". */
  titulo: string;
  linhas: LinhaBipe[];
  /** grupo (item ou cor) → tamanho → código normalizado. */
  onConfirmar: (eans: Record<string, Record<string, string>>) => void;
  onCancelar: () => void;
  confirmando?: boolean;
}) {
  const [valores, setValores] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const l of linhas) if (l.inicial) v[l.chave] = normalizarCodigoBarras(l.inicial);
    return v;
  });
  const [erro, setErro] = useState<{ chave: string; texto: string } | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const confirmarRef = useRef<HTMLButtonElement | null>(null);

  const conf = useMemo(() => conferirLeitura(linhas, valores), [linhas, valores]);
  const varias = useMemo(() => new Set(linhas.map((l) => l.grupo)).size > 1, [linhas]);
  const mostraRef = useMemo(() => new Set(linhas.map((l) => l.ref || '')).size > 1, [linhas]);

  const focar = (chave: string | null) => {
    // Depois do render: o input da linha pode ter acabado de montar.
    window.setTimeout(() => {
      if (chave) {
        const el = inputs.current[chave];
        el?.focus();
        el?.select();
      } else {
        confirmarRef.current?.focus();
      }
    }, 0);
  };

  useEffect(() => {
    focar(proximaLinhaPendente(linhas, valores, null));
    // só na abertura: depois quem manda no foco é o Enter de cada linha
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lerLinha = (linha: LinhaBipe, bruto: string) => {
    const codigo = normalizarCodigoBarras(bruto);
    const motivo = motivoCodigoBarrasInvalido(codigo);
    if (motivo) {
      setErro({
        chave: linha.chave,
        texto: `${linha.cor} ${linha.tamanho}: código "${codigo || '(vazio)'}" ${motivo}. Bipe de novo.`,
      });
      focar(linha.chave);
      return;
    }
    const outra = linhaComMesmoCodigo(linhas, valores, linha.chave, codigo);
    if (outra) {
      setErro({
        chave: linha.chave,
        texto:
          `${linha.cor} ${linha.tamanho}: o código ${codigo} já foi lido no tamanho ${outra.tamanho}` +
          (outra.cor !== linha.cor ? ` (${outra.cor})` : '') +
          `. Troque a peça na mão e bipe de novo.`,
      });
      setValores((prev) => ({ ...prev, [linha.chave]: '' }));
      focar(linha.chave);
      return;
    }
    setErro(null);
    const novos = { ...valores, [linha.chave]: codigo };
    setValores(novos);
    focar(proximaLinhaPendente(linhas, novos, linha.chave));
  };

  const confirmar = () => {
    if (!conf.ok || confirmando) return;
    onConfirmar(montarEansPorGrupo(linhas, valores));
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      {...overlayClose(onCancelar)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancelar();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bipe-codigo-barras-titulo"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-slate-200 bg-[#16233a] px-5 py-4 text-white">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#d3ac52] bg-[#d3ac52]/15 text-[#d3ac52]">
            <ScanBarcode className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="bipe-codigo-barras-titulo" className="text-base font-black uppercase tracking-wide">
              Bipe o código de barras · {titulo}
            </h2>
            <p className="mt-1 text-[12.5px] leading-snug text-slate-300">
              Esta peça usa o código de barras do fornecedor. Leia a etiqueta de <b className="text-white">uma peça de cada tamanho</b>:
              o código vai pro cadastro e o caixa passa a bipar por ele.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelar}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
            aria-label="Fechar sem dar entrada"
            title="Fechar sem dar entrada"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-2 text-[12px] font-bold text-slate-600">
          <span>
            <b className={conf.lidas === linhas.length ? 'text-emerald-700' : 'text-[#16233a]'}>{conf.lidas}</b> de{' '}
            {linhas.length} {linhas.length === 1 ? 'tamanho lido' : 'tamanhos lidos'}
          </span>
          <span className="text-slate-400">Enter avança · Esc cancela</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-[10px] uppercase text-slate-500">
              <tr className="border-b border-slate-100">
                {mostraRef && <th className="px-3 py-2 text-left">REF</th>}
                <th className="px-3 py-2 text-left">Cor</th>
                <th className="px-3 py-2 text-left">Tam</th>
                <th className="px-3 py-2 text-right">Pç</th>
                <th className="px-3 py-2 text-left">Código de barras</th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {linhas.map((linha) => {
                const valor = valores[linha.chave] || '';
                const lido = !!normalizarCodigoBarras(valor) && !motivoCodigoBarrasInvalido(valor);
                const comErro = erro?.chave === linha.chave;
                return (
                  <tr
                    key={linha.chave}
                    className={`border-b border-slate-100 ${comErro ? 'bg-rose-50' : lido ? 'bg-emerald-50/60' : ''}`}
                  >
                    {mostraRef && <td className="px-3 py-1.5 font-mono text-xs font-bold text-[#16233a]">{linha.ref}</td>}
                    <td className="px-3 py-1.5 font-bold text-[#16233a]">{linha.cor}</td>
                    <td className="px-3 py-1.5 font-mono font-bold text-[#8c7325]">{linha.tamanho}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{linha.qty}</td>
                    <td className="px-3 py-1.5">
                      <input
                        ref={(el) => { inputs.current[linha.chave] = el; }}
                        value={valor}
                        onChange={(e) => {
                          const v = e.target.value;
                          setValores((prev) => ({ ...prev, [linha.chave]: v }));
                          if (erro?.chave === linha.chave) setErro(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          lerLinha(linha, e.currentTarget.value);
                        }}
                        onFocus={(e) => e.currentTarget.select()}
                        placeholder="bipe aqui"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`Código de barras ${linha.cor} ${linha.tamanho}`}
                        aria-invalid={comErro || undefined}
                        className={`w-full min-w-[180px] rounded-lg border px-3 py-1.5 font-mono text-sm tracking-wide focus:outline-none focus:ring-2 ${
                          comErro
                            ? 'border-rose-400 focus:ring-rose-300'
                            : lido
                              ? 'border-emerald-300 focus:ring-emerald-300'
                              : 'border-slate-300 focus:ring-[#d3ac52]'
                        }`}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {lido && <CheckCircle2 className="inline h-4 w-4 text-emerald-600" aria-label="lido" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {erro && (
          <div
            role="alert"
            className="flex items-start gap-2 border-t border-rose-200 bg-rose-50 px-5 py-2.5 text-[13px] font-bold text-rose-800"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{erro.texto}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <span className="text-[12px] text-slate-500">
            {varias
              ? 'Cada linha é uma cor × tamanho deste recebimento.'
              : 'Leu errado? Clique na linha e bipe de novo por cima.'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancelar}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100"
            >
              Cancelar
            </button>
            <button
              ref={confirmarRef}
              type="button"
              onClick={confirmar}
              disabled={!conf.ok || confirmando}
              title={conf.ok ? 'Dar entrada com estes códigos' : `Faltam ${linhas.length - conf.lidas} tamanho(s) pra ler`}
              className="inline-flex items-center gap-2 rounded-lg bg-[#2E7D46] px-4 py-2 text-sm font-black text-white shadow hover:bg-[#256a3a] focus:outline-none focus:ring-2 focus:ring-[#2E7D46] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {confirmando ? 'Dando entrada…' : 'Confirmar e dar entrada'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
