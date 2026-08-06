'use client';

/**
 * FRETE E CUPONS DO SITE — a régua comercial sem deploy (itens 22 a 25 e 55).
 *
 * O que morava no código do e-commerce até 06/08/2026:
 *   - `FREE_SHIPPING_FROM = 399.9` (constante)
 *   - a tabela promocional de frete (array)
 *   - os 3 cupons (array)
 *
 * Trocar qualquer um exigia commit, build e deploy — ou seja, campanha de
 * frete grátis dependia de programador. Agora é cadastro, e vale em até 1
 * minuto (o backend guarda em cache curto).
 *
 * A JANELA (de/até) é o que evita acordar de madrugada pra tirar promoção do
 * ar: vazio = vale sempre; preenchido = entra e sai sozinho.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, Plus, Save, Trash2, Truck, TicketPercent } from 'lucide-react';

type Config = {
  freteGratisAtivo: boolean;
  freteGratisMinimo: number;
  freteGratisInicio: string | null;
  freteGratisFim: string | null;
  freteGratisUfs: string | null;
  diasSeparacao: number;
  retiradaPrazoHoras: number;
  retiradaInstrucoes: string | null;
};

type Promo = {
  id: string;
  label: string;
  servico: string;
  ufs: string;
  preco: number;
  prazoMin: number | null;
  prazoMax: number | null;
  ativo: boolean;
  inicioEm: string | null;
  fimEm: string | null;
  ordem: number;
};

type Cupom = {
  code: string;
  label: string;
  tipo: string;
  valor: number;
  minSubtotal: number | null;
  primeiraCompra: boolean;
  categorias: string | null;
  inicioEm: string | null;
  fimEm: string | null;
  usoMaximo: number | null;
  usos: number;
  ativo: boolean;
};

/** `<input type="date">` não aceita ISO com fuso; corta no dia. */
function paraData(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const campo = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none';
const rotulo = 'block text-xs font-bold text-slate-600 mb-1';

export default function LojaFretePage() {
  const [aba, setAba] = useState<'frete' | 'cupons'>('frete');

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      <header>
        <h1 className="text-xl font-bold text-slate-800">Frete e cupons do site</h1>
        <p className="text-sm text-slate-500">
          O que você muda aqui vale no site em até 1 minuto. Nada é apagado de verdade —
          promoção e cupom fora do ar ficam desligados, pra conferência não perder a
          explicação de por que um pedido antigo saiu mais barato.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {([
          ['frete', 'Frete', Truck],
          ['cupons', 'Cupons', TicketPercent],
        ] as const).map(([id, nome, Icone]) => (
          <button
            key={id}
            type="button"
            onClick={() => setAba(id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold border ${
              aba === id
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            <Icone className="w-4 h-4" /> {nome}
          </button>
        ))}
      </div>

      {aba === 'frete' ? <AbaFrete /> : <AbaCupons />}
    </div>
  );
}

/* ────────────────────────────────── FRETE ──────────────────────────────── */

function AbaFrete() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api<{ config: Config; promocoes: Promo[] }>('/admin/loja/frete');
      setCfg(r.config);
      setPromos(r.promocoes ?? []);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  async function salvarConfig() {
    if (!cfg) return;
    setSalvando(true);
    setErro(null);
    setOk(null);
    try {
      const r = await api<{ ok: boolean; error?: string }>('/admin/loja/frete', {
        method: 'POST',
        body: JSON.stringify(cfg),
      });
      if (!r.ok) throw new Error(r.error || 'Não consegui salvar');
      setOk('Salvo. Já vale no site.');
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function novaPromo() {
    try {
      const r = await api<{ ok: boolean; promo: Promo; error?: string }>('/admin/loja/frete/promo', {
        method: 'POST',
        // Nasce DESLIGADA: promoção de frete errada custa dinheiro em cada
        // pedido, e ninguém publica preço sem revisar.
        body: JSON.stringify({ label: 'Correios PAC', servico: 'pac', ufs: 'SP', preco: 19.99, ativo: false }),
      });
      if (!r.ok) throw new Error(r.error);
      setPromos((l) => [...l, r.promo]);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui criar');
    }
  }

  if (carregando) {
    return (
      <p className="text-sm text-slate-500 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
      </p>
    );
  }
  if (!cfg) return <p className="text-sm text-rose-700">{erro || 'Não consegui carregar'}</p>;

  return (
    <div className="space-y-4">
      {erro && <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{erro}</p>}
      {ok && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">{ok}</p>}

      {/* ── Frete grátis ── */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <h2 className="font-bold text-slate-800">Frete grátis</h2>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={cfg.freteGratisAtivo}
            onChange={(e) => setCfg({ ...cfg, freteGratisAtivo: e.target.checked })}
          />
          Oferecer frete grátis
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={rotulo}>A partir de (R$)</label>
            <input
              type="number" step="0.01" min="0" className={campo}
              value={cfg.freteGratisMinimo}
              onChange={(e) => setCfg({ ...cfg, freteGratisMinimo: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className={rotulo}>Começa em</label>
            <input
              type="date" className={campo}
              value={paraData(cfg.freteGratisInicio)}
              onChange={(e) => setCfg({ ...cfg, freteGratisInicio: e.target.value || null })}
            />
          </div>
          <div>
            <label className={rotulo}>Termina em</label>
            <input
              type="date" className={campo}
              value={paraData(cfg.freteGratisFim)}
              onChange={(e) => setCfg({ ...cfg, freteGratisFim: e.target.value || null })}
            />
          </div>
        </div>

        <div>
          <label className={rotulo}>Só nestes estados (vazio = Brasil inteiro)</label>
          <input
            className={campo} placeholder="SP,RJ,MG"
            value={cfg.freteGratisUfs ?? ''}
            onChange={(e) => setCfg({ ...cfg, freteGratisUfs: e.target.value.toUpperCase() || null })}
          />
          <p className="text-xs text-slate-500 mt-1">
            O grátis zera sempre a opção <b>econômica mais barata</b>. Quem escolhe SEDEX
            continua pagando SEDEX.
          </p>
        </div>
      </section>

      {/* ── Prazo e retirada ── */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <h2 className="font-bold text-slate-800">Prazo e retirada</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={rotulo}>Dias de separação</label>
            <input
              type="number" min="0" max="30" className={campo}
              value={cfg.diasSeparacao}
              onChange={(e) => setCfg({ ...cfg, diasSeparacao: Number(e.target.value) })}
            />
            <p className="text-xs text-slate-500 mt-1">
              Somado ao prazo dos Correios. O prazo deles conta do dia da POSTAGEM — a peça
              ainda vai ser separada, conferida e levada até a agência.
            </p>
          </div>
          <div>
            <label className={rotulo}>Retirada pronta em (horas)</label>
            <input
              type="number" min="0" className={campo}
              value={cfg.retiradaPrazoHoras}
              onChange={(e) => setCfg({ ...cfg, retiradaPrazoHoras: Number(e.target.value) })}
            />
          </div>
        </div>

        <div>
          <label className={rotulo}>O que a cliente precisa saber pra retirar</label>
          <textarea
            className={campo} rows={2}
            value={cfg.retiradaInstrucoes ?? ''}
            onChange={(e) => setCfg({ ...cfg, retiradaInstrucoes: e.target.value || null })}
          />
          <p className="text-xs text-slate-500 mt-1">
            Aparece na hora de escolher a entrega, não numa página de ajuda.
          </p>
        </div>
      </section>

      <button
        type="button"
        onClick={() => void salvarConfig()}
        disabled={salvando}
        className="inline-flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
      >
        {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar
      </button>

      {/* ── Tabela promocional ── */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div>
          <h2 className="font-bold text-slate-800">Tabela promocional</h2>
          <p className="text-xs text-slate-500">
            É o preço que a cliente VÊ. Onde não houver promoção, o site cobra a cotação
            real do nosso contrato com os Correios.
          </p>
        </div>

        {promos.map((p) => (
          <CardPromo
            key={p.id}
            promo={p}
            onMudou={(novo) => setPromos((l) => l.map((x) => (x.id === novo.id ? novo : x)))}
            onRemovido={() => setPromos((l) => l.filter((x) => x.id !== p.id))}
          />
        ))}
        {promos.length === 0 && (
          <p className="text-sm text-slate-400 border border-dashed border-slate-300 rounded-lg p-6 text-center">
            Sem promoção — o site cobra a cotação do contrato em todo o Brasil.
          </p>
        )}

        <button
          type="button"
          onClick={() => void novaPromo()}
          className="inline-flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
        >
          <Plus className="w-4 h-4" /> Nova linha
        </button>
      </section>
    </div>
  );
}

function CardPromo({
  promo, onMudou, onRemovido,
}: {
  promo: Promo;
  onMudou: (p: Promo) => void;
  onRemovido: () => void;
}) {
  const [form, setForm] = useState<Promo>(promo);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const r = await api<{ ok: boolean; promo: Promo; error?: string }>('/admin/loja/frete/promo', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(r.error || 'Não consegui salvar');
      onMudou(r.promo);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function desligar() {
    if (!confirm(`Desligar "${form.label}" para ${form.ufs}? O site volta a cobrar a cotação do contrato.`)) return;
    await api(`/admin/loja/frete/promo/${form.id}`, { method: 'DELETE' }).catch(() => undefined);
    onRemovido();
  }

  return (
    <div className={`border rounded-lg p-3 space-y-2 ${form.ativo ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50'}`}>
      <div className="grid gap-2 sm:grid-cols-5">
        <div className="sm:col-span-2">
          <label className={rotulo}>Nome na tela</label>
          <input className={campo} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </div>
        <div>
          <label className={rotulo}>Serviço</label>
          <select className={campo} value={form.servico} onChange={(e) => setForm({ ...form, servico: e.target.value })}>
            <option value="pac">PAC</option>
            <option value="sedex">SEDEX</option>
          </select>
        </div>
        <div>
          <label className={rotulo}>Estados</label>
          <input
            className={campo} placeholder="SP ou RJ,MG,PR"
            value={form.ufs}
            onChange={(e) => setForm({ ...form, ufs: e.target.value.toUpperCase() })}
          />
        </div>
        <div>
          <label className={rotulo}>Preço (R$)</label>
          <input
            type="number" step="0.01" min="0" className={campo}
            value={form.preco}
            onChange={(e) => setForm({ ...form, preco: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={rotulo}>Começa em</label>
          <input
            type="date" className={campo}
            value={paraData(form.inicioEm)}
            onChange={(e) => setForm({ ...form, inicioEm: e.target.value || null })}
          />
        </div>
        <div>
          <label className={rotulo}>Termina em</label>
          <input
            type="date" className={campo}
            value={paraData(form.fimEm)}
            onChange={(e) => setForm({ ...form, fimEm: e.target.value || null })}
          />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
            <input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
            No ar
          </label>
        </div>
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 text-sm font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Salvar
        </button>
        <button
          type="button"
          onClick={() => void desligar()}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"
        >
          <Trash2 className="w-3.5 h-3.5" /> Desligar
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────────────── CUPONS ──────────────────────────────── */

function AbaCupons() {
  const [lista, setLista] = useState<Cupom[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [novo, setNovo] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await api<{ itens: Cupom[] }>('/admin/loja/cupons');
      setLista(r.itens ?? []);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  if (carregando) {
    return (
      <p className="text-sm text-slate-500 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {erro && <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{erro}</p>}

      {novo && (
        <CardCupom
          cupom={{
            code: '', label: '', tipo: 'percent', valor: 10, minSubtotal: null,
            primeiraCompra: false, categorias: null, inicioEm: null, fimEm: null,
            usoMaximo: null, usos: 0, ativo: true,
          }}
          isNovo
          onMudou={(c) => { setLista((l) => [c, ...l]); setNovo(false); }}
          onRemovido={() => setNovo(false)}
        />
      )}

      {lista.map((c) => (
        <CardCupom
          key={c.code}
          cupom={c}
          onMudou={(novoC) => setLista((l) => l.map((x) => (x.code === novoC.code ? novoC : x)))}
          onRemovido={() => setLista((l) => l.filter((x) => x.code !== c.code))}
        />
      ))}

      {lista.length === 0 && !novo && (
        <p className="text-sm text-slate-400 border border-dashed border-slate-300 rounded-lg p-6 text-center">
          Nenhum cupom cadastrado. O site continua aceitando os três antigos
          (BEMVINDA10, LURDS15, FRETEGRATIS) até o primeiro cadastro aqui.
        </p>
      )}

      <button
        type="button"
        onClick={() => setNovo(true)}
        className="inline-flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700"
      >
        <Plus className="w-4 h-4" /> Novo cupom
      </button>
    </div>
  );
}

function CardCupom({
  cupom, isNovo, onMudou, onRemovido,
}: {
  cupom: Cupom;
  isNovo?: boolean;
  onMudou: (c: Cupom) => void;
  onRemovido: () => void;
}) {
  const [form, setForm] = useState<Cupom>(cupom);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const r = await api<{ ok: boolean; cupom: Cupom; error?: string }>('/admin/loja/cupons', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(r.error || 'Não consegui salvar');
      onMudou(r.cupom);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function desligar() {
    if (!confirm(`Desligar o cupom ${form.code}? Quem tentar usar vai ver "não encontramos esse cupom".`)) return;
    await api(`/admin/loja/cupons/${encodeURIComponent(form.code)}`, { method: 'DELETE' }).catch(() => undefined);
    onRemovido();
  }

  return (
    <div className={`border rounded-lg p-3 space-y-2 ${form.ativo ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-50'}`}>
      <div className="grid gap-2 sm:grid-cols-4">
        <div>
          <label className={rotulo}>Código</label>
          <input
            className={`${campo} font-mono uppercase`}
            disabled={!isNovo}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/\s/g, '') })}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={rotulo}>Frase que a cliente lê</label>
          <input className={campo} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </div>
        <div>
          <label className={rotulo}>Tipo</label>
          <select className={campo} value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
            <option value="percent">% de desconto</option>
            <option value="fixed">R$ de desconto</option>
            <option value="shipping">Frete grátis</option>
          </select>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {form.tipo !== 'shipping' && (
          <div>
            <label className={rotulo}>{form.tipo === 'percent' ? 'Percentual' : 'Valor (R$)'}</label>
            <input
              type="number" step="0.01" min="0" className={campo}
              value={form.valor}
              onChange={(e) => setForm({ ...form, valor: Number(e.target.value) })}
            />
          </div>
        )}
        <div>
          <label className={rotulo}>Compra mínima (R$)</label>
          <input
            type="number" step="0.01" min="0" className={campo}
            value={form.minSubtotal ?? ''}
            onChange={(e) => setForm({ ...form, minSubtotal: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </div>
        <div>
          <label className={rotulo}>Começa em</label>
          <input
            type="date" className={campo}
            value={paraData(form.inicioEm)}
            onChange={(e) => setForm({ ...form, inicioEm: e.target.value || null })}
          />
        </div>
        <div>
          <label className={rotulo}>Termina em</label>
          <input
            type="date" className={campo}
            value={paraData(form.fimEm)}
            onChange={(e) => setForm({ ...form, fimEm: e.target.value || null })}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={rotulo}>Limite de usos</label>
          <input
            type="number" min="0" className={campo}
            placeholder="sem limite"
            value={form.usoMaximo ?? ''}
            onChange={(e) => setForm({ ...form, usoMaximo: e.target.value === '' ? null : Number(e.target.value) })}
          />
          {!isNovo && <p className="text-xs text-slate-500 mt-1">Já usado {form.usos}×</p>}
        </div>
        <div className="flex items-end gap-4 pb-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.primeiraCompra}
              onChange={(e) => setForm({ ...form, primeiraCompra: e.target.checked })}
            />
            Só 1ª compra
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
            No ar
          </label>
        </div>
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 text-sm font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Salvar
        </button>
        {!isNovo && (
          <button
            type="button"
            onClick={() => void desligar()}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"
          >
            <Trash2 className="w-3.5 h-3.5" /> Desligar
          </button>
        )}
      </div>
    </div>
  );
}
