'use client';

/**
 * CUPONS — o painel que o WooCommerce nunca teve (dono, 01/09).
 *
 * A pedida: "um campo onde eu possa fazer os cupons de troca para as
 * clientes". O vale de troca nominal já nascia sozinho (portal de trocas,
 * devolução na loja, peça faltante) — mas criar UM NA MÃO, pra resolver o
 * caso da cliente no WhatsApp, não tinha porta nenhuma.
 *
 * Aqui é a porta:
 *  - VALE DE TROCA: R$ fixos, uso único, nominal por CPF. Nasce no MESMO
 *    formato dos automáticos (`site_cupons` com `origem: 'troca'`), então
 *    vale no site E no caixa de qualquer loja sem regra nova.
 *  - CAMPANHA: os cupons públicos do site (a aba de loja-frete continua
 *    funcionando — é a mesma tabela).
 *
 * Endpoint próprio (`/admin/cupons`) porque a rota antiga fazia upsert
 * silencioso: criar um vale com código repetido REESCREVERIA o vale de outra
 * cliente. Aqui código repetido em criação é erro, e vale já usado é
 * intocável (é a explicação de por que aquela venda saiu mais barata).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  Check,
  Copy,
  Loader2,
  MessageCircle,
  Plus,
  Power,
  Save,
  Ticket,
  TicketPercent,
} from 'lucide-react';

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
  cpf: string | null;
  origem: string;
  trocaId: string | null;
  usadoPdvSaleId: string | null;
  usadoAt: string | null;
  atualizadoPor: string | null;
  createdAt: string;
};

const campo = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none';
const rotulo = 'block text-xs font-bold text-slate-600 mb-1';

function brl(v: number): string {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function cpfFmt(v: string | null): string {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 11) return v || '';
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** `<input type="date">` não aceita ISO com fuso; corta no dia. */
function paraData(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dataBr(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR');
}

function hojeMais(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A situação do cupom, na ordem que importa pra quem olha a lista:
 * usado > desligado > vencido > agendado > esgotado > no ar.
 */
function situacao(c: Cupom): { texto: string; classe: string } {
  const agora = Date.now();
  if (c.usadoAt || (c.usoMaximo != null && c.usos >= c.usoMaximo && c.origem === 'troca')) {
    return { texto: 'USADO', classe: 'bg-slate-200 text-slate-600' };
  }
  if (!c.ativo) return { texto: 'DESLIGADO', classe: 'bg-slate-100 text-slate-500 border border-slate-300' };
  if (c.fimEm && new Date(c.fimEm).getTime() < agora) {
    return { texto: 'VENCIDO', classe: 'bg-rose-100 text-rose-700' };
  }
  if (c.inicioEm && new Date(c.inicioEm).getTime() > agora) {
    return { texto: 'AGENDADO', classe: 'bg-amber-100 text-amber-800' };
  }
  if (c.usoMaximo != null && c.usos >= c.usoMaximo) {
    return { texto: 'ESGOTADO', classe: 'bg-slate-200 text-slate-600' };
  }
  return { texto: 'NO AR', classe: 'bg-emerald-100 text-emerald-700' };
}

function valorTexto(c: Cupom): string {
  if (c.tipo === 'shipping') return 'Frete grátis';
  if (c.tipo === 'percent') return `${c.valor}% off`;
  return brl(c.valor);
}

async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // PC de loja com navegador antigo/sem permissão: fallback do textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = texto;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function BotaoCopiar({ texto, rotuloBtn, icone }: { texto: string; rotuloBtn: string; icone?: 'zap' }) {
  const [feito, setFeito] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void copiar(texto).then((ok) => {
          if (!ok) return;
          setFeito(true);
          setTimeout(() => setFeito(false), 1600);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
    >
      {feito ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : icone === 'zap' ? <MessageCircle className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {feito ? 'Copiado!' : rotuloBtn}
    </button>
  );
}

/* ═══════════════════════════ VALE DE TROCA ═══════════════════════════════ */

function FormVale({ onCriado, onFechar }: { onCriado: (c: Cupom) => void; onFechar: () => void }) {
  const [cpf, setCpf] = useState('');
  const [valorStr, setValorStr] = useState('');
  const [fimEm, setFimEm] = useState(hojeMais(90));
  const [label, setLabel] = useState('Vale de troca');
  const [codigo, setCodigo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [criado, setCriado] = useState<Cupom | null>(null);

  // Conferência do CPF no CRM — aviso, nunca trava (cliente nova de loja
  // pode não ter cadastro ainda).
  const [clienteNome, setClienteNome] = useState<string | null>(null);
  const [clienteBuscou, setClienteBuscou] = useState(false);
  const buscaRef = useRef(0);
  useEffect(() => {
    const d = cpf.replace(/\D/g, '');
    setClienteNome(null);
    setClienteBuscou(false);
    if (d.length !== 11) return;
    const id = ++buscaRef.current;
    const t = setTimeout(() => {
      api<{ ok: boolean; encontrado?: boolean; nome?: string }>(`/admin/cupons/cliente?cpf=${d}`)
        .then((r) => {
          if (buscaRef.current !== id) return;
          setClienteBuscou(true);
          setClienteNome(r.encontrado ? r.nome || null : null);
        })
        .catch(() => {
          if (buscaRef.current !== id) return;
          setClienteBuscou(false);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [cpf]);

  const valor = Math.round((Number(valorStr.replace(/\./g, '').replace(',', '.')) || 0) * 100) / 100;

  async function salvar() {
    setErro(null);
    if (!(valor > 0)) {
      setErro('Informe o valor do vale.');
      return;
    }
    const d = cpf.replace(/\D/g, '');
    if (d && d.length !== 11) {
      setErro('CPF incompleto — apague ou complete os 11 dígitos.');
      return;
    }
    setSalvando(true);
    try {
      const r = await api<{ ok: boolean; cupom: Cupom; error?: string }>('/admin/cupons', {
        method: 'POST',
        body: JSON.stringify({
          novo: true,
          origem: 'troca',
          tipo: 'fixed',
          code: codigo || undefined,
          label,
          valor,
          cpf: d || undefined,
          // Fim do DIA, não meia-noite: "vale até 30/11" tem que cobrir o dia
          // 30 inteiro — mandar só a data expirava o vale na virada pra 30.
          fimEm: fimEm ? `${fimEm}T23:59:59` : null,
        }),
      });
      if (!r.ok) throw new Error(r.error || 'Não consegui criar o vale');
      setCriado(r.cupom);
      onCriado(r.cupom);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui criar o vale');
    } finally {
      setSalvando(false);
    }
  }

  if (criado) {
    const linhas = [
      'Seu vale de troca já está valendo 💜',
      `Código: ${criado.code}`,
      `Valor: ${brl(criado.valor)}`,
      criado.cpf ? 'Ele é nominal: use o CPF de quem fez a troca na hora de comprar.' : '',
      criado.fimEm ? `Vale até ${dataBr(criado.fimEm)}.` : '',
      "Funciona no site lurds.com.br e em qualquer loja Lurd's.",
    ].filter(Boolean);
    return (
      <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4 space-y-3">
        <p className="text-sm font-bold text-emerald-800">Vale criado — já está valendo no site e no PDV.</p>
        <div className="rounded-lg border border-emerald-200 bg-white p-3 text-center">
          <div className="font-mono text-2xl font-black tracking-widest text-slate-900">{criado.code}</div>
          <div className="mt-1 text-sm font-bold text-emerald-700">{brl(criado.valor)}</div>
          {criado.cpf && <div className="text-xs text-slate-500">nominal · CPF {cpfFmt(criado.cpf)}</div>}
          {criado.fimEm && <div className="text-xs text-slate-500">vale até {dataBr(criado.fimEm)}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <BotaoCopiar texto={criado.code} rotuloBtn="Copiar código" />
          <BotaoCopiar texto={linhas.join('\n')} rotuloBtn="Copiar mensagem pro WhatsApp" icone="zap" />
          <button
            type="button"
            onClick={onFechar}
            className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
          >
            Fechar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-violet-300 bg-violet-50/60 p-4 space-y-3">
      <p className="text-sm font-bold text-violet-900">
        Novo vale de troca — R$ fixos, uso único, no CPF da cliente.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={rotulo}>CPF da cliente</label>
          <input
            className={`${campo} font-mono`}
            placeholder="000.000.000-00"
            inputMode="numeric"
            value={cpf}
            onChange={(e) => setCpf(e.target.value.replace(/[^\d.\-]/g, '').slice(0, 14))}
          />
          {clienteNome && (
            <p className="mt-1 text-xs font-bold text-emerald-700">✓ {clienteNome}</p>
          )}
          {clienteBuscou && !clienteNome && (
            <p className="mt-1 text-xs text-amber-700">Não achei no CRM — confere o número (dá pra criar assim mesmo).</p>
          )}
          {!cpf && (
            <p className="mt-1 text-xs text-slate-500">Sem CPF qualquer pessoa com o código usa.</p>
          )}
        </div>
        <div>
          <label className={rotulo}>Valor (R$)</label>
          <input
            className={campo}
            placeholder="0,00"
            inputMode="decimal"
            value={valorStr}
            onChange={(e) => setValorStr(e.target.value.replace(/[^\d.,]/g, ''))}
          />
        </div>
        <div>
          <label className={rotulo}>Vale até</label>
          <input type="date" className={campo} value={fimEm} onChange={(e) => setFimEm(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Vazio = sem prazo.</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className={rotulo}>Frase que a cliente lê</label>
          <input className={campo} value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <label className={rotulo}>Código (deixe vazio que o sistema gera)</label>
          <input
            className={`${campo} font-mono uppercase`}
            placeholder="gerado sozinho"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 30))}
          />
        </div>
      </div>

      {erro && <p className="text-xs font-bold text-rose-700">{erro}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ticket className="h-4 w-4" />} Criar vale
        </button>
        <button
          type="button"
          onClick={onFechar}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════ CAMPANHA ════════════════════════════════════ */

type FormCampanhaDados = {
  code: string;
  label: string;
  tipo: string;
  valor: number;
  minSubtotal: number | null;
  primeiraCompra: boolean;
  inicioEm: string | null;
  fimEm: string | null;
  usoMaximo: number | null;
  ativo: boolean;
};

const CAMPANHA_VAZIA: FormCampanhaDados = {
  code: '', label: '', tipo: 'percent', valor: 10, minSubtotal: null,
  primeiraCompra: false, inicioEm: null, fimEm: null, usoMaximo: null, ativo: true,
};

function FormCampanha({
  inicial, editando, onSalvo, onFechar,
}: {
  inicial: FormCampanhaDados;
  editando: boolean;
  onSalvo: (c: Cupom) => void;
  onFechar: () => void;
}) {
  const [form, setForm] = useState<FormCampanhaDados>(inicial);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar() {
    setErro(null);
    setSalvando(true);
    try {
      const r = await api<{ ok: boolean; cupom: Cupom; error?: string }>('/admin/cupons', {
        method: 'POST',
        body: JSON.stringify({ ...form, origem: 'campanha', novo: !editando }),
      });
      if (!r.ok) throw new Error(r.error || 'Não consegui salvar');
      onSalvo(r.cupom);
      onFechar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="rounded-xl border-2 border-sky-300 bg-sky-50/60 p-4 space-y-3">
      <p className="text-sm font-bold text-sky-900">
        {editando ? `Editando a campanha ${form.code}` : 'Novo cupom de campanha — público: quem tiver o código usa.'}
      </p>
      <div className="grid gap-2 sm:grid-cols-4">
        <div>
          <label className={rotulo}>Código</label>
          <input
            className={`${campo} font-mono uppercase`}
            disabled={editando}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 30) })}
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
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className={rotulo}>Limite de usos</label>
          <input
            type="number" min="0" className={campo}
            placeholder="sem limite"
            value={form.usoMaximo ?? ''}
            onChange={(e) => setForm({ ...form, usoMaximo: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.primeiraCompra}
            onChange={(e) => setForm({ ...form, primeiraCompra: e.target.checked })}
          />
          Só 1ª compra
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
          No ar
        </label>
      </div>

      {erro && <p className="text-xs font-bold text-rose-700">{erro}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar
        </button>
        <button
          type="button"
          onClick={onFechar}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════ PÁGINA ══════════════════════════════════════ */

export default function CuponsPage() {
  const [lista, setLista] = useState<Cupom[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [formAberto, setFormAberto] = useState<'vale' | 'campanha' | null>(null);
  const [campanhaEdit, setCampanhaEdit] = useState<FormCampanhaDados | null>(null);

  const [aba, setAba] = useState<'troca' | 'campanha' | 'todos'>('troca');
  const [busca, setBusca] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api<{ itens: Cupom[] }>('/admin/cupons');
      setLista(Array.isArray(r.itens) ? r.itens : []);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar os cupons');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  function atualiza(c: Cupom) {
    setLista((l) => {
      const existe = l.some((x) => x.code === c.code);
      return existe ? l.map((x) => (x.code === c.code ? c : x)) : [c, ...l];
    });
  }

  async function desligar(c: Cupom) {
    if (!confirm(`Desligar ${c.code}? Quem tentar usar vai ver "não encontramos esse cupom".`)) return;
    const r = await api<{ ok: boolean; error?: string }>(`/admin/cupons/${encodeURIComponent(c.code)}`, { method: 'DELETE' })
      .catch(() => ({ ok: false, error: 'Falha ao desligar' }));
    if (!r.ok) {
      alert(r.error || 'Não consegui desligar');
      return;
    }
    atualiza({ ...c, ativo: false });
  }

  async function religar(c: Cupom) {
    const r = await api<{ ok: boolean; cupom: Cupom; error?: string }>('/admin/cupons', {
      method: 'POST',
      body: JSON.stringify({
        code: c.code, label: c.label, tipo: c.tipo, valor: c.valor,
        minSubtotal: c.minSubtotal, primeiraCompra: c.primeiraCompra,
        categorias: c.categorias, inicioEm: c.inicioEm, fimEm: c.fimEm,
        usoMaximo: c.usoMaximo, cpf: c.cpf, origem: c.origem, ativo: true,
      }),
    }).catch(() => ({ ok: false as const, cupom: c, error: 'Falha ao religar' }));
    if (!r.ok) {
      alert((r as any).error || 'Não consegui religar');
      return;
    }
    atualiza(r.cupom);
  }

  const filtrada = useMemo(() => {
    const q = busca.trim().toUpperCase().replace(/[.\-\s]/g, '');
    return lista.filter((c) => {
      if (aba === 'troca' && c.origem !== 'troca') return false;
      if (aba === 'campanha' && c.origem === 'troca') return false;
      if (!q) return true;
      const alvo = `${c.code} ${c.label.toUpperCase()} ${c.cpf || ''}`.replace(/[.\-\s]/g, '');
      return alvo.includes(q);
    });
  }, [lista, aba, busca]);

  const qtdVales = lista.filter((c) => c.origem === 'troca').length;
  const qtdCampanhas = lista.length - qtdVales;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-bold text-slate-800">Cupons</h1>
        <p className="text-sm text-slate-500">
          O vale de troca é nominal (CPF da cliente), uso único, e funciona no site e no caixa
          de qualquer loja — igual ao que a troca gera sozinha. Cupom de campanha é público.
          Nada é apagado de verdade: cupom fora do ar fica desligado, e vale usado vira registro.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { setFormAberto('vale'); setCampanhaEdit(null); }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-700"
        >
          <Ticket className="h-4 w-4" /> Novo vale de troca
        </button>
        <button
          type="button"
          onClick={() => { setFormAberto('campanha'); setCampanhaEdit(null); }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          <TicketPercent className="h-4 w-4" /> Novo cupom de campanha
        </button>
      </div>

      {formAberto === 'vale' && (
        <FormVale onCriado={atualiza} onFechar={() => setFormAberto(null)} />
      )}
      {formAberto === 'campanha' && (
        <FormCampanha
          inicial={campanhaEdit ?? CAMPANHA_VAZIA}
          editando={!!campanhaEdit}
          onSalvo={atualiza}
          onFechar={() => { setFormAberto(null); setCampanhaEdit(null); }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {([
          ['troca', `Vales de troca (${qtdVales})`],
          ['campanha', `Campanhas (${qtdCampanhas})`],
          ['todos', 'Todos'],
        ] as const).map(([id, nome]) => (
          <button
            key={id}
            type="button"
            onClick={() => setAba(id)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-bold ${
              aba === id
                ? 'border-violet-600 bg-violet-600 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {nome}
          </button>
        ))}
        <input
          className={`${campo} ml-auto max-w-xs`}
          placeholder="Buscar código, CPF ou frase…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>

      {carregando && (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </p>
      )}
      {erro && <p className="rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{erro}</p>}

      {!carregando && filtrada.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
          {busca
            ? 'Nada com essa busca.'
            : aba === 'troca'
              ? 'Nenhum vale de troca ainda — crie o primeiro no botão roxo aí em cima.'
              : 'Nenhum cupom aqui.'}
        </p>
      )}

      <div className="space-y-2">
        {filtrada.map((c) => {
          const st = situacao(c);
          const podeMexer = !c.usadoAt && !(c.origem === 'troca' && c.usoMaximo != null && c.usos >= c.usoMaximo);
          return (
            <div
              key={c.code}
              className={`rounded-lg border p-3 ${c.ativo ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-50'}`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-sm font-black tracking-wider text-slate-900">{c.code}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${st.classe}`}>{st.texto}</span>
                <span className="text-sm font-bold text-emerald-700">{valorTexto(c)}</span>
                {c.origem === 'troca' ? (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">VALE DE TROCA</span>
                ) : (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">CAMPANHA</span>
                )}
                <span className="text-xs text-slate-500">{c.label}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-slate-500">
                {c.cpf && <span>CPF {cpfFmt(c.cpf)}</span>}
                {c.fimEm && <span>vale até {dataBr(c.fimEm)}</span>}
                {c.usoMaximo != null ? <span>usado {c.usos}/{c.usoMaximo}×</span> : c.usos > 0 ? <span>usado {c.usos}×</span> : null}
                {c.minSubtotal ? <span>mínimo {brl(c.minSubtotal)}</span> : null}
                <span>criado {dataBr(c.createdAt)}{c.atualizadoPor ? ` · ${c.atualizadoPor}` : ''}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <BotaoCopiar texto={c.code} rotuloBtn="Copiar código" />
                {c.origem !== 'troca' && (
                  <button
                    type="button"
                    onClick={() => {
                      setCampanhaEdit({
                        code: c.code, label: c.label, tipo: c.tipo, valor: c.valor,
                        minSubtotal: c.minSubtotal, primeiraCompra: c.primeiraCompra,
                        inicioEm: c.inicioEm, fimEm: c.fimEm, usoMaximo: c.usoMaximo, ativo: c.ativo,
                      });
                      setFormAberto('campanha');
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                  >
                    Editar
                  </button>
                )}
                {podeMexer && c.ativo && (
                  <button
                    type="button"
                    onClick={() => void desligar(c)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    <Power className="h-3 w-3" /> Desligar
                  </button>
                )}
                {podeMexer && !c.ativo && (
                  <button
                    type="button"
                    onClick={() => void religar(c)}
                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-100"
                  >
                    <Plus className="h-3 w-3" /> Religar
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
