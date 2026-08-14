'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, MessageCircle, Send, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/store/chat';

/**
 * ASSISTENTE DA LURD'S — o atendimento dentro do site.
 *
 * Bolha fixa em todas as páginas + convites contextuais (o seletor de tamanho,
 * o frete, o carrinho) que abrem o chat com a pergunta já escrita.
 *
 * DECISÕES DE COMPORTAMENTO
 * - Não abre sozinha. Chat que salta na cara é o motivo de a maioria das
 *   pessoas fechar antes de ler.
 * - Não aparece no checkout: ali a cliente está pagando, e qualquer coisa que
 *   dispute a atenção com o botão de finalizar custa venda.
 * - A primeira fala é da assistente, com três atalhos do que ela sabe fazer —
 *   tela em branco não convida ninguém a escrever.
 */

const SAUDACAO =
  'Oi! Sou a consultora virtual da Lurd\'s 💛 Posso te ajudar a achar uma peça, ' +
  'tirar dúvida de tamanho ou falar de troca e entrega. O que você precisa?';

const ATALHOS = [
  'Me ajuda a escolher o tamanho',
  'Quero um look pra festa',
  'Como funciona a troca?',
];

export function AssistenteWidget() {
  const pathname = usePathname();
  const { aberto, abrir, fechar, falas, registrar, pensando, setPensando } = useChatStore();
  const chatId = useChatStore((s) => s.chatId);
  const setChatId = useChatStore((s) => s.setChatId);
  const sessaoId = useChatStore((s) => s.sessaoId);
  const rascunho = useChatStore((s) => s.rascunho);
  const setRascunho = useChatStore((s) => s.setRascunho);
  const contexto = useChatStore((s) => s.contexto);

  const [erro, setErro] = useState<string | null>(null);
  const fimRef = useRef<HTMLDivElement>(null);

  // No checkout a assistente não existe — ver comentário do topo.
  const escondida = pathname?.startsWith('/checkout');
  const paginaProduto = pathname?.startsWith('/produto/');

  useEffect(() => {
    if (aberto) fimRef.current?.scrollIntoView({ block: 'end' });
  }, [aberto, falas.length, pensando]);

  async function enviar(texto: string) {
    const mensagem = texto.trim();
    if (!mensagem || pensando) return;
    setErro(null);
    setRascunho('');
    registrar({ papel: 'cliente', texto: mensagem });
    setPensando(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          sessaoId,
          mensagem,
          contexto: contexto ?? (pathname ? `Página ${pathname}` : null),
        }),
      });
      const dados = await r.json();
      if (!r.ok) throw new Error(dados?.erro || 'Não consegui responder agora.');
      if (dados.chatId) setChatId(dados.chatId);
      registrar({ papel: 'assistente', texto: dados.resposta });
    } catch (e: unknown) {
      setErro(e instanceof Error ? e.message : 'Não consegui responder agora.');
    } finally {
      setPensando(false);
    }
  }

  if (escondida) return null;

  return (
    <>
      {/* Bolha */}
      <button
        type="button"
        onClick={() => (aberto ? fechar() : abrir())}
        aria-label={aberto ? 'Fechar atendimento' : 'Falar com a consultora virtual'}
        className={cn(
          'fixed right-4 z-[60] flex size-14 items-center justify-center rounded-pill bg-ink text-light shadow-lg transition-transform hover:scale-105 lg:right-6 lg:bottom-6',
          paginaProduto ? 'bottom-24' : 'bottom-4',
        )}
      >
        {aberto ? <X className="size-5" strokeWidth={1.75} /> : <MessageCircle className="size-6" strokeWidth={1.5} />}
      </button>

      {/* Painel — sempre montado, escondido com inert (padrão de overlay da casa) */}
      <div
        {...(!aberto ? { inert: '' as unknown as boolean } : {})}
        aria-hidden={!aberto}
        className={cn(
          'fixed right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-sm border border-border bg-background shadow-xl transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] lg:right-6 lg:bottom-24',
          paginaProduto ? 'bottom-40' : 'bottom-20',
          aberto ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
        )}
        style={{ maxHeight: 'min(560px, calc(100vh - 8rem))' }}
      >
        <header className="border-b border-border px-4 py-3">
          <p className="text-body">Consultora Lurd&apos;s</p>
          <p className="text-small text-muted">Respondo na hora — do 44 ao 60</p>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <Balao papel="assistente" texto={SAUDACAO} />
          {falas.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {ATALHOS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => void enviar(a)}
                  className="rounded-pill border border-border px-3 py-1.5 text-small text-ink-soft transition-colors hover:border-ink hover:text-ink"
                >
                  {a}
                </button>
              ))}
            </div>
          )}
          {falas.map((f, i) => (
            <Balao key={i} papel={f.papel} texto={f.texto} />
          ))}
          {pensando && (
            <p className="flex items-center gap-2 text-small text-muted">
              <Loader2 className="size-3.5 animate-spin" /> escrevendo…
            </p>
          )}
          {erro && <p className="text-small text-danger">{erro}</p>}
          <div ref={fimRef} />
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); void enviar(rascunho); }}
          className="flex items-center gap-2 border-t border-border p-3"
        >
          <input
            value={rascunho}
            onChange={(e) => setRascunho(e.target.value)}
            placeholder="Escreva sua dúvida…"
            aria-label="Sua mensagem"
            maxLength={500}
            className="min-w-0 flex-1 rounded-sm border border-border bg-background px-3 py-2.5 text-body outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={pensando || !rascunho.trim()}
            aria-label="Enviar"
            className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-ink text-light disabled:opacity-40"
          >
            <Send className="size-4" strokeWidth={1.75} />
          </button>
        </form>
      </div>
    </>
  );
}

function Balao({ papel, texto }: { papel: 'cliente' | 'assistente'; texto: string }) {
  const daCliente = papel === 'cliente';
  return (
    <div className={daCliente ? 'flex justify-end' : 'flex justify-start'}>
      <p
        className={`max-w-[85%] whitespace-pre-wrap rounded-sm px-3 py-2 text-small ${
          daCliente ? 'bg-ink text-light' : 'bg-surface-alt text-ink'
        }`}
      >
        {texto}
      </p>
    </div>
  );
}

/**
 * Convite contextual — o botão que a página coloca onde a dúvida trava a
 * compra. Abre o chat já com a pergunta escrita e com o contexto da peça.
 */
export function ChamarConsultora({
  pergunta, contexto, children, className,
}: {
  pergunta: string;
  contexto?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const abrir = useChatStore((s) => s.abrir);
  return (
    <button
      type="button"
      onClick={() => abrir({ rascunho: pergunta, contexto: contexto ?? null })}
      className={className ?? 'link-underline text-small text-muted'}
    >
      {children}
    </button>
  );
}
