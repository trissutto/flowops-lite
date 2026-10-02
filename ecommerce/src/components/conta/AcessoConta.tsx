'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { linkWhatsapp } from '@/data/contato';

/**
 * ENTRAR / CRIAR CONTA / ESQUECI A SENHA — as três num lugar só.
 *
 * A chave é o CPF, não o e-mail: é assim que a cliente já é identificada na
 * loja física e no crediário, e é o que permite o pedido do site cair na
 * MESMA pessoa do CRM. Ver [[clientes-pessoa-vs-cadastro]].
 *
 * A recuperação de senha manda o código no WhatsApp E no e-mail do cadastro.
 *
 * ── O "ESQUECI" ERA UM BECO SEM SAÍDA (02/10/2026) ──
 *
 * Três armadilhas, todas vistas no mesmo atendimento:
 *   · o campo do código só existia enquanto o aviso "enviamos" estava na
 *     tela — e todo envio limpava o aviso. Errou uma vez (código, senha
 *     curta), o campo SUMIA com o código errado dentro, e não havia como
 *     corrigir nem pedir outro sem recarregar a página;
 *   · a tela dizia "enviamos" sem dizer PRA ONDE. A conta herda o telefone do
 *     cadastro da loja, que pode ser um número antigo — agora o final do
 *     número e o e-mail aparecem, e há saída pro atendimento;
 *   · CPF sem conta ouvia "senha não confere" e depois "enviamos um código".
 *     Agora ouve que não tem conta, com o botão de criar ali mesmo.
 *
 * A etapa do código é um estado próprio (`codigoPedido`), não um efeito
 * colateral do aviso.
 */

type Modo = 'entrar' | 'criar' | 'esqueci';
type Saida = 'criar' | 'entrar' | 'atendimento' | null;

const LINK_AJUDA = linkWhatsapp('Olá! Vim pelo site. Não estou conseguindo entrar na minha conta.');

function soDigitos(v: string) {
  return v.replace(/\D/g, '');
}

function mascaraCpf(v: string) {
  const d = soDigitos(v).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

function mascaraTelefone(v: string) {
  const d = soDigitos(v).slice(0, 11);
  if (d.length <= 10) return d.replace(/^(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3').trim();
  return d.replace(/^(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3').trim();
}

/** "pra onde foi" em frase de gente, a partir do que o backend mascarou. */
function destinoDoCodigo(whatsapp?: string | null, email?: string | null): string {
  const final = soDigitos(String(whatsapp || '')).slice(-4);
  const zap = final ? `o WhatsApp de final ${final}` : '';
  const mail = email ? `o e-mail ${email}` : '';
  if (zap && mail) return `${zap} e ${mail}`;
  return zap || mail || 'o contato do seu cadastro';
}

export function AcessoConta({ voltarPara = '/conta' }: { voltarPara?: string }) {
  const router = useRouter();
  const [modo, setModo] = useState<Modo>('entrar');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** O que a cliente pode fazer a seguir quando o erro tem saída. */
  const [saida, setSaida] = useState<Saida>(null);

  const [cpf, setCpf] = useState('');
  const [senha, setSenha] = useState('');
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [email, setEmail] = useState('');
  const [codigo, setCodigo] = useState('');
  /** Etapa 2 do "esqueci": o código já foi pedido e os campos ficam na tela. */
  const [codigoPedido, setCodigoPedido] = useState(false);

  function trocarModo(novo: Modo) {
    // Senha digitada num modo não acompanha pro outro: a senha ERRADA do
    // "entrar" não pode aparecer preenchida como "senha nova".
    if ((novo === 'esqueci') !== (modo === 'esqueci')) setSenha('');
    setModo(novo);
    setErro(null);
    setAviso(null);
    setSaida(null);
    setCodigo('');
    setCodigoPedido(false);
  }

  function saidaDoMotivo(motivo: unknown): Saida {
    if (motivo === 'sem_conta') return 'criar';
    if (motivo === 'ja_tem_conta') return 'entrar';
    if (motivo === 'sem_contato' || motivo === 'falha_envio') return 'atendimento';
    return null;
  }

  async function pedirCodigo() {
    const r = await fetch('/api/conta/senha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf: soDigitos(cpf) }),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      setSaida(saidaDoMotivo(dados?.motivo));
      throw new Error(dados?.erro || 'Não consegui enviar o código agora.');
    }
    const destino = destinoDoCodigo(dados?.whatsapp, dados?.email);
    setCodigoPedido(true);
    setAviso(
      dados?.aguarde
        ? `Já enviamos um código há menos de um minuto — ele continua valendo. Confira ${destino}.`
        : `Enviamos um código de 6 números para ${destino}. Digite ele e escolha a senha nova.`,
    );
  }

  async function entrarOuCriar(acao: 'login' | 'cadastro') {
    const r = await fetch('/api/conta/sessao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acao,
        cpf: soDigitos(cpf),
        senha,
        nome,
        telefone: soDigitos(telefone),
        email,
      }),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      setSaida(saidaDoMotivo(dados?.motivo));
      throw new Error(dados?.erro || 'Não consegui entrar.');
    }
    router.push(voltarPara);
    router.refresh();
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    setSaida(null);
    try {
      if (modo !== 'esqueci') {
        setAviso(null);
        await entrarOuCriar(modo === 'criar' ? 'cadastro' : 'login');
        return;
      }

      if (!codigoPedido) {
        setAviso(null);
        await pedirCodigo();
        return;
      }

      const r = await fetch('/api/conta/senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf: soDigitos(cpf), codigo: soDigitos(codigo), novaSenha: senha }),
      });
      const dados = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(dados?.erro || 'Não consegui trocar a senha.');

      // Senha trocada: entra direto, sem fazer a cliente digitar tudo de novo.
      setCodigo('');
      setCodigoPedido(false);
      setModo('entrar');
      setAviso('Senha trocada! Entrando na sua conta…');
      try {
        await entrarOuCriar('login');
      } catch {
        setSaida(null);
        setAviso('Senha trocada! Agora é só entrar com ela.');
      }
    } catch (e: unknown) {
      setErro(e instanceof Error ? e.message : 'Algo deu errado. Tente de novo.');
    } finally {
      setEnviando(false);
    }
  }

  async function reenviarCodigo() {
    setEnviando(true);
    setErro(null);
    setSaida(null);
    setCodigo('');
    try {
      await pedirCodigo();
    } catch (e: unknown) {
      setErro(e instanceof Error ? e.message : 'Não consegui enviar o código agora.');
    } finally {
      setEnviando(false);
    }
  }

  const campo =
    'w-full rounded-sm border border-border bg-background px-3 py-3 text-body outline-none focus:border-primary';
  const rotulo = 'eyebrow mb-1 block text-[0.625rem] text-ink-muted';
  const acaoTexto = 'link-underline text-small text-ink';
  const naEtapaDoCodigo = modo === 'esqueci' && codigoPedido;

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-6 flex gap-6 border-b border-border">
        {([
          ['entrar', 'Entrar'],
          ['criar', 'Criar conta'],
        ] as const).map(([id, texto]) => (
          <button
            key={id}
            type="button"
            onClick={() => trocarModo(id)}
            className={`-mb-px border-b-2 pb-3 text-small transition-colors ${
              modo === id ? 'border-primary text-ink' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {texto}
          </button>
        ))}
      </div>

      <form onSubmit={enviar} className="space-y-4">
        {modo === 'esqueci' && !codigoPedido && (
          <p className="text-small text-ink-muted">
            Informe seu CPF. Enviamos um código para o WhatsApp e o e-mail do seu cadastro.
          </p>
        )}

        {/* Em cima dos campos: é o que diz PRA ONDE o código foi — lido antes de digitar. */}
        {aviso && <p className="text-small text-ink" role="status">{aviso}</p>}

        <div>
          <label className={rotulo} htmlFor="cpf">CPF</label>
          <input
            id="cpf" className={campo} inputMode="numeric" autoComplete="username"
            value={mascaraCpf(cpf)} onChange={(e) => setCpf(e.target.value)}
            placeholder="000.000.000-00" required readOnly={naEtapaDoCodigo}
          />
        </div>

        {modo === 'criar' && (
          <>
            <div>
              <label className={rotulo} htmlFor="nome">Nome completo</label>
              <input id="nome" className={campo} value={nome} autoComplete="name"
                onChange={(e) => setNome(e.target.value)} required minLength={3} />
            </div>
            <div>
              <label className={rotulo} htmlFor="tel">WhatsApp</label>
              <input
                id="tel" className={campo} inputMode="tel" autoComplete="tel"
                value={mascaraTelefone(telefone)} onChange={(e) => setTelefone(e.target.value)}
                placeholder="(11) 90000-0000" required
              />
            </div>
            <div>
              <label className={rotulo} htmlFor="email">E-mail <span className="text-ink-muted">(opcional)</span></label>
              <input id="email" type="email" className={campo} value={email} autoComplete="email"
                onChange={(e) => setEmail(e.target.value)} />
            </div>
          </>
        )}

        {naEtapaDoCodigo && (
          <div>
            <label className={rotulo} htmlFor="codigo">Código de 6 números</label>
            <input
              id="codigo" className={campo} inputMode="numeric" autoComplete="one-time-code"
              value={codigo} onChange={(e) => setCodigo(soDigitos(e.target.value).slice(0, 6))}
              placeholder="000000" required
            />
          </div>
        )}

        {(modo !== 'esqueci' || codigoPedido) && (
          <div>
            <label className={rotulo} htmlFor="senha">
              {modo === 'esqueci' ? 'Senha nova' : 'Senha'}
            </label>
            <input
              id="senha" type="password" className={campo} value={senha}
              autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'}
              onChange={(e) => setSenha(e.target.value)}
              required minLength={4}
            />
            {modo !== 'entrar' && (
              <p className="mt-1 text-[0.6875rem] text-ink-muted">Ao menos 4 dígitos.</p>
            )}
          </div>
        )}

        {erro && (
          <div role="alert">
            <p className="text-small text-[#B3261E]">{erro}</p>
            {saida === 'criar' && (
              <button type="button" className={`${acaoTexto} mt-1`} onClick={() => trocarModo('criar')}>
                Criar minha conta
              </button>
            )}
            {saida === 'entrar' && (
              <span className="mt-1 flex gap-4">
                <button type="button" className={acaoTexto} onClick={() => trocarModo('entrar')}>
                  Entrar
                </button>
                <button type="button" className={acaoTexto} onClick={() => trocarModo('esqueci')}>
                  Esqueci minha senha
                </button>
              </span>
            )}
            {saida === 'atendimento' && (
              <a className={`${acaoTexto} mt-1 inline-block`} href={LINK_AJUDA} target="_blank" rel="noopener noreferrer">
                Falar com a gente no WhatsApp
              </a>
            )}
          </div>
        )}

        <Button type="submit" disabled={enviando} className="w-full">
          {enviando && <Loader2 className="mr-2 size-4 animate-spin" />}
          {modo === 'entrar'
            ? 'Entrar'
            : modo === 'criar'
              ? 'Criar minha conta'
              : codigoPedido
                ? 'Trocar a senha'
                : 'Enviar o código'}
        </Button>

        {naEtapaDoCodigo && (
          <div className="space-y-2 text-center text-small text-ink-muted">
            <button type="button" className="link-underline" onClick={reenviarCodigo} disabled={enviando}>
              Não recebi — enviar outro código
            </button>
            <p>
              Esse não é mais o seu número?{' '}
              <a className="link-underline text-ink" href={LINK_AJUDA} target="_blank" rel="noopener noreferrer">
                Fale com a gente
              </a>
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={() => trocarModo(modo === 'esqueci' ? 'entrar' : 'esqueci')}
          className="link-underline mx-auto block text-small text-ink-muted"
        >
          {modo === 'esqueci' ? 'Voltar para entrar' : 'Esqueci minha senha'}
        </button>
      </form>

      <p className="mt-6 text-center text-small text-ink-muted">
        Sua conta é a mesma da loja física: pedidos, cashback e trocas no mesmo lugar.
      </p>
    </div>
  );
}
