'use client';

/**
 * /retaguarda/whatsapp-inbox
 *
 * WhatsApp Web da instância `lurds-abandono` DENTRO do FlowOps (dono, 15/08).
 * O celular fica na loja; a operadora lê e responde do PC. Lê do Evolution
 * (findChats/findMessages) e responde (sendText) — sem banco, é uma janela.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, MessageCircle, RefreshCw, Send, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';

type Conversa = { jid: string; numero: string; nome: string; texto: string; ts: number; fromMe: boolean; naoLidas: number };
type Msg = { id: string | null; fromMe: boolean; texto: string; ts: number; status?: string };

const TZ = 'America/Sao_Paulo';
const hora = (ms: number) => (ms ? new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '');
const dia = (ms: number) => (ms ? new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: TZ }) : '');

export default function WhatsappInboxPage() {
  const [conversas, setConversas] = useState<Conversa[]>([]);
  const [sel, setSel] = useState<Conversa | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [texto, setTexto] = useState('');
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [carregandoMsgs, setCarregandoMsgs] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [sugerindo, setSugerindo] = useState(false);
  const [erro, setErro] = useState('');
  const fimRef = useRef<HTMLDivElement>(null);

  const carregarConversas = useCallback(async (force = false) => {
    try {
      const r = await api<Conversa[]>(`/whatsapp-inbox/conversas${force ? '?force=1' : ''}`);
      setConversas(r || []);
      setErro('');
    } catch (e: any) {
      setErro(e?.message || 'Falha ao carregar conversas');
    } finally {
      setCarregandoLista(false);
    }
  }, []);

  useEffect(() => { carregarConversas(true); const t = setInterval(() => carregarConversas(false), 12000); return () => clearInterval(t); }, [carregarConversas]);

  const carregarMsgs = useCallback(async (jid: string, comLoader = false) => {
    if (comLoader) setCarregandoMsgs(true);
    try {
      const r = await api<Msg[]>(`/whatsapp-inbox/mensagens?jid=${encodeURIComponent(jid)}`);
      setMsgs(r || []);
    } catch (e: any) {
      setErro(e?.message || 'Falha ao carregar mensagens');
    } finally {
      setCarregandoMsgs(false);
    }
  }, []);

  // Ao selecionar / poll da conversa aberta
  useEffect(() => {
    if (!sel) return;
    carregarMsgs(sel.jid, true);
    const t = setInterval(() => carregarMsgs(sel.jid), 6000);
    return () => clearInterval(t);
  }, [sel, carregarMsgs]);

  useEffect(() => { fimRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  async function responder() {
    if (!sel || !texto.trim()) return;
    setEnviando(true);
    const t = texto;
    setTexto('');
    // otimista
    setMsgs((m) => [...m, { id: `tmp-${Date.now()}`, fromMe: true, texto: t, ts: Date.now() }]);
    try {
      await api('/whatsapp-inbox/responder', { method: 'POST', body: JSON.stringify({ jid: sel.jid, texto: t }) });
      carregarMsgs(sel.jid);
      carregarConversas(true);
    } catch (e: any) {
      setErro(e?.message || 'Falha ao enviar');
      setTexto(t); // devolve o texto
    } finally {
      setEnviando(false);
    }
  }

  async function sugerir() {
    if (!sel) return;
    setSugerindo(true);
    setErro('');
    try {
      const r = await api<{ sugestao: string }>('/whatsapp-inbox/sugerir', { method: 'POST', body: JSON.stringify({ jid: sel.jid }) });
      setTexto(r.sugestao || '');
    } catch (e: any) {
      setErro(e?.message || 'IA falhou');
    } finally {
      setSugerindo(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2"><MessageCircle className="w-5 h-5 text-[#2E7D46]" /> WhatsApp — Conversas</h1>
          <p className="text-sm text-slate-500">Leia e responda as clientes do PC. O celular fica na loja.</p>
        </div>
        <button onClick={() => carregarConversas(true)} className="px-3 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600" title="Atualizar"><RefreshCw className={`w-4 h-4 ${carregandoLista ? 'animate-spin' : ''}`} /></button>
      </div>

      {erro && <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 p-3 text-sm">{erro}</div>}

      <div className="flex gap-0 border border-[#E7E2D8] rounded-xl overflow-hidden bg-white" style={{ height: 'calc(100vh - 200px)', minHeight: 420 }}>
        {/* Lista de conversas */}
        <div className={`w-full sm:w-[340px] shrink-0 border-r border-[#E7E2D8] overflow-y-auto ${sel ? 'hidden sm:block' : ''}`}>
          {carregandoLista ? (
            <div className="p-6 flex items-center gap-2 text-slate-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
          ) : conversas.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">Nenhuma conversa ainda. Quando as clientes responderem, aparecem aqui.</div>
          ) : (
            conversas.map((c) => (
              <button
                key={c.jid}
                onClick={() => setSel(c)}
                className={`w-full text-left px-3 py-3 border-b border-[#F1EDE3] hover:bg-[#FBF6E6] ${sel?.jid === c.jid ? 'bg-[#FBF6E6]' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-full bg-[#E7E2D8] flex items-center justify-center text-slate-600 font-semibold text-sm shrink-0">
                    {(c.nome || '?').trim().charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-800 truncate">{c.nome}</span>
                      <span className="text-[11px] text-slate-400 shrink-0">{hora(c.ts) || dia(c.ts)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-500 truncate">{c.fromMe ? 'Você: ' : ''}{c.texto || '—'}</span>
                      {c.naoLidas > 0 && <span className="shrink-0 text-[10px] bg-[#2E7D46] text-white rounded-full px-1.5 py-0.5">{c.naoLidas}</span>}
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Thread */}
        <div className={`flex-1 flex flex-col ${sel ? '' : 'hidden sm:flex'}`}>
          {!sel ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Escolha uma conversa à esquerda.</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-[#E7E2D8] flex items-center gap-2 bg-[#FAFAF7]">
                <button onClick={() => setSel(null)} className="sm:hidden text-slate-500"><ArrowLeft className="w-5 h-5" /></button>
                <div className="w-8 h-8 rounded-full bg-[#E7E2D8] flex items-center justify-center text-slate-600 font-semibold text-sm">{(sel.nome || '?').charAt(0).toUpperCase()}</div>
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800 truncate">{sel.nome}</div>
                  <div className="text-xs text-slate-400 tabular-nums">{sel.numero}</div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-[#f6f3ee]">
                {carregandoMsgs && msgs.length === 0 ? (
                  <div className="flex items-center gap-2 text-slate-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
                ) : (
                  msgs.map((m, i) => (
                    <div key={m.id || i} className={`flex ${m.fromMe ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ${m.fromMe ? 'bg-[#D8F2DE] text-slate-800' : 'bg-white text-slate-800'}`}>
                        <div className="whitespace-pre-wrap break-words">{m.texto || '—'}</div>
                        <div className="text-[10px] text-slate-400 text-right mt-0.5">
                          {hora(m.ts)}
                          {m.fromMe && m.status && (
                            <span className={`ml-1 ${m.status === 'lido' ? 'text-[#34B7F1]' : 'text-slate-400'}`} title={m.status}>
                              {m.status === 'enviado' ? '✓' : '✓✓'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={fimRef} />
              </div>

              <div className="p-3 border-t border-[#E7E2D8] flex items-end gap-2 bg-white">
                <button onClick={sugerir} disabled={sugerindo} title="Sugerir resposta com IA (lê a conversa + pedidos da cliente)" className="p-2.5 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-[#B8912B] disabled:opacity-40 shrink-0">
                  {sugerindo ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                </button>
                <textarea
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); responder(); } }}
                  rows={1}
                  placeholder="Escreva uma resposta… (Enter envia)"
                  className="flex-1 resize-none border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm max-h-32"
                />
                <button onClick={responder} disabled={enviando || !texto.trim()} className="p-2.5 rounded-lg bg-[#2E7D46] text-white disabled:opacity-40">
                  {enviando ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
