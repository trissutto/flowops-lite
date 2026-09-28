'use client';

/**
 * /minha-loja/inventario — a contagem da loja, sem fechar a loja.
 *
 * Desenhada pra uma pessoa em pé com o leitor na mão e a loja aberta:
 *
 *  · O foco NUNCA sai do campo de bipe. Nenhum passo entre duas peças.
 *  · CEGA de propósito — a tela não mostra quanto o sistema acha que tem.
 *    Com o número do sistema na tela, a contagem vira conferência do sistema.
 *  · FILA OFFLINE: bipe que não conseguiu subir fica gravado no aparelho e
 *    sobe sozinho quando a rede volta. O `clientId` viaja com ele, então
 *    reenvio não conta a peça duas vezes. Sem isso, uma queda de WiFi no
 *    corredor apaga meia arara de contagem.
 *  · Bipar não mexe no estoque. A loja continua vendendo; quem ajusta é a
 *    matriz, e o que ela aplica é a DIFERENÇA.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft, Loader2, PackageSearch, Undo2, CheckCircle2, AlertTriangle, WifiOff, RotateCcw,
} from 'lucide-react';

type Bipe = {
  id: string;
  sku: string;
  rotulo: string | null;
  delta: number;
  naoCadastrado: boolean;
  bipadoEm: string;
  bipadoPor: string | null;
};

type Sessao = {
  id: string;
  storeCode: string;
  status: string;
  abertaEm: string;
  abertaPor: string | null;
} | null;

type Recontar = { sku: string; rotulo: string | null; rodada: number; contadoNaRodada: number };

type Painel = {
  sessao: Sessao;
  pecasContadas?: number;
  codigosContados?: number;
  ultimos?: Bipe[];
  recontar?: Recontar[];
};

type Pendente = { clientId: string; codigo: string; em: number };

const FILA_KEY = 'inventario:fila';

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * SÓ NÚMERO ENTRA. A etiqueta tem o código de barras E um QR code, e o leitor
 * às vezes pega o QR (URL/texto, com letra e barra). Código de barras é só
 * dígito — EAN-13 nas peças novas, 6-8 dígitos nas antigas (o leitor manda
 * sem zeros à esquerda). Já foi "exatamente 13" por ~1h em 28/09 e travou a
 * loja 15 nas peças antigas. Mesma régua do servidor
 * (`common/inventario-contagem.ts`, `ehCodigoDeBarras`).
 */
const ehCodigoDeBarras = (v: string) => /^\d+$/.test(v.trim());
const MSG_SO_EAN13 =
  'Isso não é o código de barras da peça — o leitor pegou o QR code (ou outra coisa). ' +
  'Aponte pro código de BARRAS (só números) e bipe de novo. Nada foi contado.';

/** Som pela Web Audio, sem arquivo. O leitor apita igual pra tudo — o som
 *  GRAVE e triplo é o que faz a pessoa olhar pra tela quando deu errado. */
const tocar = (tipo: 'ok' | 'erro') => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const bipe = (em: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tipo === 'ok' ? 'sine' : 'square';
      osc.frequency.value = tipo === 'ok' ? 880 : 200;
      gain.gain.value = tipo === 'ok' ? 0.12 : 0.25;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + em);
      osc.stop(ctx.currentTime + em + dur);
    };
    if (tipo === 'ok') bipe(0, 0.07);
    else {
      bipe(0, 0.3);
      bipe(0.4, 0.3);
      bipe(0.8, 0.3);
    }
  } catch {}
};

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export default function InventarioLojaPage() {
  const [painel, setPainel] = useState<Painel>({ sessao: null });
  const [carregando, setCarregando] = useState(true);
  const [codigo, setCodigo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [ultima, setUltima] = useState<{
    rotulo: string | null;
    sku: string;
    contado: number;
    naoCadastrado?: boolean;
    recontagem?: boolean;
  } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [fila, setFila] = useState<Pendente[]>([]);
  const [confirmarEncerrar, setConfirmarEncerrar] = useState(false);
  const campoRef = useRef<HTMLInputElement>(null);

  const focar = useCallback(() => {
    // O leitor manda o código como se fosse digitação: sem foco, a leitura
    // se perde (ou pior, cai em outro campo da tela).
    setTimeout(() => campoRef.current?.focus(), 30);
  }, []);

  const carregar = useCallback(async () => {
    try {
      const r = await api<Painel>('/inventario/loja');
      setPainel(r);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar a contagem');
    } finally {
      setCarregando(false);
      focar();
    }
  }, [focar]);

  useEffect(() => {
    void carregar();
    try {
      const salvo = localStorage.getItem(FILA_KEY);
      if (salvo) setFila(JSON.parse(salvo));
    } catch {
      /* aba privada / storage bloqueado: segue sem fila salva */
    }
  }, [carregar]);

  const salvarFila = useCallback((nova: Pendente[]) => {
    setFila(nova);
    try {
      localStorage.setItem(FILA_KEY, JSON.stringify(nova));
    } catch {
      /* ignora: a fila em memória continua valendo nesta sessão */
    }
  }, []);

  const enviarBipe = useCallback(
    async (codigoBipe: string, clientId: string) => {
      return api<{
        sku: string;
        rotulo: string | null;
        contadoDesteCodigo: number;
        pecasContadas: number;
        naoCadastrado?: boolean;
        recontagem?: boolean;
        duplicado?: boolean;
      }>('/inventario/bipar', {
        method: 'POST',
        body: JSON.stringify({ codigo: codigoBipe, clientId }),
      });
    },
    [],
  );

  /**
   * FILA SERIAL DE ENVIO — um bipe nunca é descartado.
   *
   * Descoberto no preview: o leitor bipa mais rápido que o round-trip, e
   * bloquear por "já estou enviando" jogava a segunda peça fora EM SILÊNCIO,
   * com o código acumulando dentro do campo. Peça não contada e ninguém
   * avisado — o mesmo tipo de falha calada que a contagem existe pra achar.
   *
   * Agora o Enter SEMPRE limpa o campo e empurra pra fila; a fila é consumida
   * uma peça por vez, na ordem em que foram bipadas.
   */
  const pendenteEnvio = useRef<Array<{ codigo: string; clientId: string }>>([]);
  const consumindo = useRef(false);

  const consumir = useCallback(async () => {
    if (consumindo.current) return;
    consumindo.current = true;
    setEnviando(true);
    try {
      while (pendenteEnvio.current.length) {
        const item = pendenteEnvio.current.shift()!;
        try {
          const r = await enviarBipe(item.codigo, item.clientId);
          setUltima({
            rotulo: r.rotulo,
            sku: r.sku,
            contado: r.contadoDesteCodigo,
            naoCadastrado: r.naoCadastrado,
            recontagem: r.recontagem,
          });
          setPainel((p) => ({ ...p, pecasContadas: r.pecasContadas }));
          setErro(null);
          tocar(r.naoCadastrado ? 'erro' : 'ok');
        } catch (e: any) {
          const msg = String(e?.message || '');
          // Recusa do servidor (inventário fechado, código vazio) NÃO vai pra
          // fila offline: repetir não resolveria e a pessoa precisa saber agora.
          const ehRede = /failed to fetch|network|timeout|offline/i.test(msg);
          if (ehRede) {
            setFila((f) => {
              const nova = [...f, { clientId: item.clientId, codigo: item.codigo, em: Date.now() }];
              try {
                localStorage.setItem(FILA_KEY, JSON.stringify(nova));
              } catch {
                /* storage bloqueado: a fila em memória continua valendo */
              }
              return nova;
            });
            setUltima({ rotulo: 'guardado no aparelho', sku: item.codigo, contado: 0 });
          } else {
            setErro(msg || 'Não consegui registrar este bipe');
            tocar('erro');
          }
        }
      }
      void carregar();
    } finally {
      consumindo.current = false;
      setEnviando(false);
      focar();
    }
  }, [enviarBipe, carregar, focar]);

  const bipar = useCallback(() => {
    const valor = codigo.trim();
    setCodigo('');
    if (!valor) return;
    if (!ehCodigoDeBarras(valor)) {
      // QR code (ou digitação) — recusa NA HORA, sem ir pro servidor nem pra
      // fila offline: não é peça, não conta.
      setUltima(null);
      setErro(MSG_SO_EAN13);
      tocar('erro');
      focar();
      return;
    }
    pendenteEnvio.current.push({ codigo: valor, clientId: uuid() });
    void consumir();
  }, [codigo, consumir, focar]);

  /* A fila sobe sozinha: a cada 8s e sempre que o navegador avisa que voltou. */
  const drenarFila = useCallback(async () => {
    if (!fila.length) return;
    const restantes: Pendente[] = [];
    for (const p of fila) {
      try {
        await enviarBipe(p.codigo, p.clientId);
      } catch {
        restantes.push(p);
      }
    }
    salvarFila(restantes);
    if (restantes.length !== fila.length) void carregar();
  }, [fila, enviarBipe, salvarFila, carregar]);

  useEffect(() => {
    if (!fila.length) return;
    const t = setInterval(() => void drenarFila(), 8000);
    const aoVoltar = () => void drenarFila();
    window.addEventListener('online', aoVoltar);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', aoVoltar);
    };
  }, [fila.length, drenarFila]);

  const desfazer = useCallback(async () => {
    try {
      const r = await api<{ rotulo: string | null; sku: string; contadoDesteCodigo: number; pecasContadas: number }>(
        '/inventario/corrigir',
        { method: 'POST', body: JSON.stringify({}) },
      );
      setUltima({ rotulo: `− ${r.rotulo || r.sku}`, sku: r.sku, contado: r.contadoDesteCodigo });
      setPainel((p) => ({ ...p, pecasContadas: r.pecasContadas }));
      void carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui desfazer');
    } finally {
      focar();
    }
  }, [carregar, focar]);

  const encerrar = useCallback(async () => {
    if (!painel.sessao) return;
    setConfirmarEncerrar(false);
    try {
      await api(`/inventario/${painel.sessao.id}/encerrar`, { method: 'POST' });
      void carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui encerrar');
    }
  }, [painel.sessao, carregar]);

  const sessao = painel.sessao;
  const aberta = sessao?.status === 'aberta';

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/minha-loja" className="p-2 hover:bg-slate-100 rounded-lg">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="flex items-center gap-2">
            <PackageSearch className="w-5 h-5 text-slate-700" />
            <h1 className="font-black text-slate-800 uppercase tracking-wide text-sm">Inventário</h1>
          </div>
          <div className="ml-auto flex items-center gap-4">
            {fila.length > 0 && (
              <button
                onClick={() => void drenarFila()}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-300 rounded-lg text-[11px] font-bold text-amber-800"
                title="Bipes guardados no aparelho — clique pra tentar enviar agora"
              >
                <WifiOff className="w-3.5 h-3.5" />
                {fila.length} pra subir
              </button>
            )}
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Peças contadas</div>
              <div className="font-mono font-black text-2xl leading-none text-slate-800">
                {painel.pecasContadas ?? 0}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">
        {carregando && (
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
          </div>
        )}

        {!carregando && !sessao && (
          <section className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
            <PackageSearch className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <div className="font-black text-slate-800 mb-1">Nenhuma contagem aberta</div>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              Quem abre o inventário é a matriz, em Retaguarda → Inventário. Assim que ela abrir,
              esta tela passa a aceitar o bipe — e a loja continua vendendo normal durante a contagem.
            </p>
          </section>
        )}

        {sessao && !aberta && (
          <section className="bg-emerald-50 border-2 border-emerald-300 rounded-2xl p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" />
              <div>
                <div className="font-black text-emerald-900">Contagem encerrada</div>
                <p className="text-sm text-emerald-800 mt-1">
                  A matriz está conferindo. Se ela pedir pra recontar alguns códigos, eles aparecem
                  aqui e esta tela volta a aceitar bipe sozinha.
                </p>
              </div>
            </div>
          </section>
        )}

        {aberta && (
          <>
            {(painel.recontar?.length ?? 0) > 0 && (
              <section className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <RotateCcw className="w-4 h-4 text-amber-700" />
                  <div className="font-black text-amber-900 text-sm uppercase tracking-wide">
                    A matriz pediu pra contar estes de novo
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {painel.recontar!.map((r) => (
                    <div
                      key={r.sku}
                      className="flex items-center justify-between bg-white border border-amber-200 rounded-lg px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-slate-800 text-sm truncate">
                          {r.rotulo || r.sku}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{r.sku}</div>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <div className="text-[10px] uppercase text-slate-500">já bipou</div>
                        <div className="font-mono font-black text-slate-800">{r.contadoNaRodada}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-amber-800 mt-2">
                  Conte a peça de novo na arara. A segunda contagem substitui a primeira.
                </p>
              </section>
            )}

            <section className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-600 mb-1">
                Bipe a peça{' '}
                <span className="font-normal text-slate-400">
                  — uma de cada vez, a etiqueta ou o código de barras
                </span>
                {enviando && (
                  <span className="flex items-center gap-1 text-slate-400 font-normal">
                    <Loader2 className="w-3 h-3 animate-spin" /> registrando
                  </span>
                )}
              </label>
              <input
                ref={campoRef}
                autoFocus
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                /* O campo recupera o foco sozinho — menos quando um modal está
                   aberto, senão ele rouba o foco de quem está confirmando. */
                onBlur={() => {
                  if (!confirmarEncerrar) focar();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void bipar();
                  }
                }}
                placeholder="Bipe aqui"
                className="w-full h-20 px-4 border-2 border-slate-800 rounded-xl font-mono text-4xl font-black tracking-wider text-slate-800 bg-white outline-none focus:border-amber-500 focus:ring-4 focus:ring-amber-100"
              />

              {erro && (
                <div className="mt-3 flex items-start gap-3 bg-red-600 border-4 border-red-800 rounded-xl px-4 py-4 animate-pulse">
                  <AlertTriangle className="w-8 h-8 text-white shrink-0" />
                  <div className="text-lg text-white font-black leading-snug">{erro}</div>
                </div>
              )}

              {ultima && !erro && (
                <div
                  className={`mt-3 rounded-xl px-4 py-3 border-2 ${
                    ultima.naoCadastrado
                      ? 'bg-red-600 border-red-800 text-white'
                      : 'bg-emerald-50 border-emerald-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      {ultima.naoCadastrado ? (
                        <>
                          <div className="flex items-center gap-2 font-black text-2xl uppercase">
                            <AlertTriangle className="w-8 h-8 shrink-0" /> Código NÃO EXISTE no cadastro
                          </div>
                          <div className="font-mono text-lg font-bold mt-1">{ultima.sku}</div>
                          <div className="text-base font-bold mt-2 leading-snug">
                            Contei e guardei pra matriz cadastrar. SEPARE ESTA PEÇA da arara antes de
                            seguir — ela não vai entrar no ajuste.
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="font-black text-slate-800 text-lg truncate">
                            {ultima.rotulo || ultima.sku}
                          </div>
                          <div className="font-mono text-xs text-slate-500">{ultima.sku}</div>
                        </>
                      )}
                      {ultima.recontagem && (
                        <div className="text-[12px] font-bold text-amber-800 mt-1">
                          Este é um dos que a matriz pediu pra recontar.
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">
                        deste código
                      </div>
                      <div className="font-mono font-black text-3xl leading-none text-slate-800">
                        {ultima.contado}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => void desfazer()}
                  className="flex items-center gap-2 px-4 py-2.5 bg-white border-2 border-slate-300 hover:bg-slate-50 rounded-xl font-bold text-sm text-slate-700"
                >
                  <Undo2 className="w-4 h-4" /> Bipei errado — tirar 1
                </button>
                <button
                  onClick={() => setConfirmarEncerrar(true)}
                  className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-bold text-sm ml-auto"
                >
                  <CheckCircle2 className="w-4 h-4" /> Acabei de contar a loja
                </button>
              </div>
            </section>

            <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-100 text-[11px] font-black uppercase tracking-wider text-slate-500">
                Últimas peças · {painel.codigosContados ?? 0} códigos diferentes até agora
              </div>
              {(painel.ultimos?.length ?? 0) === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  Nada bipado ainda. Comece por uma arara e siga a loja inteira.
                </div>
              ) : (
                <div className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
                  {painel.ultimos!.map((b) => (
                    <div key={b.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                      <span
                        className={`font-mono font-black w-8 text-center ${
                          b.delta < 0 ? 'text-red-600' : 'text-emerald-700'
                        }`}
                      >
                        {b.delta > 0 ? '+1' : '−1'}
                      </span>
                      <span className="font-bold text-slate-800 truncate flex-1">
                        {b.rotulo || b.sku}
                        {b.naoCadastrado && (
                          <span className="ml-2 text-[10px] font-black uppercase text-amber-700">
                            sem cadastro
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[11px] text-slate-400 shrink-0">{b.sku}</span>
                      <span className="text-[11px] text-slate-500 shrink-0 w-12 text-right">
                        {hora(b.bipadoEm)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Modal próprio: o PC de loja roda o app Electron, e window.confirm/prompt
          não é caminho confiável ali. */}
      {confirmarEncerrar && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-5">
            <div className="font-black text-slate-800 text-lg mb-2">Encerrar a contagem?</div>
            <p className="text-sm text-slate-600 mb-1">
              Você contou <b className="font-mono">{painel.pecasContadas ?? 0}</b> peças. Depois de
              encerrar, a matriz confere as diferenças e aplica o ajuste.
            </p>
            <p className="text-sm text-slate-600 mb-4">
              Se ela pedir recontagem de alguns códigos, esta tela volta a aceitar bipe sozinha.
            </p>
            {fila.length > 0 && (
              <div className="mb-4 flex items-start gap-2 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
                <WifiOff className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div className="text-[12px] text-amber-900">
                  Ainda tem <b>{fila.length}</b> bipe(s) guardado(s) no aparelho pra subir. Espere a
                  rede voltar antes de encerrar, senão eles entram depois da conferência.
                </div>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setConfirmarEncerrar(false);
                  focar();
                }}
                className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg font-bold text-sm"
              >
                Continuar contando
              </button>
              <button
                onClick={() => void encerrar()}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg font-bold text-sm"
              >
                Encerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
