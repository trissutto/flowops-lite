'use client';

/**
 * /retaguarda/integracoes — SAÚDE DAS INTEGRAÇÕES
 *
 * ── POR QUE ESTA TELA EXISTE ──
 *
 * O vigia do token da Meta (`MetaTokenWatchdogService`) manda push pros admins
 * com `url: '/retaguarda/integracoes'` — e essa rota NÃO EXISTIA. O alerta
 * "Instagram desconectado" chegava e o clique dava 404: o aviso funcionava e
 * levava a lugar nenhum.
 *
 * ── O QUE ELA RESPONDE ──
 *
 * Uma pergunta só: **"por que o Instagram sumiu do site?"** — e a resposta
 * junto com o conserto. Em 12/08/2026 o token estava vencido de novo (venceu
 * dia 10 às 16h, no MESMO dia em que foi trocado, porque era um token de curta
 * duração do Graph API Explorer). Sem esta tela, o caminho pra descobrir isso
 * era ler log de produção.
 *
 * Por isso o passo a passo do conserto mora AQUI, no destino do alarme, e não
 * num documento: quem recebe o push às 9h da manhã precisa do link, não de uma
 * caça ao tesouro no Business Manager.
 *
 * ── DUAS LEITURAS, DE PROPÓSITO ──
 *
 * · Ao abrir: o último resultado do vigia (das 9h), que sai do Postgres e não
 *   custa requisição nenhuma. A cota da Graph API é a MESMA que a live usa pra
 *   responder comentário e mandar DM — abrir uma tela não pode gastá-la.
 * · "Testar agora": uma requisição, sob demanda. Existe porque quem acabou de
 *   colar o token novo quer confirmar AGORA, não amanhã de manhã.
 *
 * ── O ALVO É `expiraEm: null` ──
 *
 * Token que não expira só sai de **Usuário do Sistema** no Business Manager.
 * Qualquer outro caminho (Explorer, token de página comum) vence — e vencer em
 * silêncio é exatamente o que custou 3 meses de live muda.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Plug, AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ChevronLeft,
  Instagram, CreditCard, Truck, MessageCircle,
} from 'lucide-react';
import { api } from '@/lib/api';

/** Espelha `StatusToken` do backend (`meta-token-watchdog.service.ts`). */
interface StatusToken {
  valido: boolean;
  /** ISO, ou null quando o token NÃO expira (Usuário do Sistema) — o alvo. */
  expiraEm: string | null;
  diasRestantes: number | null;
  motivo: string | null;
  alertar: boolean;
  verificadoEm: string;
}

/**
 * O negócio da loja no Business Manager. Env pra não chumbar identidade de
 * conta no código, com o valor real como padrão — a tela precisa funcionar sem
 * ninguém configurar nada, que é justamente o momento em que ela é usada.
 */
const META_BUSINESS_ID = process.env.NEXT_PUBLIC_META_BUSINESS_ID || '137805427313943';
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || '1541267820922482';
const LINK_SYSTEM_USERS = `https://business.facebook.com/settings/system-users?business_id=${META_BUSINESS_ID}`;

/** As permissões que ESTE sistema usa. Faltando qualquer uma, algo cala. */
const PERMISSOES = [
  { nome: 'instagram_basic', uso: 'ler o feed que aparece na home do site' },
  { nome: 'pages_show_list', uso: 'enxergar a página ligada ao @lurdsplussize' },
  { nome: 'pages_read_engagement', uso: 'ler comentário dos posts' },
  { nome: 'instagram_manage_comments', uso: 'a Lú responder comentário na live' },
  { nome: 'instagram_manage_messages', uso: 'mandar e receber DM' },
  { nome: 'pages_messaging', uso: 'entregar a DM pelo lado da página' },
];

export default function IntegracoesPage() {
  const [status, setStatus] = useState<StatusToken | null>(null);
  /**
   * `null` do backend é ambíguo: pode ser "integração sem token" ou "o vigia
   * ainda não rodou nenhuma vez". Guardar de ONDE veio a leitura desfaz a
   * ambiguidade sem inventar um estado que o backend não devolve.
   */
  const [origem, setOrigem] = useState<'cache' | 'agora' | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [testando, setTestando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = async (agora: boolean) => {
    agora ? setTestando(true) : setCarregando(true);
    setErro(null);
    try {
      const r = await api<StatusToken | null>(`/lives/meta/token${agora ? '?agora=1' : ''}`);
      setStatus(r ?? null);
      setOrigem(agora ? 'agora' : 'cache');
    } catch (e: any) {
      setErro(e?.message || 'falhou');
    } finally {
      setCarregando(false);
      setTestando(false);
    }
  };

  useEffect(() => {
    carregar(false);
  }, []);

  /**
   * Fuso explícito. Data renderizada com o fuso do navegador já mostrou hora
   * errada em tela de PDV; aqui a diferença decidiria se o token vence hoje ou
   * amanhã.
   */
  const dataBR = (iso?: string | null) =>
    iso
      ? new Date(iso).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const semToken = origem === 'agora' && status === null;
  const nuncaChecado = origem === 'cache' && status === null;
  const quebrado = !!status && !status.valido;
  const vencendo = !!status && status.valido && status.diasRestantes !== null;
  const permanente = !!status && status.valido && status.expiraEm === null;

  return (
    <main className="min-h-screen bg-stone-100">
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/retaguarda"
            className="p-1.5 rounded-lg text-stone-500 hover:bg-stone-100"
            aria-label="Voltar"
          >
            <ChevronLeft size={18} />
          </Link>
          <div className="min-w-0">
            <div className="text-xs text-stone-500">FlowOps · Sistema</div>
            <h1 className="text-lg font-bold text-stone-900 flex items-center gap-2">
              <Plug size={18} className="text-stone-500" />
              Saúde das Integrações
            </h1>
          </div>
        </div>
        <button
          onClick={() => carregar(false)}
          disabled={carregando}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-stone-100 text-stone-700 hover:bg-stone-200 disabled:opacity-50"
        >
          {carregando ? 'Carregando…' : 'Atualizar'}
        </button>
      </header>

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {erro && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-4 text-sm">
            <div className="font-bold mb-1">Não consegui falar com o backend</div>
            {erro}
          </div>
        )}

        {/* ─────────────── META / INSTAGRAM ─────────────── */}
        <section className="bg-white rounded-2xl shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Instagram size={20} className="text-rose-500" />
              <div>
                <h2 className="font-bold text-stone-900">Meta · Instagram @lurdsplussize</h2>
                <div className="text-xs text-stone-500">
                  Vitrine da home do site · comentários e DM da live
                </div>
              </div>
            </div>
            <button
              onClick={() => carregar(true)}
              disabled={testando}
              className="px-3 py-1.5 rounded-lg text-sm font-bold bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
            >
              <RefreshCw size={14} className={testando ? 'animate-spin' : ''} />
              {testando ? 'Perguntando à Meta…' : 'Testar agora'}
            </button>
          </div>

          <div className="p-6 space-y-4">
            {carregando ? (
              <div className="text-sm text-stone-500">Carregando…</div>
            ) : (
              <>
                {/* Faixa de estado — a primeira linha responde a pergunta. */}
                {permanente && (
                  <Faixa tom="ok" icone={<CheckCircle2 size={18} />} titulo="Conectado, sem data pra vencer">
                    Token de Usuário do Sistema — é o estado que a gente quer. A vitrine da
                    home mostra os posts reais e a live responde comentário e DM.
                  </Faixa>
                )}
                {vencendo && (
                  <Faixa
                    tom={(status!.diasRestantes ?? 99) <= 7 ? 'alerta' : 'ok'}
                    icone={(status!.diasRestantes ?? 99) <= 7 ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                    titulo={`Válido, vence em ${status!.diasRestantes} dia(s)`}
                  >
                    Este token TEM data pra morrer. Quando chegar o dia, a vitrine cai pra
                    grade estática e a live para de responder — sem erro em tela nenhuma.
                    Trocar por um de Usuário do Sistema resolve de vez.
                  </Faixa>
                )}
                {quebrado && (
                  <Faixa tom="erro" icone={<AlertTriangle size={18} />} titulo="Instagram desconectado">
                    O token não vale mais{status!.motivo ? ` — ${status!.motivo}` : ''}.
                    <strong className="block mt-1">
                      Agora mesmo: a home do site está com a grade de fotos estática, e a
                      live não responde comentário nem manda DM.
                    </strong>
                  </Faixa>
                )}
                {semToken && (
                  <Faixa tom="neutro" icone={<AlertTriangle size={18} />} titulo="Integração não configurada">
                    Não existe <code>META_PAGE_ACCESS_TOKEN</code> no ambiente. Isso é
                    diferente de token vencido: nunca foi ligada.
                  </Faixa>
                )}
                {nuncaChecado && (
                  <Faixa tom="neutro" icone={<AlertTriangle size={18} />} titulo="Sem leitura gravada">
                    O vigia das 9h ainda não rodou (ou o token não está configurado).
                    Clique em <strong>Testar agora</strong> pra perguntar à Meta.
                  </Faixa>
                )}

                {status && (
                  <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2">
                    <Campo rotulo="Situação" valor={status.valido ? 'Válido' : 'Inválido'} />
                    <Campo
                      rotulo="Vence em"
                      valor={status.expiraEm ? dataBR(status.expiraEm) : 'Não expira'}
                    />
                    <Campo rotulo="Dias restantes" valor={status.diasRestantes?.toString() ?? '—'} />
                    <Campo
                      rotulo={origem === 'agora' ? 'Conferido agora' : 'Última conferência'}
                      valor={dataBR(status.verificadoEm)}
                    />
                  </dl>
                )}
              </>
            )}
          </div>

          {/* ── O CONSERTO — mora no destino do alarme, não num documento ── */}
          {(quebrado || semToken || vencendo) && (
            <div className="border-t border-stone-200 bg-stone-50 p-6">
              <h3 className="font-bold text-stone-900 mb-1">Como gerar um token que não vence</h3>
              <p className="text-sm text-stone-600 mb-4">
                Só o token de <strong>Usuário do Sistema</strong> vem sem data de validade.
                O do <em>Graph API Explorer</em> dura horas — foi ele que venceu no mesmo
                dia em 10/08 e fez o conserto parecer que não funcionou.
              </p>

              <a
                href={LINK_SYSTEM_USERS}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700"
              >
                <ExternalLink size={16} />
                Abrir Usuários do Sistema no Business Manager
              </a>

              <ol className="mt-5 space-y-2 text-sm text-stone-700 list-decimal pl-5">
                <li>Criar (ou abrir) um usuário do sistema com função <strong>Admin</strong>.</li>
                <li>
                  <strong>Adicionar ativos</strong> → marcar a conta do Instagram
                  <code className="mx-1">@lurdsplussize</code> e a Página da loja, com
                  controle total.
                </li>
                <li>
                  <strong>Gerar novo token</strong> → escolher o app
                  <code className="mx-1">{META_APP_ID}</code> → expiração{' '}
                  <strong>Nunca</strong>.
                </li>
                <li>Marcar as permissões da lista abaixo.</li>
                <li>
                  Colar em <code>META_PAGE_ACCESS_TOKEN</code> no Railway (serviço{' '}
                  <code>flowops-lite</code>) e voltar aqui em <strong>Testar agora</strong>:
                  tem que aparecer <strong>Não expira</strong>.
                </li>
              </ol>

              <div className="mt-5">
                <div className="text-xs font-bold text-stone-500 uppercase tracking-wider mb-2">
                  Permissões — o que cada uma segura
                </div>
                <ul className="grid sm:grid-cols-2 gap-2">
                  {PERMISSOES.map((p) => (
                    <li
                      key={p.nome}
                      className="text-xs bg-white border border-stone-200 rounded-lg px-3 py-2"
                    >
                      <code className="font-bold text-stone-900">{p.nome}</code>
                      <div className="text-stone-500 mt-0.5">{p.uso}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>

        {/* ─────────────── DEMAIS INTEGRAÇÕES ─────────────── */}
        <section className="bg-white rounded-2xl shadow p-6">
          <h2 className="font-bold text-sm text-stone-500 uppercase tracking-wider mb-4">
            Outras integrações
          </h2>
          {/* Sem status inventado: cada uma tem a própria tela de configuração,
              e link honesto é melhor que bolinha verde que ninguém mediu. */}
          <div className="grid sm:grid-cols-2 gap-3">
            <Atalho href="/retaguarda/pagarme-config" icone={<CreditCard size={16} />} titulo="Pagar.me" desc="Cartão e PIX do site" />
            <Atalho href="/retaguarda/pagbank-config" icone={<CreditCard size={16} />} titulo="PagBank" desc="PIX da live" />
            <Atalho href="/retaguarda/correios" icone={<Truck size={16} />} titulo="Correios" desc="Cotação de frete e etiqueta" />
            <Atalho href="/retaguarda/whatsapp" icone={<MessageCircle size={16} />} titulo="WhatsApp" desc="Disparos e atendimento" />
          </div>
        </section>
      </div>
    </main>
  );
}

function Faixa({
  tom,
  icone,
  titulo,
  children,
}: {
  tom: 'ok' | 'alerta' | 'erro' | 'neutro';
  icone: React.ReactNode;
  titulo: string;
  children: React.ReactNode;
}) {
  // Classes completas por tom — Tailwind não enxerga string concatenada.
  const cor = {
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    alerta: 'bg-amber-50 border-amber-200 text-amber-900',
    erro: 'bg-red-50 border-red-200 text-red-900',
    neutro: 'bg-stone-50 border-stone-200 text-stone-700',
  }[tom];
  return (
    <div className={`border rounded-xl p-4 flex gap-3 ${cor}`}>
      <div className="shrink-0 mt-0.5">{icone}</div>
      <div className="text-sm">
        <div className="font-bold mb-0.5">{titulo}</div>
        {children}
      </div>
    </div>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-stone-500">{rotulo}</dt>
      <dd className="text-sm font-bold text-stone-900 mt-0.5">{valor}</dd>
    </div>
  );
}

function Atalho({
  href,
  icone,
  titulo,
  desc,
}: {
  href: string;
  icone: React.ReactNode;
  titulo: string;
  desc: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 p-3 rounded-xl border border-stone-200 hover:border-stone-300 hover:bg-stone-50"
    >
      <span className="text-stone-500">{icone}</span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-stone-900">{titulo}</span>
        <span className="block text-xs text-stone-500">{desc}</span>
      </span>
    </Link>
  );
}
