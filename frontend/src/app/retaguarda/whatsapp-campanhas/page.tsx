'use client';

/**
 * /retaguarda/whatsapp-campanhas
 *
 * Disparo de WhatsApp PELO FlowOps (dono, 15/08/2026) — substitui o n8n órfão.
 * A operadora escolhe o público, escreve as mensagens (com {nome}) e dispara:
 * o backend manda pausado via Evolution, com kill-switch. Sem n8n, sem Matheus.
 *
 * Enquanto a chave do Evolution não estiver no Railway, a tela abre em modo
 * "desligado" e avisa exatamente o que falta — mas já deixa tudo montado.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, MessageCircle, Pause, Play, Plus, RefreshCw, Send, Trash2, X,
} from 'lucide-react';
import { api } from '@/lib/api';

type Status = { configurado: boolean; instancia: string | null; conexao: { ok: boolean; estado?: string } | null };
type Campanha = {
  id: string; nome: string; status: string; total: number; enviados: number; falhas: number;
  pausaMotivo: string | null; criadoEm: string;
};

const MSGS_PADRAO = [
  'Oi {nome}! 💛 Vi que você comprou com a gente em julho. Chegou coisa nova da Linha Conforto no site novo e achei que ia ser a sua cara. Posso te mandar?',
  '{nome}, tudo bem? 🧡 Aqui é da Lurd\'s. Saiu a Linha Conforto nova (aquela gostosa de vestir) e lembrei de você. Quer ver?',
  'Oi {nome} 💛 Faz um tempinho desde julho! Entrou a Linha Conforto no site novo. Qual número você usa hoje? Te ajudo a achar a sua.',
  '{nome}, oi! 🧡 Novidade da Linha Conforto no ar — plus do 46 ao 60. Como você comprou em julho, quis te avisar primeiro. Te mostro?',
];
const FOTO_PADRAO = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/whatsapp-reativacao/linha-conforto-terracota.png';

export default function WhatsappCampanhasPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [de, setDe] = useState('2026-07-01');
  const [ate, setAte] = useState('2026-07-31');
  const [mulheres, setMulheres] = useState(true);
  const [limite, setLimite] = useState(30);
  const [previa, setPrevia] = useState<{ total: number; amostra: string[] } | null>(null);
  const [nome, setNome] = useState('Reativação Julho — Linha Conforto');
  const [mensagens, setMensagens] = useState<string[]>(MSGS_PADRAO);
  const [imagemUrl, setImagemUrl] = useState(FOTO_PADRAO);
  const [foneTeste, setFoneTeste] = useState('');
  const [campanhas, setCampanhas] = useState<Campanha[]>([]);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [st, lista] = await Promise.all([
        api<Status>('/whatsapp-campanhas/status').catch(() => null),
        api<Campanha[]>('/whatsapp-campanhas').catch(() => []),
      ]);
      setStatus(st);
      setCampanhas(lista || []);
    } catch (e: any) {
      setMsg({ tipo: 'erro', texto: e?.message || 'Falha ao carregar' });
    }
  }, []);

  useEffect(() => { carregar(); const t = setInterval(carregar, 8000); return () => clearInterval(t); }, [carregar]);

  const verPublico = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ de, ate, apenasMulheres: String(mulheres), limite: String(limite) });
      setPrevia(await api(`/whatsapp-campanhas/segmento/previa?${qs}`));
    } catch (e: any) { setMsg({ tipo: 'erro', texto: e?.message || 'Falha na prévia' }); }
  }, [de, ate, mulheres, limite]);

  useEffect(() => { verPublico(); }, [verPublico]);

  async function testar() {
    if (!foneTeste) return setMsg({ tipo: 'erro', texto: 'Coloque um número pra receber o teste.' });
    setOcupado(true); setMsg(null);
    try {
      await api('/whatsapp-campanhas/previa', { method: 'POST', body: JSON.stringify({ fone: foneTeste, mensagem: mensagens[0].replace(/\{nome\}/gi, 'você') }) });
      setMsg({ tipo: 'ok', texto: 'Teste enviado! Confere o WhatsApp desse número.' });
    } catch (e: any) { setMsg({ tipo: 'erro', texto: e?.message || 'Falha no teste' }); }
    finally { setOcupado(false); }
  }

  async function criar(iniciar: boolean) {
    const msgs = mensagens.map((m) => m.trim()).filter(Boolean);
    if (!msgs.length) return setMsg({ tipo: 'erro', texto: 'Escreva pelo menos uma mensagem.' });
    setOcupado(true); setMsg(null);
    try {
      const r = await api<{ id: string; total: number }>('/whatsapp-campanhas', {
        method: 'POST',
        body: JSON.stringify({ nome, mensagens: msgs, imagemUrl: imagemUrl || null, iniciar, segmento: { de, ate, apenasMulheres: mulheres, limite } }),
      });
      setMsg({ tipo: 'ok', texto: iniciar ? `Disparando pra ${r.total} pessoas — pausado, 1 a cada ~1-2 min.` : `Rascunho criado (${r.total} pessoas).` });
      carregar();
    } catch (e: any) { setMsg({ tipo: 'erro', texto: e?.message || 'Falha ao criar' }); }
    finally { setOcupado(false); }
  }

  async function acao(id: string, a: string) {
    try { await api(`/whatsapp-campanhas/${id}/${a}`, { method: 'POST' }); carregar(); }
    catch (e: any) { setMsg({ tipo: 'erro', texto: e?.message || 'Falha' }); }
  }

  const desligado = status && !status.configurado;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2"><MessageCircle className="w-5 h-5 text-[#2E7D46]" /> Campanhas de WhatsApp</h1>
          <p className="text-sm text-slate-500">Escolhe o público, escreve a mensagem e dispara — pausado, com trava de segurança.</p>
        </div>
        <button onClick={carregar} className="px-3 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600" title="Atualizar"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {/* Estado do Evolution */}
      {status && (
        <div className={`rounded-xl border p-4 text-sm ${desligado ? 'border-amber-300 bg-amber-50 text-amber-800' : status.conexao?.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-300 bg-amber-50 text-amber-800'}`}>
          {desligado ? (
            <><b>Motor desligado.</b> Falta a chave do Evolution no Railway — variáveis <code>EVOLUTION_URL</code>, <code>EVOLUTION_KEY</code>, <code>EVOLUTION_INSTANCE</code>. Pode montar a campanha aqui (fica em rascunho); no dia que a chave entrar, é só clicar Disparar.</>
          ) : status.conexao?.ok ? (
            <><b>Conectado ✅</b> — instância "{status.instancia}" no ar. Pode disparar.</>
          ) : (
            <><b>Configurado, mas a instância "{status.instancia}" não está conectada</b> ({status.conexao?.estado || '?'}). Reconecte o WhatsApp (QR) no Evolution antes de disparar.</>
          )}
        </div>
      )}

      {msg && (
        <div className={`rounded-xl border p-3 text-sm flex items-start gap-2 ${msg.tipo === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
          <span className="flex-1">{msg.texto}</span>
          <button onClick={() => setMsg(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Público */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-3">
        <p className="font-semibold text-slate-700">1. Público</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Comprou entre</span>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="border border-[#E7E2D8] rounded-lg px-2 py-1" />
          <span className="text-slate-500">e</span>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="border border-[#E7E2D8] rounded-lg px-2 py-1" />
          <label className="flex items-center gap-1.5 ml-2"><input type="checkbox" checked={mulheres} onChange={(e) => setMulheres(e.target.checked)} /> só mulheres</label>
          <span className="text-slate-500 ml-2">no máx</span>
          <input type="number" value={limite} min={1} max={500} onChange={(e) => setLimite(Number(e.target.value))} className="w-20 border border-[#E7E2D8] rounded-lg px-2 py-1" />
        </div>
        {previa && (
          <p className="text-sm text-slate-600"><b className="text-[#B8912B]">{previa.total}</b> pessoas no público (pega as de maior LTV). Ex.: {previa.amostra.slice(0, 4).join(', ')}…</p>
        )}
      </div>

      {/* Mensagens */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-3">
        <p className="font-semibold text-slate-700">2. Mensagens <span className="font-normal text-slate-400 text-sm">— use <code>{'{nome}'}</code>; o sistema sorteia uma por pessoa</span></p>
        {mensagens.map((m, i) => (
          <div key={i} className="flex gap-2">
            <textarea value={m} onChange={(e) => setMensagens(mensagens.map((x, j) => (j === i ? e.target.value : x)))} rows={2} className="flex-1 border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm" />
            {mensagens.length > 1 && <button onClick={() => setMensagens(mensagens.filter((_, j) => j !== i))} className="text-slate-400 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>}
          </div>
        ))}
        <button onClick={() => setMensagens([...mensagens, ''])} className="inline-flex items-center gap-1 text-sm text-[#B8912B] hover:underline"><Plus className="w-4 h-4" /> variação</button>
        <div className="pt-2">
          <label className="text-sm text-slate-500">Foto (opcional, mandada junto):</label>
          <input value={imagemUrl} onChange={(e) => setImagemUrl(e.target.value)} placeholder="https://..." className="w-full mt-1 border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      {/* Teste + Disparo */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-3">
        <p className="font-semibold text-slate-700">3. Testar e disparar</p>
        <input value={nome} onChange={(e) => setNome(e.target.value)} className="w-full border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm" placeholder="Nome da campanha" />
        <div className="flex flex-wrap items-center gap-2">
          <input value={foneTeste} onChange={(e) => setFoneTeste(e.target.value)} placeholder="Seu número pra teste (só dígitos)" className="flex-1 min-w-[180px] border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm" />
          <button onClick={testar} disabled={ocupado} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-700 text-sm disabled:opacity-50">
            {ocupado ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Testar em mim
          </button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={() => criar(true)} disabled={ocupado} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#2E7D46] text-white font-semibold text-sm hover:brightness-110 disabled:opacity-50">
            <Play className="w-4 h-4" /> Criar e disparar
          </button>
          <button onClick={() => criar(false)} disabled={ocupado} className="px-4 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-700 text-sm disabled:opacity-50">Salvar rascunho</button>
        </div>
        <p className="text-xs text-slate-400">Dispara 1 a cada ~1-2 min (aleatório). Se der 3 falhas seguidas, para sozinho pra proteger o número.</p>
      </div>

      {/* Campanhas */}
      {campanhas.length > 0 && (
        <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E7E2D8]"><h2 className="font-semibold text-slate-800">Campanhas</h2></div>
          <div className="divide-y divide-[#E7E2D8]">
            {campanhas.map((c) => {
              const pct = c.total ? Math.round((c.enviados / c.total) * 100) : 0;
              return (
                <div key={c.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-800 truncate">{c.nome}</p>
                      <p className="text-xs text-slate-500">
                        {c.enviados}/{c.total} enviados{c.falhas > 0 && ` · ${c.falhas} falhas`} ·{' '}
                        <span className={c.status === 'enviando' ? 'text-[#2E7D46] font-semibold' : c.status === 'pausada' ? 'text-amber-600 font-semibold' : 'text-slate-500'}>{c.status}</span>
                        {c.pausaMotivo && ` — ${c.pausaMotivo}`}
                      </p>
                    </div>
                    {c.status === 'enviando' && <button onClick={() => acao(c.id, 'pausar')} className="p-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6]" title="Pausar"><Pause className="w-4 h-4" /></button>}
                    {(c.status === 'pausada' || c.status === 'rascunho') && <button onClick={() => acao(c.id, 'retomar')} className="p-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-[#2E7D46]" title="Iniciar/Retomar"><Play className="w-4 h-4" /></button>}
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-[#F1EDE3] overflow-hidden"><div className="h-full bg-[#2E7D46]" style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
