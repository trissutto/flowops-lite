'use client';
import { overlayClose } from '@/lib/overlayClose';

/**
 * /retaguarda/crediario/mensagens — Editor dos templates de cobrança WhatsApp.
 *
 * Carrega via GET /crediarios/templates-config os templates atuais (defaults
 * se nunca foi salvo). Cada template é uma string com placeholders:
 *
 *   {nome}             → primeiro nome capitalizado
 *   {nome_completo}    → nome inteiro do cadastro
 *   {parcelas}         → lista bonita (▫️ Vencimento dd/mm/aaaa — R$ X,XX)
 *   {parcelas_compact} → versão compacta (• dd/mm/aaaa — R$ X,XX)
 *   {total}            → soma em R$
 *   {loja}             → nome da loja (configurável)
 *   {qtd_parcelas}     → quantidade
 *   {primeiro_venc}    → vencimento mais antigo dd/mm/aaaa
 *   {dias_atraso}      → dias do venc mais antigo até hoje
 *
 * O backend rotaciona os templates por seq do cliente (anti-ban) — quanto
 * mais variações, melhor.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MessageSquare, Save, RotateCcw, Loader2, Plus, Trash2, Eye, AlertTriangle, Check, X,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';

interface TemplatesConfig {
  templates: string[];
  lojaNome: string;
  isDefault: boolean;
}

const PLACEHOLDERS = [
  { key: '{nome}', desc: 'Primeiro nome (Maria)' },
  { key: '{nome_completo}', desc: 'Nome inteiro' },
  { key: '{parcelas}', desc: 'Lista detalhada (multilinha)' },
  { key: '{parcelas_compact}', desc: 'Lista compacta' },
  { key: '{total}', desc: 'Total em R$' },
  { key: '{loja}', desc: 'Nome da loja' },
  { key: '{qtd_parcelas}', desc: 'Quantidade de parcelas' },
  { key: '{primeiro_venc}', desc: 'Vencimento mais antigo' },
  { key: '{dias_atraso}', desc: 'Dias de atraso' },
];

// Sample data pra preview live
const SAMPLE_CTX = {
  nome: 'Maria',
  loja: `Lurd's Plus Size`,
  total: 'R$ 179,80',
  parcelas: '▫️ Vencimento 10/04/2026 — R$ 89,90 (parc. 2/4)\n▫️ Vencimento 25/04/2026 — R$ 89,90 (parc. 3/4)',
  parcelas_compact: '• 10/04/2026 — R$ 89,90 (parc. 2/4)\n• 25/04/2026 — R$ 89,90 (parc. 3/4)',
  qtd_parcelas: '2',
  primeiro_venc: '10/04/2026',
  dias_atraso: '15',
  nome_completo: 'Maria Silva Santos',
};

function applyPlaceholders(tmpl: string, lojaNome: string): string {
  return tmpl
    .replace(/\{nome_completo\}/g, SAMPLE_CTX.nome_completo)
    .replace(/\{nome\}/g, SAMPLE_CTX.nome)
    .replace(/\{parcelas_compact\}/g, SAMPLE_CTX.parcelas_compact)
    .replace(/\{parcelas\}/g, SAMPLE_CTX.parcelas)
    .replace(/\{total\}/g, SAMPLE_CTX.total)
    .replace(/\{loja\}/g, lojaNome || SAMPLE_CTX.loja)
    .replace(/\{qtd_parcelas\}/g, SAMPLE_CTX.qtd_parcelas)
    .replace(/\{primeiro_venc\}/g, SAMPLE_CTX.primeiro_venc)
    .replace(/\{dias_atraso\}/g, SAMPLE_CTX.dias_atraso);
}

export default function MensagensCobrancaPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<string[]>([]);
  const [lojaNome, setLojaNome] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) { router.push('/login'); return; }
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'admin' && me.role !== 'operator') {
          router.push('/');
          return;
        }
        setAuthed(true);
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line
  }, []);

  async function load() {
    setLoading(true);
    try {
      const cfg = await api<TemplatesConfig>('/crediarios/templates-config');
      setTemplates(cfg.templates.length ? cfg.templates : ['']);
      setLojaNome(cfg.lojaNome || `Lurd's Plus Size`);
      setIsDefault(cfg.isDefault);
    } catch (e: any) {
      setToast({ ok: false, msg: e.message || 'Falha ao carregar templates' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (authed) load(); /* eslint-disable-next-line */ }, [authed]);

  async function save() {
    const clean = templates.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0);
    if (clean.length < 1) {
      setToast({ ok: false, msg: 'Pelo menos 1 template precisa ter conteúdo' });
      return;
    }
    setSaving(true);
    try {
      await api('/crediarios/templates-config', {
        method: 'POST',
        body: JSON.stringify({ templates: clean, lojaNome }),
      });
      setToast({ ok: true, msg: `${clean.length} template(s) salvos` });
      setIsDefault(false);
      setTimeout(() => setToast(null), 3000);
    } catch (e: any) {
      setToast({ ok: false, msg: e.message || 'Falha ao salvar' });
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!confirm('Restaurar os 6 templates padrão? Isso apaga suas customizações.')) return;
    setSaving(true);
    try {
      await api('/crediarios/templates-config/reset', { method: 'POST' });
      await load();
      setToast({ ok: true, msg: 'Templates resetados para o padrão' });
      setTimeout(() => setToast(null), 3000);
    } catch (e: any) {
      setToast({ ok: false, msg: e.message || 'Falha ao resetar' });
    } finally {
      setSaving(false);
    }
  }

  function updateTemplate(idx: number, value: string) {
    setTemplates((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  }

  function addTemplate() {
    if (templates.length >= 12) return;
    setTemplates([...templates, '']);
  }

  function removeTemplate(idx: number) {
    if (templates.length <= 1) return;
    if (!confirm(`Remover o template #${idx + 1}?`)) return;
    setTemplates((prev) => prev.filter((_, i) => i !== idx));
  }

  function insertPlaceholder(idx: number, ph: string) {
    const ta = document.getElementById(`tpl-${idx}`) as HTMLTextAreaElement | null;
    if (!ta) {
      updateTemplate(idx, (templates[idx] || '') + ph);
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const newValue = before + ph + after;
    updateTemplate(idx, newValue);
    setTimeout(() => {
      ta.focus();
      const pos = start + ph.length;
      ta.setSelectionRange(pos, pos);
    }, 10);
  }

  if (!authed || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando…
      </div>
    );
  }

  return (
    <PastelShell
      title="Mensagens de cobrança"
      subtitle="Edite os textos que vão pelo WhatsApp"
      icon={MessageSquare}
      tone="rose"
      backHref="/retaguarda/crediario"
    >
      {/* Banner status */}
      {isDefault && (
        <div className="panel-pastel p-3 mb-3 border-l-4 border-amber-400 bg-amber-50">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-amber-900">
              <div className="font-semibold">Usando templates padrão</div>
              <div className="text-xs mt-0.5">
                Edite e salve abaixo pra customizar. As alterações entram em vigor imediatamente
                pros disparos manuais e automáticos.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loja nome + ações */}
      <div className="panel-pastel p-3 mb-3 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px]">
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>
            Nome da loja (placeholder {'{loja}'})
          </label>
          <input
            value={lojaNome}
            onChange={(e) => setLojaNome(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white focus:outline-none focus:border-rose-400"
            placeholder="Lurd's Plus Size"
          />
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 text-sm rounded-lg text-white shadow-sm flex items-center gap-1.5 disabled:opacity-50"
          style={{ background: '#5d7048' }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Salvar templates
        </button>
        <button
          onClick={reset}
          disabled={saving}
          className="px-3 py-1.5 text-sm rounded-lg border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 flex items-center gap-1.5 disabled:opacity-50"
        >
          <RotateCcw className="w-4 h-4" /> Restaurar padrão
        </button>
      </div>

      {/* Placeholders cheatsheet */}
      <div className="panel-pastel p-3 mb-3 text-xs">
        <div className="font-semibold mb-2" style={{ color: '#6e3a40' }}>Placeholders disponíveis (clique pra inserir)</div>
        <div className="text-slate-600 mb-2">Todos os tokens abaixo são substituídos automaticamente quando a mensagem é enviada.</div>
      </div>

      {/* Templates */}
      <div className="space-y-3">
        {templates.map((tmpl, idx) => (
          <TemplateEditor
            key={idx}
            idx={idx}
            value={tmpl}
            lojaNome={lojaNome}
            onChange={(v) => updateTemplate(idx, v)}
            onRemove={templates.length > 1 ? () => removeTemplate(idx) : undefined}
            onInsert={(ph) => insertPlaceholder(idx, ph)}
            onPreview={() => setPreviewIdx(idx)}
          />
        ))}

        {templates.length < 12 && (
          <button
            onClick={addTemplate}
            className="w-full p-3 rounded-xl border-2 border-dashed border-rose-200 bg-white hover:bg-rose-50 text-rose-600 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" /> Adicionar template ({templates.length}/12)
          </button>
        )}
      </div>

      <div className="text-xs text-slate-500 mt-4 panel-pastel p-3">
        <div className="font-semibold mb-1" style={{ color: '#6e3a40' }}>💡 Dicas</div>
        <ul className="list-disc list-inside space-y-1">
          <li>Quanto mais variações, melhor — o sistema rotaciona automático pra evitar marca de spam.</li>
          <li>Mensagens longas (4-8 linhas) com nome do cliente convertem mais que &quot;PAGUE AGORA&quot;.</li>
          <li>Use emoji com moderação — 1 ou 2 por mensagem (💗, 🙏, 😊).</li>
          <li>Os placeholders entre chaves <code className="bg-rose-50 px-1 rounded">{'{nome}'}</code> são substituídos no envio.</li>
        </ul>
      </div>

      {/* Preview Modal */}
      {previewIdx !== null && templates[previewIdx] && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" {...overlayClose(() => setPreviewIdx(null))}>
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-rose-800">Preview — Template #{previewIdx + 1}</h3>
                <p className="text-xs text-slate-500">com dados de exemplo</p>
              </div>
              <button onClick={() => setPreviewIdx(null)} className="text-slate-400 hover:text-rose-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm whitespace-pre-wrap font-sans text-slate-800">
              {applyPlaceholders(templates[previewIdx], lojaNome)}
            </div>
            <button onClick={() => setPreviewIdx(null)} className="mt-3 w-full px-3 py-2 text-sm rounded-lg bg-rose-700 text-white hover:bg-rose-800">
              Fechar
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50 ${
          toast.ok ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
        }`}>
          {toast.ok ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          <span className="text-sm font-medium">{toast.msg}</span>
        </div>
      )}
    </PastelShell>
  );
}

function TemplateEditor(props: {
  idx: number;
  value: string;
  lojaNome: string;
  onChange: (v: string) => void;
  onRemove?: () => void;
  onInsert: (ph: string) => void;
  onPreview: () => void;
}) {
  const { idx, value, lojaNome, onChange, onRemove, onInsert, onPreview } = props;
  const previewText = useMemo(() => applyPlaceholders(value || '', lojaNome), [value, lojaNome]);
  const charCount = value.length;
  const lineCount = value.split('\n').length;

  return (
    <div className="panel-pastel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 text-xs font-bold">
            Template #{idx + 1}
          </span>
          <span className="text-[10px] text-slate-500">{charCount} caracteres · {lineCount} linhas</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onPreview}
            className="px-2 py-1 text-xs rounded-md border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 flex items-center gap-1"
            title="Preview com dados de exemplo"
          >
            <Eye className="w-3 h-3" /> Preview
          </button>
          {onRemove && (
            <button
              onClick={onRemove}
              className="px-2 py-1 text-xs rounded-md border border-rose-200 bg-white hover:bg-rose-50 text-rose-600 flex items-center gap-1"
              title="Remover template"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Placeholders quick-insert */}
      <div className="flex flex-wrap gap-1 mb-2">
        {PLACEHOLDERS.map((ph) => (
          <button
            key={ph.key}
            onClick={() => onInsert(ph.key)}
            className="px-1.5 py-0.5 text-[10px] rounded bg-rose-50 hover:bg-rose-100 text-rose-700 font-mono border border-rose-200"
            title={ph.desc}
          >
            {ph.key}
          </button>
        ))}
      </div>

      <textarea
        id={`tpl-${idx}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.max(6, Math.min(14, lineCount + 1))}
        className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white font-mono focus:outline-none focus:border-rose-400 resize-y"
        placeholder="Olá {nome}, ..."
      />

      {value.trim().length > 0 && (
        <div className="mt-2 text-[11px] text-slate-500 italic">
          Preview ao vivo: <span className="text-emerald-700 not-italic">{previewText.slice(0, 80)}{previewText.length > 80 ? '…' : ''}</span>
        </div>
      )}
    </div>
  );
}
