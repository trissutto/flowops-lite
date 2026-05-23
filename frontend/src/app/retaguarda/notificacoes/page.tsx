'use client';

/**
 * /retaguarda/notificacoes — Central de Notificações Push
 *
 * CEO/admin envia push manual pras vendedoras/lojas:
 *   - "PROMOÇÃO 30% OFF HOJE"
 *   - "REUNIÃO 18H VIA ZOOM"
 *   - "FRETE GRÁTIS HOJE"
 *
 * Público-alvo:
 *   - Todos (admin + lojas)
 *   - Só lojas (sem admin)
 *   - Só admin/retaguarda
 *   - Loja específica
 *
 * Preview ao vivo mostra como vai aparecer no celular.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Bell, Send, Check, Loader2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

type Store = { id: string; code: string; name: string; active: boolean };

type SendResult = {
  ok: boolean;
  audience?: string;
  sent?: number;
  failed?: number;
  expired?: number;
  error?: string;
};

// Sugestões prontas que CEO pode usar com 1 clique
const TEMPLATES = [
  { title: '🎉 PROMOÇÃO ATIVA', body: '30% OFF em vestidos hoje. Avisem as clientes!' },
  { title: '🚚 FRETE GRÁTIS HOJE', body: 'Promoção válida só hoje. Comuniquem nas redes.' },
  { title: '📋 REUNIÃO 18H', body: 'Reunião semanal via Zoom. Link no grupo.' },
  { title: '⚡ NOVA COLEÇÃO', body: 'Chegaram peças novas. Confiram a triagem.' },
  { title: '🔔 AVISO IMPORTANTE', body: '' },
];

export default function NotificacoesPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<string>('stores');
  const [url, setUrl] = useState('');
  const [requireInteraction, setRequireInteraction] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login');
  }, [router]);

  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => setStores(arr.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code))))
      .catch(() => {});
  }, []);

  const useTemplate = (t: { title: string; body: string }) => {
    setTitle(t.title);
    setBody(t.body);
  };

  const send = async () => {
    if (!title.trim() || !body.trim()) {
      setResult({ ok: false, error: 'Preencha título e mensagem' });
      return;
    }
    const audienceLabel =
      audience === 'all' ? 'TODOS (admin + lojas)' :
      audience === 'stores' ? 'todas as lojas' :
      audience === 'admins' ? 'só retaguarda' :
      `loja ${audience.replace('store:', '')}`;
    if (!confirm(`Enviar push pra ${audienceLabel}?\n\nTítulo: ${title}\nMensagem: ${body}`)) return;

    setSending(true);
    setResult(null);
    try {
      const r = await api<SendResult>('/push/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          audience,
          url: url.trim() || undefined,
          requireInteraction,
        }),
      });
      setResult(r);
      if (r.ok) {
        // Limpa form em caso de sucesso (pra não mandar duplicado por acidente)
        setTimeout(() => {
          setTitle('');
          setBody('');
          setUrl('');
        }, 3000);
      }
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || 'Falha ao enviar' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded hover:bg-slate-100" title="Voltar">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <Bell className="w-6 h-6 text-violet-600" />
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Central de Notificações</h1>
            <p className="text-xs text-slate-500">Envia push pras vendedoras (substitui WhatsApp)</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* ─── FORM ─── */}
        <div className="space-y-4">
          {/* Templates rápidos */}
          <div>
            <div className="text-xs uppercase font-bold text-slate-500 tracking-wide mb-2">
              Modelos rápidos
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATES.map((t, i) => (
                <button
                  key={i}
                  onClick={() => useTemplate(t)}
                  className="px-2.5 py-1.5 text-xs bg-white border border-slate-300 hover:border-violet-400 hover:bg-violet-50 rounded-full font-medium text-slate-700"
                >
                  {t.title}
                </button>
              ))}
            </div>
          </div>

          {/* Título */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Título <span className="text-rose-600">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={50}
              placeholder="Ex: 🎉 PROMOÇÃO ATIVA"
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-base font-bold focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
            />
            <div className="text-[10px] text-slate-400 text-right mt-0.5">{title.length}/50</div>
          </div>

          {/* Mensagem */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Mensagem <span className="text-rose-600">*</span>
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={200}
              rows={3}
              placeholder="Ex: 30% OFF em vestidos hoje. Avisem as clientes!"
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200 resize-none"
            />
            <div className="text-[10px] text-slate-400 text-right mt-0.5">{body.length}/200</div>
          </div>

          {/* Público-alvo */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Enviar para
            </label>
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
            >
              <option value="stores">📍 Todas as lojas (vendedoras)</option>
              <option value="all">🌍 Todos (admin + lojas)</option>
              <option value="admins">🏢 Só retaguarda (admin)</option>
              <option disabled>──── ou loja específica ────</option>
              {stores.map((s) => (
                <option key={s.code} value={`store:${s.code}`}>
                  🏪 {s.code} · {s.name}
                </option>
              ))}
            </select>
          </div>

          {/* URL opcional */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Link ao clicar (opcional)
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Ex: /minha-loja  ou  https://lurds.com.br"
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
            />
            <div className="text-[10px] text-slate-400 mt-0.5">
              Se vazio, abre a home. Use caminho relativo (ex: <code>/minha-loja</code>) pra abrir dentro do app.
            </div>
          </div>

          {/* Opção: requireInteraction */}
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={requireInteraction}
              onChange={(e) => setRequireInteraction(e.target.checked)}
              className="w-4 h-4"
            />
            <span>
              <b>Manter visível</b> até user fechar (urgente)
            </span>
          </label>

          {/* Resultado */}
          {result && (
            <div
              className={`p-3 rounded-lg text-sm ${
                result.ok
                  ? 'bg-emerald-50 border border-emerald-300 text-emerald-900'
                  : 'bg-rose-50 border border-rose-300 text-rose-900'
              }`}
            >
              {result.ok ? (
                <div className="flex items-start gap-2">
                  <Check className="w-5 h-5 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold">Push enviado!</div>
                    <div className="text-xs mt-0.5">
                      {result.sent} entregue{(result.sent || 0) === 1 ? '' : 's'}
                      {(result.failed || 0) > 0 && ` · ${result.failed} falha(s)`}
                      {(result.expired || 0) > 0 && ` · ${result.expired} desativada(s) (subscription expirada)`}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold">Falha ao enviar</div>
                    <div className="text-xs mt-0.5">{result.error}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Botão enviar */}
          <button
            onClick={send}
            disabled={sending || !title.trim() || !body.trim()}
            className="w-full px-4 py-3 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-md"
          >
            {sending ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Enviando…
              </>
            ) : (
              <>
                <Send className="w-5 h-5" />
                Enviar push
              </>
            )}
          </button>
        </div>

        {/* ─── PREVIEW ─── */}
        <div className="md:sticky md:top-20 self-start">
          <div className="text-xs uppercase font-bold text-slate-500 tracking-wide mb-2">
            Pré-visualização (como vai aparecer no celular)
          </div>
          {/* Mockup de notificação Android */}
          <div className="bg-slate-900 rounded-2xl p-4 shadow-xl">
            <div className="bg-white rounded-xl p-3 flex items-start gap-3">
              <div className="w-10 h-10 bg-violet-100 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
                <img src="/icon-192.png" alt="Lurd's" className="w-10 h-10 object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-slate-500 uppercase tracking-wide">
                  <span>LURDS ORDER ONE</span>
                  <span>· agora</span>
                </div>
                <div className="font-bold text-sm text-slate-900 mt-0.5 break-words">
                  {title || <span className="text-slate-400">(Título aqui)</span>}
                </div>
                <div className="text-xs text-slate-600 mt-0.5 break-words">
                  {body || <span className="text-slate-400">(Mensagem aqui)</span>}
                </div>
              </div>
            </div>
          </div>
          <div className="text-xs text-slate-500 mt-3 leading-relaxed">
            💡 A notificação chega no celular mesmo se a vendedora estiver com o app fechado ou
            o navegador minimizado (Android). Ela vibra + toca som padrão do sistema.
            <br />
            ⚠️ Só recebe quem JÁ ativou notificações (botão "🔔 Ativar notificações" no menu).
          </div>
        </div>
      </main>
    </div>
  );
}
