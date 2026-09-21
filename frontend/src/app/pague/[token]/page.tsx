'use client';

/**
 * /pague/<token> — o LINK DE PAGAMENTO do PDV pelo PagBank (21/09/2026).
 *
 * POR QUE EXISTE: a Pagar.me desligou o checkout da conta (desde 15:17 de
 * 21/09 todo link do PDV voltava "The checkout payment method is not available
 * for this account") e o link pronto do PagBank pede allowlist. O dono decidiu
 * que o link sai pelo PagBank — então a página é NOSSA, e cobra pela mesma
 * API de cartão que o site usa desde 16/09.
 *
 * A cliente escolhe CARTÃO (até 12x sem juros) ou PIX. O cartão é
 * criptografado AQUI pelo SDK oficial do PagBank: número e CVV nunca saem
 * deste navegador (PCI). Quando o pagamento cai, o servidor fecha a venda
 * sozinho — a vendedora não precisa estar olhando.
 *
 * Polling do estado a cada 10s SÓ no nosso backend (Postgres). Nunca consulta
 * o PagBank daqui: polling per-browser no gateway foi o flood que derrubou a
 * live de 01/07.
 *
 * Página PÚBLICA: nada de login, nenhum dado da cliente na resposta.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  carregarSdkPagbank,
  cartaoValido,
  celularOk,
  cpfOk,
  criptografarCartaoPagbank,
  emailOk,
  mascaraCartao,
  mascaraCelular,
  mascaraCpf,
  mascaraValidade,
  soDigitos,
  validadeOk,
} from '@/lib/pagbank-cartao';

const GOLD = '#B8912B';
const GREEN = '#2E7D46';

type Estado = 'aberto' | 'pago' | 'vencido' | 'encerrado' | 'inexistente';
type Resposta = {
  estado: Estado;
  motivo?: string;
  mensagem?: string;
  valor?: number;
  lojaNome?: string;
  lojaWhatsapp?: string | null;
  venceEm?: string;
  pagoEm?: string | null;
  formaPaga?: 'pix' | 'cartao';
  pix?: { qrCodeText: string; qrCodeImageB64: string; expiraEm: string | null } | null;
  cartao?: {
    habilitado: boolean;
    publicKey: string | null;
    maxParcelas: number;
    tentativasRestantes: number;
    emAnalise: boolean;
    precisaEmail: boolean;
    precisaCelular: boolean;
    motivo?: string;
  };
};

function brl(v: number): string {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Mensagem que o backend mandou no erro (Nest: `{ message }`), sem o "400:" na frente. */
function msgDoErro(e: any, padrao: string): string {
  const corpo = e?.body?.message;
  if (typeof corpo === 'string' && corpo.trim()) return corpo;
  if (Array.isArray(corpo) && corpo.length) return String(corpo[0]);
  return padrao;
}

const campo: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1.5px solid #E2DCCB',
  borderRadius: 10,
  padding: '13px 12px',
  fontSize: 16, // 16px: iOS não dá zoom no foco
  outline: 'none',
  background: '#fff',
  color: '#1C1C1C',
};
const rotulo: React.CSSProperties = {
  display: 'block',
  textAlign: 'left',
  fontSize: 13,
  fontWeight: 600,
  color: '#555',
  margin: '12px 0 5px',
};

export default function PagarLinkPage() {
  const params = useParams();
  const token = String((params as any)?.token || '');
  const [r, setR] = useState<Resposta | null>(null);
  const [erro, setErro] = useState('');
  const [aba, setAba] = useState<'cartao' | 'pix'>('cartao');

  // PIX
  const [pix, setPix] = useState<Resposta['pix']>(null);
  const [gerandoPix, setGerandoPix] = useState(false);
  const [erroPix, setErroPix] = useState('');
  const [copiado, setCopiado] = useState(false);

  // Cartão
  const [numero, setNumero] = useState('');
  const [nome, setNome] = useState('');
  const [validade, setValidade] = useState('');
  const [cvv, setCvv] = useState('');
  const [cpf, setCpf] = useState('');
  const [parcelas, setParcelas] = useState('1');
  const [email, setEmail] = useState('');
  const [celular, setCelular] = useState('');
  const [tentouEnviar, setTentouEnviar] = useState(false);
  const [pagando, setPagando] = useState(false);
  const [retornoCartao, setRetornoCartao] = useState<{ tipo: 'recusado' | 'erro' | 'analise'; msg: string } | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vivoRef = useRef(true);

  const consulta = useCallback(async () => {
    if (!token) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      const res = await api<Resposta>(`/public/pague/${encodeURIComponent(token)}`);
      if (!vivoRef.current) return;
      setR(res);
      setErro('');
      if (res.pix) setPix(res.pix);
      // Só continua perguntando enquanto o destino não está decidido.
      if (res.estado === 'aberto') timerRef.current = setTimeout(() => void consulta(), 10_000);
    } catch {
      if (!vivoRef.current) return;
      setErro('Não consegui abrir seu link agora. Tenta de novo em instantes 💜');
      timerRef.current = setTimeout(() => void consulta(), 15_000);
    }
  }, [token]);

  useEffect(() => {
    vivoRef.current = true;
    void consulta();
    return () => {
      vivoRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [consulta]);

  // Cartão indisponível (tentativas esgotadas, em análise, chave fora) → abre no PIX.
  const cartaoPode = !!r?.cartao?.habilitado;
  useEffect(() => {
    if (r?.estado === 'aberto' && r.cartao && !r.cartao.habilitado && !r.cartao.emAnalise) setAba('pix');
  }, [r?.estado, r?.cartao]);

  // Baixa o SDK assim que a aba do cartão aparece — a cliente digita enquanto carrega.
  useEffect(() => {
    if (aba === 'cartao' && cartaoPode) void carregarSdkPagbank().catch(() => {});
  }, [aba, cartaoPode]);

  const gerarPix = async () => {
    if (gerandoPix) return;
    setGerandoPix(true);
    setErroPix('');
    try {
      const novo = await api<NonNullable<Resposta['pix']>>(`/public/pague/${encodeURIComponent(token)}/pix`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setPix(novo);
    } catch (e: any) {
      setErroPix(msgDoErro(e, 'Não consegui gerar o PIX agora. Tenta de novo em instantes 💜'));
      void consulta();
    } finally {
      setGerandoPix(false);
    }
  };

  // Abriu a aba PIX sem código de pé → gera um (idempotente no servidor).
  useEffect(() => {
    if (aba === 'pix' && r?.estado === 'aberto' && !pix && !gerandoPix && !erroPix) void gerarPix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba, r?.estado, pix]);

  const pixVencido = !!pix?.expiraEm && new Date(pix.expiraEm).getTime() < Date.now();

  const copiar = async () => {
    const codigo = pix?.qrCodeText || '';
    if (!codigo) return;
    try {
      await navigator.clipboard.writeText(codigo);
    } catch {
      // Navegador embutido (Instagram etc.) às vezes não tem Clipboard API.
      const ta = document.createElement('textarea');
      ta.value = codigo;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopiado(true);
    setTimeout(() => setCopiado(false), 3000);
  };

  const c = r?.cartao;
  const erros = {
    numero: !cartaoValido(numero) ? 'Confira o número do cartão.' : '',
    nome: nome.trim().length < 3 ? 'Digite o nome como está no cartão.' : '',
    validade: !validadeOk(validade) ? 'Validade inválida (MM/AA).' : '',
    cvv: !/^\d{3,4}$/.test(cvv) ? 'CVV de 3 ou 4 dígitos.' : '',
    cpf: !cpfOk(cpf) ? 'Confira o CPF do titular.' : '',
    email: c?.precisaEmail && !emailOk(email) ? 'Digite um e-mail válido.' : '',
    celular: c?.precisaCelular && !celularOk(celular) ? 'Digite um celular com DDD.' : '',
  };
  const temErro = Object.values(erros).some(Boolean);

  const pagarCartao = async () => {
    setTentouEnviar(true);
    if (temErro || pagando || !c?.publicKey) return;
    setPagando(true);
    setRetornoCartao(null);
    try {
      let cardEncrypted = '';
      try {
        cardEncrypted = await criptografarCartaoPagbank({
          publicKey: c.publicKey,
          holder: nome,
          number: numero,
          expiry: validade,
          cvv,
        });
      } catch (e) {
        // Log SEM dado do cartão — só o motivo técnico.
        console.error('[pagar] criptografia do cartão falhou:', e instanceof Error ? e.message : e);
        setRetornoCartao({
          tipo: 'erro',
          msg: 'Não conseguimos validar esse cartão. Confira os dados e tente de novo — ou pague com PIX. 💜',
        });
        return;
      }
      const res = await api<{ resultado: 'pago' | 'analise' | 'recusado' | 'erro'; mensagem: string }>(
        `/public/pague/${encodeURIComponent(token)}/cartao`,
        {
          method: 'POST',
          body: JSON.stringify({
            cardEncrypted,
            holderName: nome.trim(),
            holderCpf: soDigitos(cpf),
            installments: Number(parcelas) || 1,
            ...(c.precisaEmail ? { email: email.trim() } : {}),
            ...(c.precisaCelular ? { phone: soDigitos(celular) } : {}),
          }),
        },
      );
      if (res.resultado === 'pago') {
        // Limpa o que foi digitado — o cartão não fica na tela depois de pago.
        setNumero('');
        setCvv('');
        setValidade('');
        await consulta();
        return;
      }
      if (res.resultado === 'analise') setRetornoCartao({ tipo: 'analise', msg: res.mensagem });
      else setRetornoCartao({ tipo: res.resultado, msg: res.mensagem });
      setCvv('');
      await consulta();
    } catch (e: any) {
      setRetornoCartao({
        tipo: 'erro',
        msg: msgDoErro(e, 'Não conseguimos concluir agora. Tente de novo em instantes ou pague com PIX. 💜'),
      });
      void consulta();
    } finally {
      setPagando(false);
    }
  };

  const whatsUrl = (msg: string) =>
    r?.lojaWhatsapp ? `https://wa.me/${r.lojaWhatsapp}?text=${encodeURIComponent(msg)}` : null;

  const valorTxt = r?.valor ? brl(r.valor) : '';
  const maxParc = Math.max(1, Math.min(12, c?.maxParcelas || 1));
  const opcoesParcelas = Array.from({ length: maxParc }, (_, i) => {
    const n = i + 1;
    const v = r?.valor || 0;
    return { v: String(n), txt: n === 1 ? `À vista · ${brl(v)}` : `${n}x de ${brl(v / n)} sem juros` };
  });
  const erroVisivel = (k: keyof typeof erros) => (tentouEnviar ? erros[k] : '');

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: '#FAFAF7',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '24px 16px',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: '#fff',
          borderRadius: 18,
          padding: '28px 20px',
          boxShadow: '0 10px 40px rgba(0,0,0,.08)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 13, letterSpacing: 2, color: GOLD, fontWeight: 700, marginBottom: 20 }}>
          LURD&apos;S PLUS SIZE
        </div>

        {erro && !r && <p style={{ color: '#B3261E', fontSize: 15 }}>{erro}</p>}
        {!r && !erro && <p style={{ color: '#6B6B6B', fontSize: 15 }}>Abrindo seu link de pagamento…</p>}

        {r?.estado === 'aberto' && (
          <>
            <p style={{ color: '#444', fontSize: 15, margin: '0 0 4px' }}>
              Pagamento {r.lojaNome ? <>· {r.lojaNome}</> : null}
            </p>
            <p style={{ fontSize: 30, fontWeight: 800, color: '#1C1C1C', margin: '0 0 18px' }}>{valorTxt}</p>

            <div
              role="tablist"
              style={{ display: 'flex', gap: 6, background: '#F3EFE3', borderRadius: 12, padding: 4, marginBottom: 16 }}
            >
              {(['cartao', 'pix'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={aba === k}
                  onClick={() => setAba(k)}
                  style={{
                    flex: 1,
                    border: 'none',
                    cursor: 'pointer',
                    borderRadius: 9,
                    padding: '11px 8px',
                    fontSize: 15,
                    fontWeight: 700,
                    background: aba === k ? '#fff' : 'transparent',
                    color: aba === k ? '#1C1C1C' : '#7A7263',
                    boxShadow: aba === k ? '0 1px 4px rgba(0,0,0,.08)' : 'none',
                  }}
                >
                  {k === 'cartao' ? '💳 Cartão' : '⚡ PIX'}
                </button>
              ))}
            </div>

            {aba === 'cartao' && (
              <div style={{ textAlign: 'left' }}>
                {c?.emAnalise ? (
                  <Aviso cor="amber">
                    Seu pagamento com cartão está <strong>em análise no banco</strong>. Assim que ele responder, esta
                    página confirma sozinha — não precisa pagar de novo 💜
                  </Aviso>
                ) : !cartaoPode ? (
                  <Aviso cor="amber">
                    {c?.motivo === 'tentativas'
                      ? 'Este pedido já teve muitas tentativas no cartão. Pague com PIX ou fale com a loja 💜'
                      : 'O pagamento com cartão está indisponível agora. Pague com PIX ou tente de novo em alguns minutos 💜'}
                  </Aviso>
                ) : (
                  <>
                    <label style={rotulo} htmlFor="pg-numero">Número do cartão</label>
                    <input
                      id="pg-numero"
                      style={campo}
                      inputMode="numeric"
                      autoComplete="cc-number"
                      placeholder="0000 0000 0000 0000"
                      value={numero}
                      onChange={(e) => setNumero(mascaraCartao(e.target.value))}
                    />
                    <Erro msg={erroVisivel('numero')} />

                    <label style={rotulo} htmlFor="pg-nome">Nome impresso no cartão</label>
                    <input
                      id="pg-nome"
                      style={campo}
                      autoComplete="cc-name"
                      placeholder="Como aparece no cartão"
                      value={nome}
                      onChange={(e) => setNome(e.target.value.toUpperCase())}
                    />
                    <Erro msg={erroVisivel('nome')} />

                    <div style={{ display: 'flex', gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <label style={rotulo} htmlFor="pg-validade">Validade</label>
                        <input
                          id="pg-validade"
                          style={campo}
                          inputMode="numeric"
                          autoComplete="cc-exp"
                          placeholder="MM/AA"
                          value={validade}
                          onChange={(e) => setValidade(mascaraValidade(e.target.value))}
                        />
                        <Erro msg={erroVisivel('validade')} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={rotulo} htmlFor="pg-cvv">CVV</label>
                        <input
                          id="pg-cvv"
                          style={campo}
                          inputMode="numeric"
                          autoComplete="cc-csc"
                          placeholder="123"
                          maxLength={4}
                          value={cvv}
                          onChange={(e) => setCvv(soDigitos(e.target.value).slice(0, 4))}
                        />
                        <Erro msg={erroVisivel('cvv')} />
                      </div>
                    </div>

                    <label style={rotulo} htmlFor="pg-cpf">CPF do titular do cartão</label>
                    <input
                      id="pg-cpf"
                      style={campo}
                      inputMode="numeric"
                      placeholder="000.000.000-00"
                      value={cpf}
                      onChange={(e) => setCpf(mascaraCpf(e.target.value))}
                    />
                    <Erro msg={erroVisivel('cpf')} />

                    {c?.precisaEmail && (
                      <>
                        <label style={rotulo} htmlFor="pg-email">Seu e-mail</label>
                        <input
                          id="pg-email"
                          style={campo}
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          placeholder="voce@email.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                        />
                        <Erro msg={erroVisivel('email')} />
                      </>
                    )}
                    {c?.precisaCelular && (
                      <>
                        <label style={rotulo} htmlFor="pg-celular">Seu celular</label>
                        <input
                          id="pg-celular"
                          style={campo}
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="(11) 98765-4321"
                          value={celular}
                          onChange={(e) => setCelular(mascaraCelular(e.target.value))}
                        />
                        <Erro msg={erroVisivel('celular')} />
                      </>
                    )}

                    <label style={rotulo} htmlFor="pg-parcelas">Parcelas</label>
                    <select
                      id="pg-parcelas"
                      style={{ ...campo, appearance: 'auto' }}
                      value={parcelas}
                      onChange={(e) => setParcelas(e.target.value)}
                    >
                      {opcoesParcelas.map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.txt}
                        </option>
                      ))}
                    </select>

                    {retornoCartao && (
                      <Aviso cor={retornoCartao.tipo === 'analise' ? 'amber' : 'red'}>{retornoCartao.msg}</Aviso>
                    )}

                    <button
                      type="button"
                      onClick={() => void pagarCartao()}
                      disabled={pagando}
                      style={{
                        display: 'block',
                        width: '100%',
                        border: 'none',
                        cursor: pagando ? 'wait' : 'pointer',
                        marginTop: 18,
                        background: GREEN,
                        color: '#fff',
                        fontWeight: 700,
                        padding: '16px 20px',
                        borderRadius: 12,
                        fontSize: 17,
                        opacity: pagando ? 0.7 : 1,
                      }}
                    >
                      {pagando ? 'Processando…' : `Pagar ${valorTxt} no cartão`}
                    </button>
                    <p style={{ color: '#8A8A8A', fontSize: 12, lineHeight: 1.5, marginTop: 10, textAlign: 'center' }}>
                      🔒 Pagamento processado pelo PagBank. Os dados do cartão são criptografados no seu celular
                      e não ficam com a loja.
                    </p>
                  </>
                )}
              </div>
            )}

            {aba === 'pix' && (
              <div>
                {erroPix && <Aviso cor="red">{erroPix}</Aviso>}
                {!pix || pixVencido ? (
                  <button
                    type="button"
                    onClick={() => void gerarPix()}
                    disabled={gerandoPix}
                    style={{
                      display: 'block',
                      width: '100%',
                      border: 'none',
                      cursor: 'pointer',
                      background: GOLD,
                      color: '#fff',
                      fontWeight: 700,
                      padding: '16px 20px',
                      borderRadius: 12,
                      fontSize: 17,
                      opacity: gerandoPix ? 0.7 : 1,
                    }}
                  >
                    {gerandoPix ? 'Gerando código PIX…' : pixVencido ? 'Gerar novo código PIX' : 'Gerar código PIX'}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void copiar()}
                      style={{
                        display: 'block',
                        width: '100%',
                        border: 'none',
                        cursor: 'pointer',
                        background: copiado ? GREEN : GOLD,
                        color: '#fff',
                        fontWeight: 700,
                        padding: '16px 20px',
                        borderRadius: 12,
                        fontSize: 17,
                      }}
                    >
                      {copiado ? '✓ Código copiado!' : 'Copiar código PIX'}
                    </button>
                    <p style={{ color: '#6B6B6B', fontSize: 13.5, lineHeight: 1.5, marginTop: 10 }}>
                      Depois é só abrir o app do seu banco, escolher <strong>PIX copia e cola</strong> e colar o
                      código.
                    </p>
                    {pix.qrCodeImageB64 && (
                      <>
                        <p style={{ color: '#9A9A9A', fontSize: 12, margin: '18px 0 8px' }}>
                          — ou pague pelo QR Code em outro aparelho —
                        </p>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`data:image/png;base64,${pix.qrCodeImageB64}`}
                          alt="QR Code do PIX"
                          style={{ width: 180, height: 180, borderRadius: 10, border: '1px solid #EBE7DA', background: '#fff' }}
                        />
                      </>
                    )}
                    {pix.expiraEm && (
                      <p style={{ color: '#9A9A9A', fontSize: 12, marginTop: 8 }}>
                        Código válido até{' '}
                        {new Date(pix.expiraEm).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone: 'America/Sao_Paulo',
                        })}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            <div
              style={{
                marginTop: 18,
                background: '#FBF6E6',
                border: '1px solid #EBDDB3',
                borderRadius: 10,
                padding: '10px 12px',
                color: '#8C7325',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Assim que o pagamento cair, esta página confirma sozinha ✨
            </div>
          </>
        )}

        {r?.estado === 'pago' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: GREEN, margin: '0 0 10px' }}>Pagamento confirmado!</h1>
            <p style={{ color: '#444', fontSize: 16, lineHeight: 1.5 }}>
              {r.valor ? <>Recebemos {brl(r.valor)}{r.formaPaga === 'cartao' ? ' no cartão' : ' no PIX'}. </> : null}
              Suas peças já vão ser separadas 💜
            </p>
            {whatsUrl('Oi! Acabei de pagar o link. Quero saber do meu pedido.') && (
              <a
                href={whatsUrl('Oi! Acabei de pagar o link. Quero saber do meu pedido.')!}
                style={{
                  display: 'inline-block',
                  marginTop: 22,
                  color: GOLD,
                  fontWeight: 600,
                  fontSize: 15,
                  textDecoration: 'none',
                  borderBottom: `1px solid ${GOLD}`,
                }}
              >
                Falar com a loja {r.lojaNome ? `(${r.lojaNome})` : ''}
              </a>
            )}
          </>
        )}

        {(r?.estado === 'vencido' || r?.estado === 'encerrado') && (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>⏰</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1C1C1C', margin: '0 0 10px' }}>
              {r.estado === 'vencido' ? 'Esse link venceu' : 'Esse link não está mais ativo'}
            </h1>
            <p style={{ color: '#444', fontSize: 16, lineHeight: 1.5 }}>
              {r.mensagem || 'Nada foi cobrado. Fale com a loja pra receber um link novo 💜'}
            </p>
            {whatsUrl(`Oi! Meu link de pagamento${r.valor ? ` de ${brl(r.valor)}` : ''} não está mais ativo. Pode mandar outro?`) ? (
              <a
                href={
                  whatsUrl(
                    `Oi! Meu link de pagamento${r.valor ? ` de ${brl(r.valor)}` : ''} não está mais ativo. Pode mandar outro?`,
                  )!
                }
                style={{
                  display: 'block',
                  marginTop: 22,
                  background: GREEN,
                  color: '#fff',
                  fontWeight: 700,
                  padding: '15px 20px',
                  borderRadius: 12,
                  textDecoration: 'none',
                  fontSize: 16,
                }}
              >
                Pedir um link novo no WhatsApp
              </a>
            ) : (
              <p style={{ color: '#6B6B6B', fontSize: 15, marginTop: 18 }}>
                Chama a loja {r.lojaNome ? <strong>{r.lojaNome}</strong> : null} que ela manda outro 💜
              </p>
            )}
          </>
        )}

        {r?.estado === 'inexistente' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>🔎</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1C1C1C', margin: '0 0 10px' }}>Link não encontrado</h1>
            <p style={{ color: '#444', fontSize: 16, lineHeight: 1.5 }}>
              Confere se o endereço veio inteiro na mensagem. Se veio, chama a loja que ela manda um novo —{' '}
              <strong>nada foi cobrado</strong>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Erro({ msg }: { msg: string }) {
  if (!msg) return null;
  return <p style={{ color: '#B3261E', fontSize: 12.5, margin: '5px 0 0', textAlign: 'left' }}>{msg}</p>;
}

function Aviso({ cor, children }: { cor: 'amber' | 'red'; children: React.ReactNode }) {
  const paleta =
    cor === 'red'
      ? { bg: '#FDECEA', bd: '#F5C2BD', tx: '#8E1F14' }
      : { bg: '#FBF6E6', bd: '#EBDDB3', tx: '#7A5E12' };
  return (
    <div
      role="status"
      style={{
        marginTop: 14,
        background: paleta.bg,
        border: `1px solid ${paleta.bd}`,
        color: paleta.tx,
        borderRadius: 10,
        padding: '11px 12px',
        fontSize: 14,
        lineHeight: 1.45,
        textAlign: 'left',
      }}
    >
      {children}
    </div>
  );
}
