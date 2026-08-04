'use client';

/**
 * /retaguarda/fechamento-caixa — FECHAMENTO / CONFERÊNCIA DE CAIXA POR LOJA
 *
 * Tela cheia do super painel (04/08, layout aprovado pelo dono). Uma loja e um
 * dia por vez, em três colunas:
 *
 *   1) o que vendeu, por forma de pagamento (com cascata até a venda)
 *   2) o que TEM que estar na gaveta (composição do dinheiro esperado)
 *   3) o veredito: contado × esperado, diferença e ação
 *
 * REGRAS QUE ESTA TELA RESPEITA (e que o mockup original errava):
 *  - Desconto e cancelamento NÃO são subtraídos de novo: o `total` da venda já
 *    é o valor cobrado e venda cancelada nem entra no relatório.
 *  - Gaveta ≠ faturamento. O que se confere fisicamente é SÓ dinheiro:
 *    fundo + vendas em dinheiro + crediário recebido em dinheiro + suprimentos
 *    − sangrias. Cartão, PIX e crediário ficam do lado do faturamento.
 *  - Faturamento = vendido − vale-troca − devoluções, com frete dentro
 *    (régua oficial do dono, 04/08) — vem pronto do backend.
 *  - Marcado aparece, mas fora de tudo: não gerou movimento de dinheiro.
 *
 * Fonte: MESMO payload do super painel (ao vivo ou histórico), então os dois
 * nunca divergem.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Printer, RefreshCw, Banknote, QrCode, CreditCard, Wallet,
  AlertCircle, CheckCircle2, Globe, User, Lock, Unlock, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';

// ── Paleta da casa (CLAUDE.md): claro, dourado de acento, verde só pra dinheiro
const OURO = '#D4AF37';
const OURO_ESCURO = '#8C7325';
const VERDE = '#2E7D46';

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const toYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Tolerância de caixa: até isso a diferença é quebra de troco, não furo. */
const TOLERANCIA = 2;

type Slot = { valor: number; qtd: number; vendas: any[] };
type Loja = {
  storeCode: string;
  storeName: string;
  aberta: boolean;
  openedAt: string | null;
  openedByName: string | null;
  fundoTroco: number;
  faturamento?: number;
  totalDevolucoes?: number;
  totalDevolucoesDinheiro?: number;
  totalDevolucoesPix?: number;
  totalFrete?: number;
  checkedAt?: string | null;
  checkedByName?: string | null;
  sessionsDoDia?: string[];
  sessionId?: string | null;
  totais: any;
  movimentos?: Array<{ id: string; tipo: string; valor: number; motivo: string; userName: string | null; isFechamento?: boolean; createdAt: string }>;
  recebimentosCrediario?: { totalGeral: number; totalDinheiro: number; totalPix: number; baixas: any[] };
  detalhado: { totais: Record<string, Slot> } | null;
};

const BANDEIRAS_CREDITO = ['MASTERCARD', 'VISANET', 'CIELO', 'ELO', 'AMEX', 'HIPERCARD', 'CREDITO_GENERICO'];
const BANDEIRAS_DEBITO = ['VISA_ELECTRON', 'REDE_SHOP', 'ELO_DEBITO', 'DEBITO_GENERICO'];
const BANDEIRA_LABEL: Record<string, string> = {
  MASTERCARD: 'Mastercard', VISANET: 'Visa', CIELO: 'Cielo', ELO: 'Elo',
  AMEX: 'Amex', HIPERCARD: 'Hipercard', CREDITO_GENERICO: 'Sem bandeira',
  VISA_ELECTRON: 'Visa Electron', REDE_SHOP: 'Redeshop', ELO_DEBITO: 'Elo débito',
  DEBITO_GENERICO: 'Sem bandeira',
};
const ONLINE_LABEL: Record<string, string> = {
  pix: 'PIX direto', link: 'Link externo', pagarme_link: 'Link cartão', '': 'Sem formato',
};

export default function FechamentoCaixaPage() {
  const router = useRouter();
  const params = useSearchParams();
  const hoje = toYmd(new Date());

  const [storeCode, setStoreCode] = useState(params.get('storeCode') || '');
  const [date, setDate] = useState(params.get('date') || hoje);
  const [lojas, setLojas] = useState<Loja[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [contado, setContado] = useState('');
  const [obs, setObs] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const aoVivo = date === hoje;

  async function carregar() {
    setLoading(true);
    setErro(null);
    try {
      const url = aoVivo
        ? '/pdv/caixa/super-painel'
        : `/pdv/caixa/super-painel-historico?from=${date}&to=${date}`;
      const r = await api<{ lojas: Loja[] }>(url);
      setLojas(r?.lojas || []);
      if (!storeCode && r?.lojas?.length) {
        const maior = [...r.lojas].sort(
          (a, b) => (b.faturamento ?? b.totais?.totalVendas ?? 0) - (a.faturamento ?? a.totais?.totalVendas ?? 0),
        )[0];
        setStoreCode(maior.storeCode);
      }
    } catch (e: any) {
      setErro(e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Mantém a URL compartilhável (o dono manda link da loja/dia pra conferência)
  useEffect(() => {
    if (!storeCode) return;
    const qs = new URLSearchParams({ storeCode, date });
    router.replace(`/retaguarda/fechamento-caixa?${qs.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCode, date]);

  const loja = useMemo(
    () => lojas.find((l) => l.storeCode === storeCode) || null,
    [lojas, storeCode],
  );

  const t = loja?.totais || {};
  const det = loja?.detalhado?.totais || null;
  const rec = loja?.recebimentosCrediario;
  const movimentos = loja?.movimentos || [];
  const sangrias = movimentos.filter((m) => m.tipo === 'sangria' && !m.isFechamento);
  const suprimentos = movimentos.filter((m) => m.tipo === 'suprimento');
  const fechamentoMov = movimentos.find((m) => m.isFechamento) || null;

  // ── Faturamento (régua oficial — vem pronto do backend) ──
  const vendido = Number(t.totalVendas) || 0;
  const vale = Number(t.totalValeTroca) || 0;
  const devolucoes = Number(loja?.totalDevolucoes) || 0;
  const faturamento = Number(loja?.faturamento ?? (vendido - vale - devolucoes));
  const formas =
    (Number(t.totalDinheiro) || 0) + (Number(t.totalPix) || 0) +
    (Number(t.totalCartaoCredito) || 0) + (Number(t.totalCartaoDebito) || 0) +
    (Number(t.totalCrediario) || 0) + (Number(t.totalVendaOnline) || 0);
  const formasLiquidas = Math.round((formas - devolucoes) * 100) / 100;
  const bateFaturamento = Math.abs(faturamento - formasLiquidas) < 0.02;

  // ── Gaveta: SÓ dinheiro (é isto que se confere fisicamente) ──
  const fundo = Number(loja?.fundoTroco) || 0;
  const dinVendas = Number(t.totalDinheiro) || 0;
  const dinCrediario = Number(rec?.totalDinheiro) || 0;
  const totalSuprimentos = Number(t.totalSuprimentos) || 0;
  const totalSangrias = Number(t.totalSangrias) || 0;
  const devolvidoDinheiro = Number(loja?.totalDevolucoesDinheiro) || 0;
  const esperado = Math.round(
    (fundo + dinVendas + dinCrediario + totalSuprimentos - totalSangrias) * 100,
  ) / 100;

  const contadoNum = Number((contado || '').replace(/\./g, '').replace(',', '.'));
  const temContagem = contado.trim() !== '' && !isNaN(contadoNum);
  const diferenca = temContagem ? Math.round((contadoNum - esperado) * 100) / 100 : 0;
  const dentroTolerancia = Math.abs(diferenca) <= TOLERANCIA;

  async function finalizar() {
    if (!loja) return;
    setSalvando(true);
    setErro(null);
    setOkMsg(null);
    try {
      if (loja.aberta) {
        // Caixa ainda aberto: fecha com a contagem (se houver). Sem contagem, o
        // caixa fecha e a conferência acontece na abertura do dia seguinte —
        // que é o fluxo padrão da rede.
        await api('/pdv/caixa/fechar', {
          method: 'POST',
          body: JSON.stringify({
            storeCode: loja.storeCode,
            dinheiroFisico: temContagem ? contadoNum : undefined,
            observacao: montarObservacao(),
          }),
        });
        setOkMsg('Caixa fechado.');
      } else {
        const ids = loja.sessionsDoDia?.length
          ? loja.sessionsDoDia
          : (loja.sessionId ? [loja.sessionId] : []);
        if (!ids.length) throw new Error('Sem sessão de caixa neste dia pra marcar como conferida.');
        await api('/pdv/caixa/admin/check-sessions', {
          method: 'POST',
          body: JSON.stringify({ sessionIds: ids, note: montarObservacao() }),
        });
        setOkMsg('Caixa marcado como conferido.');
      }
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Falha ao salvar');
    } finally {
      setSalvando(false);
    }
  }

  function montarObservacao(): string | undefined {
    const partes: string[] = [];
    if (temContagem) {
      partes.push(
        `Contado R$ ${contadoNum.toFixed(2)} · esperado R$ ${esperado.toFixed(2)} · diferença R$ ${diferenca.toFixed(2)}`,
      );
    }
    if (obs.trim()) partes.push(obs.trim());
    return partes.length ? partes.join(' — ') : undefined;
  }

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {/* ── Cabeçalho ── */}
      <header className="bg-white border-b border-[#E5E2D9] sticky top-0 z-20 print:hidden">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Link
            href="/retaguarda/super-painel-caixas"
            className="p-2 rounded-lg hover:bg-[#FBF6E6] text-slate-600"
            title="Voltar pro super painel"
          >
            <ArrowLeft size={20} />
          </Link>
          <Wallet size={22} style={{ color: OURO_ESCURO }} />
          <div className="flex-1 min-w-[220px]">
            <h1 className="text-xl font-black text-slate-900 tracking-tight">FECHAMENTO DE CAIXA</h1>
            <p className="text-xs text-slate-500">
              Confira os valores e finalize o fechamento do caixa.
            </p>
          </div>

          {/* Loja + data ficam no cabeçalho: é a chave da tela inteira */}
          <select
            value={storeCode}
            onChange={(e) => { setStoreCode(e.target.value); setContado(''); setOkMsg(null); }}
            className="px-3 py-2 border border-[#E5E2D9] rounded-lg text-sm font-bold bg-white min-w-[220px]"
          >
            {lojas.map((l) => (
              <option key={l.storeCode} value={l.storeCode}>
                {l.storeName} ({l.storeCode})
              </option>
            ))}
          </select>
          <input
            type="date"
            value={date}
            max={hoje}
            onChange={(e) => { setDate(e.target.value); setContado(''); setOkMsg(null); }}
            className="px-3 py-2 border border-[#E5E2D9] rounded-lg text-sm font-mono"
          />
          <button
            onClick={() => carregar()}
            disabled={loading}
            className="px-3 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-50 flex items-center gap-1.5"
            style={{ background: OURO_ESCURO }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Atualizar
          </button>
          <button
            onClick={() => window.print()}
            className="px-3 py-2 rounded-lg text-sm font-bold border border-[#E5E2D9] hover:bg-[#FBF6E6] flex items-center gap-1.5 text-slate-700"
          >
            <Printer size={14} /> Imprimir
          </button>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-4 space-y-4">
        {erro && (
          <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertCircle size={18} /> {erro}
          </div>
        )}
        {okMsg && (
          <div className="bg-emerald-50 border border-emerald-300 text-emerald-800 rounded-lg p-3 text-sm flex items-center gap-2">
            <CheckCircle2 size={18} /> {okMsg}
          </div>
        )}

        {loading && !loja && (
          <div className="text-center text-slate-400 py-20 text-sm">Carregando…</div>
        )}

        {loja && (
          <>
            {/* ── Identificação da loja/dia ── */}
            <div className="bg-white rounded-xl border border-[#E5E2D9] px-4 py-3 flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1.5 font-black text-slate-900 uppercase">
                {loja.aberta ? <Unlock size={16} className="text-emerald-600" /> : <Lock size={16} className="text-slate-400" />}
                {loja.storeName}
                <span className="font-mono text-xs text-slate-400">{loja.storeCode}</span>
              </span>
              <span className="text-xs text-slate-500">
                {new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                {loja.openedByName ? ` · abertura por ${loja.openedByName}` : ''}
              </span>
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                loja.aberta ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
              }`}>
                {loja.aberta ? 'CAIXA ABERTO' : 'CAIXA FECHADO'}
              </span>
              {loja.checkedAt && (
                <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                  ✓ conferido por {loja.checkedByName || '—'}
                </span>
              )}
            </div>

            {/* ── KPIs: faturamento · gaveta · diferença ── */}
            <div className="grid sm:grid-cols-3 gap-3">
              <Kpi
                label="Faturamento"
                valor={faturamento}
                cor={VERDE}
                detalhe={
                  <>
                    vendido {brl(vendido)}
                    {vale > 0 && <> − vale {brl(vale)}</>}
                    {devolucoes > 0 && <> − devoluções {brl(devolucoes)}</>}
                    {(loja.totalFrete || 0) > 0 && <> · frete incluso {brl(loja.totalFrete || 0)}</>}
                  </>
                }
                icon={<Banknote size={18} />}
              />
              <Kpi
                label="Dinheiro esperado na gaveta"
                valor={esperado}
                cor={OURO_ESCURO}
                detalhe={<>fundo + dinheiro + crediário + suprimentos − sangrias</>}
                icon={<Wallet size={18} />}
              />
              <Kpi
                label="Diferença"
                valor={temContagem ? diferenca : 0}
                cor={!temContagem ? '#94A3B8' : dentroTolerancia ? VERDE : '#BE123C'}
                detalhe={temContagem
                  ? (dentroTolerancia ? 'dentro da tolerância' : `acima da tolerância de ${brl(TOLERANCIA)}`)
                  : 'informe o valor contado ao lado'}
                icon={temContagem && !dentroTolerancia ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
              />
            </div>

            {/* ── 3 colunas: pagamentos · gaveta · veredito ── */}
            <div className="grid lg:grid-cols-3 gap-4 items-start">
              {/* 1) RESUMO DE PAGAMENTOS */}
              <Bloco titulo="Resumo de pagamentos" className="lg:col-span-1">
                <FormaLinha
                  label="Dinheiro" cor={VERDE} icon={<Banknote size={14} />}
                  valor={t.totalDinheiro} qtd={det?.DINHEIRO?.qtd} total={formas}
                  vendas={det?.DINHEIRO?.vendas}
                />
                <FormaLinha
                  label="PIX" cor="#0891B2" icon={<QrCode size={14} />}
                  valor={t.totalPix} qtd={det?.PIX?.qtd} total={formas}
                  vendas={det?.PIX?.vendas}
                />
                <FormaLinha
                  label="Cartão de Crédito" cor="#2563EB" icon={<CreditCard size={14} />}
                  valor={t.totalCartaoCredito} total={formas}
                  subitens={bandeiras(det, BANDEIRAS_CREDITO)}
                />
                <FormaLinha
                  label="Cartão de Débito" cor="#4F46E5" icon={<CreditCard size={14} />}
                  valor={t.totalCartaoDebito} total={formas}
                  subitens={bandeiras(det, BANDEIRAS_DEBITO)}
                />
                <FormaLinha
                  label="Crediário" cor="#BE185D" icon={<User size={14} />}
                  valor={t.totalCrediario} qtd={det?.CREDIARIO?.qtd} total={formas}
                  vendas={det?.CREDIARIO?.vendas}
                />
                <FormaLinha
                  label="Venda Online" cor="#7C3AED" icon={<Globe size={14} />}
                  valor={t.totalVendaOnline} total={formas}
                  subitens={formatosOnline(det)}
                />

                <div className="flex items-center justify-between pt-2 mt-1 border-t-2 border-[#E5E2D9] font-black text-slate-900">
                  <span className="uppercase text-xs tracking-wide">Total recebido</span>
                  <span className="font-mono tabular-nums">{brl(formas)}</span>
                </div>

                {/* Conciliação: faturamento × formas (devolução sai dos 2 lados) */}
                <div className={`mt-2 rounded-lg px-2.5 py-2 text-[11px] border ${
                  bateFaturamento
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                    : 'bg-amber-50 border-amber-400 text-amber-900'
                }`}>
                  <div className="font-bold uppercase tracking-wide">
                    {bateFaturamento ? '✓ Fecha com o faturamento' : '⚠️ Não fecha com o faturamento'}
                  </div>
                  <div className="font-mono mt-0.5">
                    faturamento {brl(faturamento)} vs formas {brl(formasLiquidas)}
                    {devolucoes > 0 && <span className="opacity-70"> ({brl(formas)} − devoluções {brl(devolucoes)})</span>}
                  </div>
                </div>

                {(Number(t.totalMarcados) || 0) > 0 && (
                  <div className="mt-2 rounded-lg px-2.5 py-2 text-[11px] bg-slate-50 border border-slate-200 text-slate-600">
                    <b>{t.qtdMarcados || 0} marcado(s)</b> · {brl(t.totalMarcados)} — peça que a cliente
                    levou pra provar. Não é venda e não gerou dinheiro: fica fora de tudo acima.
                  </div>
                )}
              </Bloco>

              {/* 2) DINHEIRO NO CAIXA — composição do esperado */}
              <Bloco titulo="Dinheiro no caixa" className="lg:col-span-1">
                <Linha label="Fundo do caixa (abertura)" valor={fundo} />
                <Linha label="(+) Vendas em dinheiro" valor={dinVendas} cor={VERDE} />
                <Linha
                  label="(+) Crediário recebido em dinheiro"
                  valor={dinCrediario}
                  cor={VERDE}
                  detalhe={rec?.baixas?.length ? `${rec.baixas.length} baixa(s)` : undefined}
                />
                <Linha label="(+) Suprimentos" valor={totalSuprimentos} cor="#0369A1"
                  detalhe={suprimentos.length ? `${suprimentos.length} lanc.` : undefined}
                  itens={suprimentos.map((m) => ({
                    titulo: m.motivo || '(sem motivo)',
                    sub: `${new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}${m.userName ? ` · ${m.userName.split(' ')[0]}` : ''}`,
                    valor: m.valor,
                  }))}
                />
                <Linha label="(−) Sangrias" valor={-totalSangrias} cor="#BE123C"
                  detalhe={sangrias.length ? `${sangrias.length} lanc.` : undefined}
                  itens={sangrias.map((m) => ({
                    titulo: m.motivo || '(sem motivo)',
                    sub: `${new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}${m.userName ? ` · ${m.userName.split(' ')[0]}` : ''}`,
                    valor: -m.valor,
                  }))}
                />
                {devolvidoDinheiro > 0 && (
                  <div className="text-[10px] text-slate-500 italic pl-1">
                    inclui {brl(devolvidoDinheiro)} de devolução em dinheiro (saiu por sangria)
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 mt-1 border-t-2 border-[#E5E2D9]">
                  <span className="uppercase text-xs tracking-wide font-black text-slate-900">
                    Total esperado
                  </span>
                  <span className="font-mono tabular-nums font-black text-lg" style={{ color: VERDE }}>
                    {brl(esperado)}
                  </span>
                </div>

                {fechamentoMov && (
                  <div className="mt-2 rounded-lg px-2.5 py-2 text-[11px] bg-violet-50 border border-violet-200 text-violet-900">
                    <div className="font-bold">🔒 Fechamento já registrado · {brl(fechamentoMov.valor)}</div>
                    <div className="opacity-80">
                      {fechamentoMov.userName || 'contagem na abertura do dia seguinte'}
                    </div>
                  </div>
                )}

                <p className="text-[10px] text-slate-400 mt-2 leading-snug">
                  Cartão, PIX e crediário não entram aqui — eles não passam pela gaveta.
                  A conferência física é só do dinheiro.
                </p>
              </Bloco>

              {/* 3) CONFERÊNCIA */}
              <Bloco titulo="Conferência do caixa" className="lg:col-span-1">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-600">Total esperado</span>
                    <span className="font-mono tabular-nums font-bold">{brl(esperado)}</span>
                  </div>

                  <label className="block text-xs font-bold text-slate-700 mt-3">
                    Total contado na gaveta (R$)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={contado}
                    onChange={(e) => setContado(e.target.value.replace(/[^\d.,]/g, ''))}
                    placeholder="0,00"
                    className="w-full px-3 py-3 border-2 rounded-lg text-lg font-mono tabular-nums text-right focus:outline-none"
                    style={{ borderColor: contado ? OURO : '#E5E2D9' }}
                  />

                  <div className="flex items-center justify-between text-sm pt-1">
                    <span className="text-slate-600">Diferença</span>
                    <span
                      className="font-mono tabular-nums font-black"
                      style={{ color: !temContagem ? '#94A3B8' : dentroTolerancia ? VERDE : '#BE123C' }}
                    >
                      {temContagem ? `${diferenca > 0 ? '+' : ''}${brl(diferenca)}` : '—'}
                    </span>
                  </div>

                  {temContagem && (
                    <div className={`rounded-lg p-3 flex items-start gap-2 ${
                      dentroTolerancia
                        ? 'bg-emerald-50 border border-emerald-200'
                        : 'bg-rose-50 border border-rose-200'
                    }`}>
                      {dentroTolerancia
                        ? <CheckCircle2 size={20} className="text-emerald-600 shrink-0" />
                        : <AlertCircle size={20} className="text-rose-600 shrink-0" />}
                      <div className="text-xs">
                        <div className={`font-black uppercase ${dentroTolerancia ? 'text-emerald-800' : 'text-rose-800'}`}>
                          {dentroTolerancia ? 'Caixa confere' : diferenca > 0 ? 'Sobra no caixa' : 'Falta no caixa'}
                        </div>
                        <div className={dentroTolerancia ? 'text-emerald-700' : 'text-rose-700'}>
                          {dentroTolerancia
                            ? `Diferença dentro do permitido (${brl(TOLERANCIA)}).`
                            : `Confira sangria não anotada, troco e recebimento de crediário.`}
                        </div>
                      </div>
                    </div>
                  )}

                  <label className="block text-xs font-bold text-slate-700 mt-3">
                    Observações (opcional)
                  </label>
                  <textarea
                    value={obs}
                    onChange={(e) => setObs(e.target.value)}
                    rows={3}
                    placeholder="Ex: faltou R$ 2,00 — sangria do motoboy não anotada"
                    className="w-full px-3 py-2 border border-[#E5E2D9] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37]"
                  />

                  <button
                    onClick={finalizar}
                    disabled={salvando}
                    className="w-full mt-2 py-3 rounded-xl font-black text-white flex items-center justify-center gap-2 disabled:opacity-50"
                    style={{ background: VERDE }}
                  >
                    <Lock size={16} />
                    {salvando
                      ? 'Salvando…'
                      : loja.aberta ? 'FINALIZAR FECHAMENTO' : 'CONFIRMAR CONFERÊNCIA'}
                  </button>

                  <p className="text-[10px] text-slate-500 leading-snug">
                    {loja.aberta
                      ? 'Sem informar a contagem, o caixa fecha e a conferência acontece na abertura de amanhã — que é o fluxo padrão da rede.'
                      : 'O caixa deste dia já está fechado; aqui você registra a conferência e a diferença encontrada.'}
                  </p>
                </div>
              </Bloco>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Helpers de dados
// ════════════════════════════════════════════════════════════════════

/** Bandeiras com movimento, no formato de subitem da cascata. */
function bandeiras(det: Record<string, Slot> | null, chaves: string[]) {
  if (!det) return [];
  return chaves
    .map((k) => ({ chave: k, slot: det[k] }))
    .filter((x) => x.slot && x.slot.qtd > 0)
    .map((x) => ({
      titulo: BANDEIRA_LABEL[x.chave] || x.chave.replace(/_/g, ' '),
      qtd: x.slot.qtd,
      valor: x.slot.valor,
      vendas: x.slot.vendas,
    }));
}

/** Venda online quebrada por formato (PIX direto / link externo / link cartão). */
function formatosOnline(det: Record<string, Slot> | null) {
  const vendas = det?.VENDA_ONLINE?.vendas || [];
  const grupos = new Map<string, any[]>();
  for (const v of vendas) {
    const k = String(v.onlineTipo || '');
    grupos.set(k, [...(grupos.get(k) || []), v]);
  }
  return [...grupos.entries()].map(([k, vs]) => ({
    titulo: ONLINE_LABEL[k] || k,
    qtd: vs.length,
    valor: vs.reduce((a, v) => a + (Number(v.valor) || 0), 0),
    vendas: vs,
  }));
}

// ════════════════════════════════════════════════════════════════════
// Componentes
// ════════════════════════════════════════════════════════════════════

function Kpi({ label, valor, cor, detalhe, icon }: {
  label: string; valor: number; cor: string; detalhe: React.ReactNode; icon: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-[#E5E2D9] p-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500">{label}</div>
        <div className="text-3xl font-black tabular-nums mt-0.5" style={{ color: cor }}>
          {brl(valor)}
        </div>
        <div className="text-[10px] text-slate-500 font-mono mt-0.5 leading-snug">{detalhe}</div>
      </div>
      <div className="shrink-0 rounded-lg p-2" style={{ background: '#FBF6E6', color: cor }}>
        {icon}
      </div>
    </div>
  );
}

function Bloco({ titulo, children, className = '' }: {
  titulo: string; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`bg-white rounded-xl border border-[#E5E2D9] ${className}`}>
      <header className="px-4 py-2.5 border-b border-[#E5E2D9]">
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-700">{titulo}</h2>
      </header>
      <div className="p-3 space-y-1.5">{children}</div>
    </section>
  );
}

/** Linha de forma de pagamento com cascata (bandeiras/formatos ou vendas). */
function FormaLinha({ label, cor, icon, valor, qtd, total, vendas, subitens }: {
  label: string; cor: string; icon: React.ReactNode;
  valor: number; qtd?: number; total: number;
  vendas?: any[];
  subitens?: Array<{ titulo: string; qtd: number; valor: number; vendas: any[] }>;
}) {
  const [aberto, setAberto] = useState(false);
  const [subAberto, setSubAberto] = useState<string | null>(null);
  const v = Number(valor) || 0;
  const pct = total > 0 ? (v / total) * 100 : 0;
  const temDetalhe = (vendas?.length || 0) > 0 || (subitens?.length || 0) > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => temDetalhe && setAberto((x) => !x)}
        disabled={!temDetalhe}
        className={`w-full flex items-center gap-2 py-1.5 px-1 rounded-lg text-left ${
          temDetalhe ? 'hover:bg-[#FBF6E6] cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="shrink-0" style={{ color: v > 0 ? cor : '#CBD5E1' }}>{icon}</span>
        <span className={`flex-1 text-sm font-semibold ${v > 0 ? 'text-slate-800' : 'text-slate-400'}`}>
          {label}
        </span>
        {qtd !== undefined && qtd > 0 && (
          <span className="text-[10px] text-slate-400 font-mono">{qtd}</span>
        )}
        <span className="text-[10px] text-slate-400 font-mono w-12 text-right">
          {v > 0 ? `${pct.toFixed(1)}%` : ''}
        </span>
        <span className={`font-mono tabular-nums font-bold w-28 text-right ${v > 0 ? '' : 'text-slate-300'}`}
          style={{ color: v > 0 ? cor : undefined }}>
          {brl(v)}
        </span>
        {temDetalhe && (
          <ChevronRight size={13} className={`text-slate-300 transition-transform ${aberto ? 'rotate-90' : ''}`} />
        )}
      </button>

      {aberto && subitens && subitens.length > 0 && (
        <div className="ml-6 border-l-2 border-[#F0EBDD] pl-2 space-y-0.5 pb-1">
          {subitens.map((s) => (
            <div key={s.titulo}>
              <button
                type="button"
                onClick={() => setSubAberto(subAberto === s.titulo ? null : s.titulo)}
                className="w-full flex items-center justify-between text-[11px] py-1 px-1 rounded hover:bg-[#FBF6E6]"
              >
                <span className="font-semibold text-slate-700">{s.titulo}</span>
                <span className="flex items-center gap-2">
                  <span className="text-slate-400 font-mono">{s.qtd}x</span>
                  <span className="font-mono tabular-nums font-bold text-slate-700">{brl(s.valor)}</span>
                  <ChevronRight size={11} className={`text-slate-300 transition-transform ${subAberto === s.titulo ? 'rotate-90' : ''}`} />
                </span>
              </button>
              {subAberto === s.titulo && <ListaVendas vendas={s.vendas} />}
            </div>
          ))}
        </div>
      )}

      {aberto && vendas && vendas.length > 0 && (
        <div className="ml-6 border-l-2 border-[#F0EBDD] pl-2 pb-1">
          <ListaVendas vendas={vendas} />
        </div>
      )}
    </div>
  );
}

function ListaVendas({ vendas }: { vendas: any[] }) {
  if (!vendas?.length) {
    return <div className="text-[11px] text-slate-400 italic py-1">Sem vendas</div>;
  }
  return (
    <div className="space-y-0.5 max-h-56 overflow-y-auto">
      {vendas.map((v, i) => {
        const hora = v.finalizedAt
          ? new Date(v.finalizedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
          : '';
        return (
          <div key={i} className="flex items-center justify-between text-[11px] py-0.5 px-1 hover:bg-[#FBF6E6] rounded">
            <span className="flex items-center gap-1.5 min-w-0">
              {hora && <span className="text-slate-400 font-mono shrink-0">{hora}</span>}
              <span className="truncate text-slate-700">
                {v.customerName || (v.customerCpf ? `CPF ${v.customerCpf}` : 'Sem identificação')}
              </span>
              {v.sellerName && (
                <span className="text-slate-400 shrink-0">· {String(v.sellerName).split(' ')[0]}</span>
              )}
              {v.parcelas > 1 && <span className="text-slate-400 shrink-0">· {v.parcelas}x</span>}
            </span>
            <span className="font-mono tabular-nums font-bold text-slate-700 shrink-0 ml-2">
              {brl(v.valor)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Linha da composição do dinheiro, com cascata opcional de lançamentos. */
function Linha({ label, valor, cor, detalhe, itens }: {
  label: string;
  valor: number;
  cor?: string;
  detalhe?: string;
  itens?: Array<{ titulo: string; sub: string; valor: number }>;
}) {
  const [aberto, setAberto] = useState(false);
  const v = Number(valor) || 0;
  const temItens = (itens?.length || 0) > 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => temItens && setAberto((x) => !x)}
        disabled={!temItens}
        className={`w-full flex items-center justify-between gap-2 py-1 px-1 rounded text-left ${
          temItens ? 'hover:bg-[#FBF6E6] cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="text-sm text-slate-700 flex items-center gap-1.5">
          {label}
          {detalhe && <span className="text-[10px] text-slate-400">({detalhe})</span>}
          {temItens && (
            <ChevronRight size={12} className={`text-slate-300 transition-transform ${aberto ? 'rotate-90' : ''}`} />
          )}
        </span>
        <span
          className={`font-mono tabular-nums font-bold ${v === 0 ? 'text-slate-300' : ''}`}
          style={{ color: v !== 0 ? cor : undefined }}
        >
          {brl(v)}
        </span>
      </button>
      {aberto && itens && (
        <div className="ml-3 border-l-2 border-[#F0EBDD] pl-2 space-y-0.5 pb-1">
          {itens.map((it, i) => (
            <div key={i} className="flex items-center justify-between text-[11px] py-0.5">
              <span className="min-w-0">
                <span className="text-slate-700 truncate">{it.titulo}</span>
                <span className="block text-slate-400">{it.sub}</span>
              </span>
              <span className="font-mono tabular-nums font-bold text-slate-600 shrink-0 ml-2">
                {brl(it.valor)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
