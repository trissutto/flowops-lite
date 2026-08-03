'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * ENTRAR / CRIAR CONTA / ESQUECI A SENHA — as três num lugar só.
 *
 * A chave é o CPF, não o e-mail: é assim que a cliente já é identificada na
 * loja física e no crediário, e é o que permite o pedido do site cair na
 * MESMA pessoa do CRM. Ver [[clientes-pessoa-vs-cadastro]].
 *
 * A recuperação de senha manda código no WhatsApp (fluxo do app), então não
 * depende de a cliente ter e-mail cadastrado — boa parte não tem.
 */

type Modo = 'entrar' | 'criar' | 'esqueci';

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

export function AcessoConta({ voltarPara = '/conta' }: { voltarPara?: string }) {
  const router = useRouter();
  const [modo, setModo] = useState<Modo>('entrar');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [cpf, setCpf] = useState('');
  const [senha, setSenha] = useState('');
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [email, setEmail] = useState('');
  const [codigo, setCodigo] = useState('');

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    setAviso(null);
    try {
      if (modo === 'esqueci') {
        const r = await fetch('/api/conta/senha', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cpf: soDigitos(cpf),
            ...(codigo ? { codigo, novaSenha: senha } : {}),
          }),
        });
        const dados = await r.json();
        if (!r.ok) throw new Error(dados?.erro || 'Não consegui concluir.');
        if (dados.etapa === 'codigo-enviado') {
          setAviso('Enviamos um código no seu WhatsApp. Digite ele e escolha a senha nova.');
        } else {
          setAviso('Senha trocada! Pode entrar.');
          setModo('entrar');
          setCodigo('');
        }
        return;
      }

      const r = await fetch('/api/conta/sessao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acao: modo === 'criar' ? 'cadastro' : 'login',
          cpf: soDigitos(cpf),
          senha,
          nome,
          telefone: soDigitos(telefone),
          email,
        }),
      });
      const dados = await r.json();
      if (!r.ok) throw new Error(dados?.erro || 'Não consegui entrar.');
      router.push(voltarPara);
      router.refresh();
    } catch (e: unknown) {
      setErro(e instanceof Error ? e.message : 'Algo deu errado. Tente de novo.');
    } finally {
      setEnviando(false);
    }
  }

  const campo =
    'w-full rounded-sm border border-border bg-background px-3 py-3 text-body outline-none focus:border-primary';
  const rotulo = 'eyebrow mb-1 block text-[0.625rem] text-muted';

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
            onClick={() => { setModo(id); setErro(null); setAviso(null); }}
            className={`-mb-px border-b-2 pb-3 text-small transition-colors ${
              modo === id ? 'border-primary text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {texto}
          </button>
        ))}
      </div>

      <form onSubmit={enviar} className="space-y-4">
        <div>
          <label className={rotulo} htmlFor="cpf">CPF</label>
          <input
            id="cpf" className={campo} inputMode="numeric" autoComplete="username"
            value={mascaraCpf(cpf)} onChange={(e) => setCpf(e.target.value)}
            placeholder="000.000.000-00" required
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
              <label className={rotulo} htmlFor="email">E-mail <span className="text-muted">(opcional)</span></label>
              <input id="email" type="email" className={campo} value={email} autoComplete="email"
                onChange={(e) => setEmail(e.target.value)} />
            </div>
          </>
        )}

        {modo === 'esqueci' && aviso && (
          <div>
            <label className={rotulo} htmlFor="codigo">Código do WhatsApp</label>
            <input id="codigo" className={campo} inputMode="numeric" value={codigo}
              onChange={(e) => setCodigo(e.target.value)} />
          </div>
        )}

        {(modo !== 'esqueci' || !!codigo || !!aviso) && (
          <div>
            <label className={rotulo} htmlFor="senha">
              {modo === 'esqueci' ? 'Senha nova' : 'Senha'}
            </label>
            <input
              id="senha" type="password" className={campo} value={senha}
              autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'}
              onChange={(e) => setSenha(e.target.value)}
              required={modo !== 'esqueci' || !!codigo} minLength={4}
            />
          </div>
        )}

        {erro && <p className="text-small text-[#B3261E]">{erro}</p>}
        {aviso && <p className="text-small text-muted">{aviso}</p>}

        <Button type="submit" disabled={enviando} className="w-full">
          {enviando && <Loader2 className="mr-2 size-4 animate-spin" />}
          {modo === 'entrar' ? 'Entrar' : modo === 'criar' ? 'Criar minha conta' : 'Continuar'}
        </Button>

        <button
          type="button"
          onClick={() => {
            setModo(modo === 'esqueci' ? 'entrar' : 'esqueci');
            setErro(null);
            setAviso(null);
          }}
          className="link-underline mx-auto block text-small text-muted"
        >
          {modo === 'esqueci' ? 'Voltar para entrar' : 'Esqueci minha senha'}
        </button>
      </form>

      <p className="mt-6 text-center text-small text-muted">
        Sua conta é a mesma da loja física: pedidos, cashback e trocas no mesmo lugar.
      </p>
    </div>
  );
}
