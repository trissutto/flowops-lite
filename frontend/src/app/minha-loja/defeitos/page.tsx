'use client';

/**
 * /minha-loja/defeitos — registro de peça com defeito.
 *
 * Substitui o "marcado baixado", que era dívida de cliente sendo usada pra
 * registrar perda de mercadoria. Aqui a peça sai do estoque da loja na hora,
 * ganha número de controle e entra numa caixa que vai pra matriz (CD).
 *
 * Fluxo pensado pro balcão: o foco fica SEMPRE no campo de bipe. Bipou →
 * escolhe o motivo → confirma → o campo volta a esperar a próxima peça. A
 * vendedora nunca precisa procurar botão nem pensar em caixa (a caixa aberta
 * é criada e mantida sozinha).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft, AlertTriangle, Loader2, Box, Printer, Check, X, PackageCheck,
} from 'lucide-react';

type Motivo = { valor: string; label: string; exigeObservacao: boolean };

type Item = {
  id: string;
  code: string;
  sku: string;
  ref: string | null;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  marca: string | null;
  motivo: string;
  observacao: string | null;
  custoUnitCents: number;
  registradoAt: string;
  registradoPorNome: string | null;
};

type Caixa = {
  id: string;
  code: string;
  status: string;
  totalPecas: number;
  totalCustoCents: number;
} | null;

const brl = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Motivos embutidos como FALLBACK. A lista canônica é a do backend
 * (`GET /defeitos/motivos`, mesma constante que valida o registro) e ela
 * sobrescreve esta assim que chega.
 *
 * Existe porque a lista é estática e minúscula: sem ela, uma oscilação de
 * rede deixaria a tela sem nenhum botão de motivo e a vendedora sem
 * conseguir registrar a peça que está com a peça na mão. Se alguém incluir
 * um motivo novo no backend, ele aparece por aqui sozinho — este array só
 * serve pro caso da chamada falhar.
 */
const MOTIVOS_FALLBACK: Motivo[] = [
  { valor: 'FURO_RASGO', label: 'Furo rasgo', exigeObservacao: false },
  { valor: 'MANCHA', label: 'Mancha', exigeObservacao: false },
  { valor: 'COSTURA_SOLTA', label: 'Costura solta', exigeObservacao: false },
  { valor: 'ZIPER_BOTAO', label: 'Ziper botao', exigeObservacao: false },
  { valor: 'DESBOTADO', label: 'Desbotado', exigeObservacao: false },
  { valor: 'FALTA_PECA', label: 'Falta peca', exigeObservacao: false },
  { valor: 'MODELAGEM_ERRADA', label: 'Modelagem errada', exigeObservacao: false },
  { valor: 'OUTRO', label: 'Outro', exigeObservacao: true },
];

export default function DefeitosPage() {
  const [motivos, setMotivos] = useState<Motivo[]>(MOTIVOS_FALLBACK);
  const [caixa, setCaixa] = useState<Caixa>(null);
  const [itens, setItens] = useState<Item[]>([]);
  const [carregando, setCarregando] = useState(true);

  // Formulário
  const [sku, setSku] = useState('');
  const [motivo, setMotivo] = useState('');
  const [observacao, setObservacao] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const skuRef = useRef<HTMLInputElement>(null);

  const motivoSelecionado = motivos.find((m) => m.valor === motivo);
  const exigeObs = !!motivoSelecionado?.exigeObservacao;

  const carregar = useCallback(async () => {
    try {
      const r = await api<{ caixa: Caixa; itens: Item[] }>('/defeitos/caixa-atual');
      setCaixa(r.caixa);
      setItens(r.itens || []);
    } catch (e: any) {
      setErro(e?.message || 'Erro ao carregar a caixa');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    // Lista do servidor sobrescreve o fallback; se a chamada falhar, a tela
    // continua utilizável com os motivos embutidos.
    api<Motivo[]>('/defeitos/motivos')
      .then((r) => { if (Array.isArray(r) && r.length) setMotivos(r); })
      .catch(() => {});
    carregar();
  }, [carregar]);

  // O balcão trabalha no bipe: o foco volta pro campo depois de cada peça.
  const focarBipe = () => setTimeout(() => skuRef.current?.focus(), 50);
  useEffect(() => { focarBipe(); }, []);

  const registrar = async () => {
    setErro(null);
    setOk(null);
    if (!sku.trim()) { setErro('Bipe ou digite o código da peça'); focarBipe(); return; }
    if (!motivo) { setErro('Escolha o motivo do defeito'); return; }
    if (exigeObs && observacao.trim().length < 3) {
      setErro('Motivo "Outro" exige descrever o defeito');
      return;
    }
    setSalvando(true);
    try {
      const r = await api<Item>('/defeitos', {
        method: 'POST',
        body: JSON.stringify({
          sku: sku.trim(),
          motivo,
          observacao: observacao.trim() || undefined,
        }),
      });
      setOk(`${r.code} · ${r.ref || r.sku} ${r.cor || ''} ${r.tamanho || ''} — fora do estoque`);
      setSku('');
      setObservacao('');
      // Motivo permanece: é comum registrar várias peças do mesmo problema.
      await carregar();
      focarBipe();
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Erro ao registrar');
      focarBipe();
    } finally {
      setSalvando(false);
    }
  };

  const fecharCaixa = async () => {
    if (!caixa) return;
    if (!confirm(
      `Fechar a caixa ${caixa.code} com ${caixa.totalPecas} peça(s)?\n\n` +
      `Depois de fechada ela vai pra matriz e o próximo defeito abre uma caixa nova. ` +
      `O romaneio abre pra impressão — cole por fora da caixa.`,
    )) return;
    try {
      await api(`/defeitos/caixas/${caixa.id}/fechar`, { method: 'POST' });
      window.open(`/minha-loja/defeitos/romaneio/${caixa.id}`, '_blank');
      await carregar();
      setOk(`Caixa ${caixa.code} fechada — pronta pra ir pra matriz.`);
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Erro ao fechar a caixa');
    }
  };

  const labelMotivo = (v: string) => motivos.find((m) => m.valor === v)?.label || v;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/minha-loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-amber-700" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Peças com defeito</h1>
            <p className="text-xs text-slate-500">
              Sai do estoque da loja e vai pra matriz
            </p>
          </div>
          {caixa && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Caixa aberta</div>
              <div className="font-mono font-black text-slate-800">{caixa.code}</div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">
        {/* Registro */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <div className="text-[11px] font-black uppercase tracking-wider text-slate-500 mb-3">
            Registrar peça
          </div>

          <label className="block text-xs font-bold text-slate-600 mb-1">
            Código da etiqueta
          </label>
          <input
            ref={skuRef}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            onKeyDown={(e) => {
              // Enter no bipe já registra quando o motivo está escolhido —
              // leitor de código de barras manda Enter no fim da leitura.
              if (e.key === 'Enter') {
                e.preventDefault();
                if (motivo) void registrar();
              }
            }}
            placeholder="Bipe a etiqueta da peça"
            inputMode="numeric"
            className="w-full h-16 px-4 border-2 border-slate-800 rounded-xl font-mono text-3xl font-black tracking-wider text-slate-800 bg-white outline-none focus:border-amber-500 focus:ring-4 focus:ring-amber-100"
          />

          <div className="mt-3">
            <label className="block text-xs font-bold text-slate-600 mb-1">
              Qual é o defeito?
            </label>
            <div className="flex flex-wrap gap-2">
              {motivos.map((m) => (
                <button
                  key={m.valor}
                  type="button"
                  onClick={() => setMotivo(m.valor)}
                  className={`px-3 py-2 rounded-lg text-sm font-bold border-2 transition ${
                    motivo === m.valor
                      ? 'bg-amber-500 border-amber-600 text-white shadow'
                      : 'bg-white border-slate-200 text-slate-700 hover:border-amber-300'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {(exigeObs || observacao) && (
            <div className="mt-3">
              <label className="block text-xs font-bold text-slate-600 mb-1">
                Descreva o defeito {exigeObs && <span className="text-rose-600">*</span>}
              </label>
              <input
                value={observacao}
                onChange={(e) => setObservacao(e.target.value)}
                placeholder="Ex: mancha de tinta na manga direita"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          )}

          {erro && (
            <div className="mt-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-3 text-sm font-bold flex items-start gap-2">
              <X className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{erro}</span>
            </div>
          )}
          {ok && (
            <div className="mt-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg p-3 text-sm font-bold flex items-start gap-2">
              <Check className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{ok}</span>
            </div>
          )}

          <button
            onClick={registrar}
            disabled={salvando}
            className="mt-3 w-full h-12 rounded-xl bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white font-black flex items-center justify-center gap-2"
          >
            {salvando ? <Loader2 className="w-5 h-5 animate-spin" /> : <AlertTriangle className="w-5 h-5" />}
            Registrar defeito e tirar do estoque
          </button>
        </section>

        {/* Caixa atual */}
        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3">
            <Box className="w-4 h-4 text-slate-500" />
            <div className="flex-1">
              <div className="text-sm font-black text-slate-800">
                Caixa {caixa?.code || '—'}
              </div>
              <div className="text-xs text-slate-500">
                {itens.length} peça{itens.length === 1 ? '' : 's'} · {brl(caixa?.totalCustoCents || 0)} em custo
              </div>
            </div>
            {caixa && itens.length > 0 && (
              <button
                onClick={fecharCaixa}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg"
                title="Fecha a caixa e abre o romaneio pra imprimir"
              >
                <PackageCheck className="w-4 h-4" />
                Fechar caixa
              </button>
            )}
          </div>

          {carregando ? (
            <div className="p-10 text-center">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" />
            </div>
          ) : itens.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Nenhuma peça registrada ainda. Bipe a primeira acima.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {itens.map((it) => (
                <div key={it.id} className="px-4 py-3 flex items-center gap-3">
                  <span className="font-mono text-[11px] font-black bg-slate-100 text-slate-700 px-2 py-1 rounded shrink-0">
                    {it.code}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-slate-800 truncate">
                      {it.ref || it.sku} {it.cor} {it.tamanho}
                      {it.marca && <span className="ml-2 text-[10px] font-bold text-slate-500">{it.marca}</span>}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {labelMotivo(it.motivo)}
                      {it.observacao ? ` · ${it.observacao}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-black text-slate-700 tabular-nums">
                      {brl(it.custoUnitCents)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {new Date(it.registradoAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {caixa && itens.length > 0 && (
            <div className="px-4 py-2 border-t border-slate-100 bg-slate-50">
              <Link
                href={`/minha-loja/defeitos/romaneio/${caixa.id}`}
                target="_blank"
                className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900"
              >
                <Printer className="w-3.5 h-3.5" />
                Ver romaneio da caixa
              </Link>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
