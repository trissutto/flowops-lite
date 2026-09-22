'use client';

/**
 * CARTÃO DA LIVE PELO PAGBANK (22/09/2026) — o formulário que mora na própria
 * página de fechamento (`/pagar/<carrinho>`).
 *
 * Até 21/09 o botão "Cartão até 12x" gerava um link do checkout da Pagar.me —
 * e a conta teve o checkout desligado (todo link voltava 412): a cliente da
 * live ficou sem cartão. Agora o cartão é cobrado AQUI, pela mesma API de
 * cartão do site e do link do PDV:
 *
 *  - o número, a validade e o CVV são CRIPTOGRAFADOS neste navegador pelo SDK
 *    oficial do PagBank (chave pública da conta) — só o blob sai daqui (PCI);
 *  - nome, CPF, celular e endereço da cliente o carrinho já tem (a página não
 *    deixa chegar aqui sem eles); do cartão, só o titular;
 *  - aprovado → a página vira "Pagamento confirmado" e a separação sai sozinha;
 *    em análise → o servidor fecha quando o banco responder.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  carregarSdkPagbank,
  cartaoValido,
  cpfOk,
  criptografarCartaoPagbank,
  emailOk,
  mascaraCartao,
  mascaraCpf,
  mascaraValidade,
  soDigitos,
  validadeOk,
} from '@/lib/pagbank-cartao';

type Info = {
  habilitado: boolean;
  publicKey: string | null;
  maxParcelas: number;
  tentativasRestantes: number;
  emAnalise: boolean;
  precisaEmail: boolean;
  totalCents: number;
  motivo?: string;
};

function brl(cents: number): string {
  return ((cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** A mensagem que o backend mandou (Nest: `{ message }`) — nunca o "400:" cru. */
function msgDoErro(e: any, padrao: string): string {
  const corpo = e?.body?.message;
  if (typeof corpo === 'string' && corpo.trim()) return corpo;
  if (Array.isArray(corpo) && corpo.length) return String(corpo[0]);
  return padrao;
}

const inputCls =
  'w-full box-border px-3.5 py-3 text-base rounded-xl bg-[#FCFBF7] border-[1.5px] border-[#E4DDCB] outline-none focus:border-[#B8912B] focus:ring-2 focus:ring-[#EBD9A6]';

export default function CartaoLive({
  cartId,
  totalCents,
  onPago,
}: {
  cartId: string;
  /** O total que a página mostra (subtotal + frete) — é o que o servidor cobra. */
  totalCents: number;
  onPago: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [erroInfo, setErroInfo] = useState<string | null>(null);

  const [numero, setNumero] = useState('');
  const [nome, setNome] = useState('');
  const [validade, setValidade] = useState('');
  const [cvv, setCvv] = useState('');
  const [cpf, setCpf] = useState('');
  const [email, setEmail] = useState('');
  const [parcelas, setParcelas] = useState('1');
  const [tentouEnviar, setTentouEnviar] = useState(false);
  const [pagando, setPagando] = useState(false);
  const [retorno, setRetorno] = useState<{ tipo: 'recusado' | 'erro' | 'analise'; msg: string } | null>(null);

  const carregarInfo = useCallback(async () => {
    try {
      const r = await api<Info>(`/public/live-pay/${encodeURIComponent(cartId)}/cartao`);
      setInfo(r);
      setErroInfo(null);
    } catch (e: any) {
      setErroInfo(msgDoErro(e, 'Não consegui abrir o pagamento com cartão agora. Tenta de novo em instantes 💜'));
    }
  }, [cartId]);

  useEffect(() => {
    void carregarInfo();
  }, [carregarInfo]);

  // Baixa o SDK assim que o formulário aparece — a cliente digita enquanto carrega.
  useEffect(() => {
    if (info?.habilitado) void carregarSdkPagbank().catch(() => {});
  }, [info?.habilitado]);

  const erros = {
    numero: !cartaoValido(numero) ? 'Confira o número do cartão.' : '',
    nome: nome.trim().length < 3 ? 'Digite o nome como está no cartão.' : '',
    validade: !validadeOk(validade) ? 'Validade inválida (MM/AA).' : '',
    cvv: !/^\d{3,4}$/.test(cvv) ? 'CVV de 3 ou 4 dígitos.' : '',
    cpf: !cpfOk(cpf) ? 'Confira o CPF do titular do cartão.' : '',
    email: info?.precisaEmail && !emailOk(email) ? 'Digite um e-mail válido.' : '',
  };
  const temErro = Object.values(erros).some(Boolean);
  const erroVisivel = (k: keyof typeof erros) => (tentouEnviar ? erros[k] : '');

  const maxParc = Math.max(1, Math.min(12, info?.maxParcelas || 1));
  const opcoesParcelas = Array.from({ length: maxParc }, (_, i) => {
    const n = i + 1;
    return { v: String(n), txt: n === 1 ? `À vista · ${brl(totalCents)}` : `${n}x de ${brl(Math.round(totalCents / n))} sem juros` };
  });

  const pagar = async () => {
    setTentouEnviar(true);
    if (temErro || pagando || !info?.publicKey) return;
    setPagando(true);
    setRetorno(null);
    try {
      let cardEncrypted = '';
      try {
        cardEncrypted = await criptografarCartaoPagbank({
          publicKey: info.publicKey,
          holder: nome,
          number: numero,
          expiry: validade,
          cvv,
        });
      } catch (e) {
        // Log SEM dado do cartão — só o motivo técnico.
        console.error('[live-cartao] criptografia do cartão falhou:', e instanceof Error ? e.message : e);
        setRetorno({ tipo: 'erro', msg: 'Não conseguimos validar esse cartão. Confira os dados e tente de novo — ou pague com PIX. 💜' });
        return;
      }
      const r = await api<{ resultado: 'pago' | 'analise' | 'recusado' | 'erro'; mensagem: string }>(
        `/public/live-pay/${encodeURIComponent(cartId)}/cartao`,
        {
          method: 'POST',
          body: JSON.stringify({
            cardEncrypted,
            holderName: nome.trim(),
            holderCpf: soDigitos(cpf),
            installments: Number(parcelas) || 1,
            ...(info.precisaEmail ? { email: email.trim() } : {}),
          }),
        },
      );
      if (r.resultado === 'pago') {
        // O cartão não fica na tela depois de pago.
        setNumero('');
        setCvv('');
        setValidade('');
        onPago();
        return;
      }
      setCvv('');
      setRetorno({ tipo: r.resultado === 'analise' ? 'analise' : r.resultado, msg: r.mensagem });
      void carregarInfo();
    } catch (e: any) {
      setRetorno({ tipo: 'erro', msg: msgDoErro(e, 'Não conseguimos concluir agora. Tente de novo em instantes ou pague com PIX. 💜') });
      void carregarInfo();
    } finally {
      setPagando(false);
    }
  };

  const caixa = 'rounded-2xl border-2 border-[#ECD9A0] bg-[#FBF6E6]/60 p-4 mb-3';

  if (erroInfo) {
    return <div className="bg-[#FDECEC] border border-[#F3C0C0] text-[#9B2C2C] rounded-lg px-3 py-2.5 text-sm mb-3">{erroInfo}</div>;
  }
  if (!info) {
    return <div className={`${caixa} text-center text-sm text-[#8C7325]`}>Abrindo o pagamento com cartão…</div>;
  }
  if (info.emAnalise || retorno?.tipo === 'analise') {
    return (
      <div className={`${caixa} text-center`}>
        <div className="text-sm font-bold text-[#8C7325] mb-1">Cartão em análise no banco ⏳</div>
        <div className="text-[13px] text-[#7A7264]">
          Assim que o banco responder, esta tela confirma sozinha — não precisa pagar de novo. 💜
        </div>
      </div>
    );
  }
  if (!info.habilitado) {
    return (
      <div className="bg-[#FDECEC] border border-[#F3C0C0] text-[#9B2C2C] rounded-lg px-3 py-2.5 text-sm mb-3">
        {info.motivo === 'tentativas'
          ? 'Esta compra já teve muitas tentativas no cartão. Pague com PIX ou fale com a loja 💜'
          : info.motivo === 'pago'
            ? 'Esta compra já está paga 💜'
            : 'O pagamento com cartão está indisponível agora. Pague com PIX ou tente de novo em alguns minutos 💜'}
      </div>
    );
  }

  return (
    <div className={caixa}>
      <div className="text-sm font-bold text-[#8C7325] mb-2 text-center">Cartão até {maxParc}x sem juros — {brl(totalCents)}</div>
      <div className="space-y-2 text-left">
        <div>
          <input
            className={inputCls}
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="Número do cartão"
            aria-label="Número do cartão"
            value={numero}
            onChange={(e) => setNumero(mascaraCartao(e.target.value))}
          />
          <Erro msg={erroVisivel('numero')} />
        </div>
        <div>
          <input
            className={inputCls}
            autoComplete="cc-name"
            placeholder="Nome impresso no cartão"
            aria-label="Nome impresso no cartão"
            value={nome}
            onChange={(e) => setNome(e.target.value.toUpperCase())}
          />
          <Erro msg={erroVisivel('nome')} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <input
              className={inputCls}
              inputMode="numeric"
              autoComplete="cc-exp"
              placeholder="MM/AA"
              aria-label="Validade do cartão"
              value={validade}
              onChange={(e) => setValidade(mascaraValidade(e.target.value))}
            />
            <Erro msg={erroVisivel('validade')} />
          </div>
          <div>
            <input
              className={inputCls}
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder="CVV"
              aria-label="Código de segurança (CVV)"
              maxLength={4}
              value={cvv}
              onChange={(e) => setCvv(soDigitos(e.target.value).slice(0, 4))}
            />
            <Erro msg={erroVisivel('cvv')} />
          </div>
        </div>
        <div>
          <input
            className={inputCls}
            inputMode="numeric"
            placeholder="CPF do titular do cartão"
            aria-label="CPF do titular do cartão"
            value={cpf}
            onChange={(e) => setCpf(mascaraCpf(e.target.value))}
          />
          <Erro msg={erroVisivel('cpf')} />
        </div>
        {info.precisaEmail && (
          <div>
            <input
              className={inputCls}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="Seu e-mail (pra confirmação)"
              aria-label="Seu e-mail"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Erro msg={erroVisivel('email')} />
          </div>
        )}
        <select
          className={`${inputCls} appearance-auto`}
          aria-label="Parcelas"
          value={parcelas}
          onChange={(e) => setParcelas(e.target.value)}
        >
          {opcoesParcelas.map((o) => (
            <option key={o.v} value={o.v}>
              {o.txt}
            </option>
          ))}
        </select>
      </div>

      {retorno && (
        <div className="bg-[#FDECEC] border border-[#F3C0C0] text-[#9B2C2C] rounded-lg px-3 py-2.5 text-sm mt-3">
          {retorno.msg}
          {info.tentativasRestantes > 0 && info.tentativasRestantes <= 2 && (
            <span className="block mt-1 text-[12px]">
              Resta{info.tentativasRestantes === 1 ? '' : 'm'} {info.tentativasRestantes} tentativa
              {info.tentativasRestantes === 1 ? '' : 's'} no cartão.
            </span>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void pagar()}
        disabled={pagando}
        className="mt-3 w-full py-3.5 text-[16px] font-extrabold text-white rounded-xl disabled:opacity-60 transition-colors"
        style={{ background: '#2E7D46' }}
      >
        {pagando ? 'Processando…' : `Pagar ${brl(totalCents)} no cartão`}
      </button>
      <p className="mt-2 text-center text-[11px] text-[#A08A4E]">
        🔒 Pagamento processado pelo PagBank. Os dados do cartão são criptografados no seu celular e não ficam com a loja.
      </p>
    </div>
  );
}

function Erro({ msg }: { msg: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-[12px] text-[#B3261E]">{msg}</p>;
}
