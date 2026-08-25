'use client';

/**
 * TrackingTimeline — componente que consulta /tracking/:code e mostra
 * a FICHA DO OBJETO + os eventos em timeline vertical.
 *
 * Uso:
 *   <TrackingTimeline code={order.trackingCode} carrier={order.carrier} />
 *
 * ⚠️ A CONSULTA SEMPRE DEVOLVEU MAIS DO QUE A TELA MOSTRAVA (25/08). O SRO
 * manda serviço (PAC/SEDEX), peso e `dtPrevista` — a PREVISÃO DE ENTREGA, que
 * é a única data que responde "quando chega?" — e o card exibia só a lista de
 * eventos. Quem queria saber o prazo abria o site dos Correios por fora.
 *
 * O que é DADO e o que é COTAÇÃO:
 *   - ficha (serviço/postagem/previsão/peso) = o que o provedor devolveu pra
 *     ESTE objeto. Campo que o provedor não mandou não aparece — não existe
 *     estimativa maquiada de dado;
 *   - a linha do dinheiro compara o frete que a cliente PAGOU (dado do pedido)
 *     com o preço que o TRANSPORTE DAQUELA ETIQUETA cobra HOJE pelo mesmo
 *     trajeto (`GET /tracking/cotacao` — Correios ou Mais Envios, saindo do
 *     CEP da loja que postou). São coisas diferentes e a tela diz qual é qual:
 *     a cotação de hoje não é a fatura daquele envio, e o veredito de prejuízo
 *     só aparece quando provedor e origem batem com o envio de verdade.
 *
 * Render states:
 *   - Sem código → nada (retorna null)
 *   - Loading → skeleton
 *   - Erro/sem token → aviso amarelo com instrução
 *   - OK → ficha + timeline + banner verde "entregue" quando delivered=true
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface TrackingEvent {
  date: string;
  time: string;
  location: string;
  description: string;
  isDelivery: boolean;
}

interface TrackingResult {
  code: string;
  carrier: string;
  service: string | null;
  serviceDesc?: string | null;
  weightGrams?: number | null;
  postedAt?: string | null;
  origin?: string | null;
  destination?: string | null;
  events: TrackingEvent[];
  lastStatus: string | null;
  delivered: boolean;
  deliveredAt?: string | null;
  estimatedAt?: string | null;
  fetchedAt: string;
  provider: string;
  error?: string;
}

type FreteOpcao = {
  servico: string;
  codigo: string;
  precoReais: number | null;
  prazoDias: number | null;
  erro?: string;
};

type FreteResp = {
  /** Quem emitiu a etiqueta — e portanto quem foi cotado. */
  provedor: 'correios' | 'maisenvios';
  motivo: string;
  cepOrigem: string | null;
  lojaCode: string | null;
  lojaNome: string | null;
  /** true = não deu pra saber de qual loja saiu; cotou do CEP padrão. */
  origemPadrao: boolean;
  /** true = provedor E origem batem com o envio — só aí cabe veredito. */
  comparavel: boolean;
  cepDestino: string;
  pecas: number;
  pesoGramas: number | null;
  opcoes: FreteOpcao[];
  erro?: string;
};

interface Props {
  code: string | null | undefined;
  carrier?: string | null;
  /** Se true, já faz fetch ao montar. Se false, só quando usuário clica. */
  autoFetch?: boolean;
  /** Compact = esconde eventos antigos, só mostra último status + botão expandir. */
  compact?: boolean;
  /**
   * CEP de destino do pedido. Com ele o card cota preço+prazo NO PROVEDOR QUE
   * LEVOU — é o "quanto custa e quanto demora" desse trajeto. Sem CEP a linha
   * da cotação some (não há o que cotar).
   */
  cepDestino?: string | null;
  /** Nº de peças da caixa — a MESMA regra do checkout (250 g/peça). */
  pecas?: number;
  /**
   * Loja que POSTOU (code). Define o CEP de origem da cotação: cada loja posta
   * do CEP dela e o preço muda com a distância. Sem ela a cotação sai do CEP
   * padrão e vira só referência (sem veredito de prejuízo).
   */
  lojaCode?: string | null;
  /** Frete que a cliente pagou, em reais (linha de frete do pedido). */
  fretePago?: number | null;
  /**
   * O que a CASA pagou nesta etiqueta, em reais — gravado na emissão. É a
   * resposta de verdade pra "quanto custou esse frete?"; a cotação ao lado é
   * só conferência. Vazio nas etiquetas anteriores a 25/08.
   */
  custoEtiqueta?: number | null;
  /** 'provedor' (veio do transportador) ou 'cotacao' (cotado na emissão). */
  custoEtiquetaFonte?: string | null;
  /** Método pago ("PAC", "SEDEX (Correios)"…) — casa a cotação com o serviço certo. */
  metodoPago?: string | null;
}

const brl = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const dataBr = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('pt-BR');
};

const horaBr = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

/** Diferença em DIAS DE CALENDÁRIO (positivo = no futuro). Sem hora no meio. */
function diasAte(iso: string | null | undefined, base?: string | null): number | null {
  if (!iso) return null;
  const alvo = new Date(iso);
  const hoje = base ? new Date(base) : new Date();
  if (isNaN(alvo.getTime()) || isNaN(hoje.getTime())) return null;
  const a = Date.UTC(alvo.getFullYear(), alvo.getMonth(), alvo.getDate());
  const b = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return Math.round((a - b) / 86_400_000);
}

const kg = (g: number | null | undefined) =>
  g == null
    ? null
    : `${(g / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;

/** Um quadradinho da ficha. Só é chamado quando há valor — nada de "—" na tela. */
function Ficha({
  rotulo,
  valor,
  detalhe,
  tom = 'neutro',
}: {
  rotulo: string;
  valor: string;
  detalhe?: string | null;
  tom?: 'neutro' | 'bom' | 'atencao' | 'ruim';
}) {
  const cor =
    tom === 'bom'
      ? 'border-emerald-200 bg-emerald-50'
      : tom === 'atencao'
        ? 'border-amber-200 bg-amber-50'
        : tom === 'ruim'
          ? 'border-rose-200 bg-rose-50'
          : 'border-slate-200 bg-slate-50';
  const corTexto =
    tom === 'bom'
      ? 'text-emerald-900'
      : tom === 'atencao'
        ? 'text-amber-900'
        : tom === 'ruim'
          ? 'text-rose-900'
          : 'text-slate-900';
  return (
    <div className={`rounded-lg border px-3 py-2 ${cor}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{rotulo}</div>
      <div className={`text-sm font-bold leading-tight ${corTexto}`}>{valor}</div>
      {detalhe && <div className="mt-0.5 text-[11px] leading-tight text-slate-600">{detalhe}</div>}
    </div>
  );
}

export default function TrackingTimeline({
  code,
  carrier,
  autoFetch = true,
  compact = false,
  cepDestino,
  pecas,
  lojaCode,
  fretePago,
  custoEtiqueta,
  custoEtiquetaFonte,
  metodoPago,
}: Props) {
  const [data, setData] = useState<TrackingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const [err, setErr] = useState<string | null>(null);
  const [frete, setFrete] = useState<FreteResp | null>(null);
  const [freteErr, setFreteErr] = useState<string | null>(null);
  const [freteLoading, setFreteLoading] = useState(false);

  const fetchIt = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    setErr(null);
    try {
      const qs = carrier ? `?carrier=${encodeURIComponent(carrier)}` : '';
      const r = await api<TrackingResult>(`/tracking/${encodeURIComponent(code)}${qs}`);
      setData(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao consultar rastreio');
    } finally {
      setLoading(false);
    }
  }, [code, carrier]);

  /**
   * Cotação ao vivo (preço + prazo). Chamada à parte de propósito: ela demora
   * ~2,5 s por serviço e NÃO pode segurar a timeline, que é o que a tela
   * precisa primeiro. Falha aqui é linha cinza, não alarme — o rastreio
   * continua valendo sem a cotação.
   */
  const cotar = useCallback(async () => {
    const cep = String(cepDestino || '').replace(/\D/g, '');
    if (cep.length !== 8) return;
    setFreteLoading(true);
    setFreteErr(null);
    try {
      // Quem cota e de onde é decisão do BACKEND (ele conhece o CEP da loja e
      // sabe qual provedor emitiu a etiqueta) — a tela só manda o contexto.
      const qs =
        `?cepDestino=${cep}` +
        `&pecas=${Math.max(1, Math.round(Number(pecas) || 1))}` +
        (lojaCode ? `&loja=${encodeURIComponent(lojaCode)}` : '') +
        (carrier ? `&carrier=${encodeURIComponent(carrier)}` : '') +
        (code ? `&code=${encodeURIComponent(code)}` : '');
      setFrete(await api<FreteResp>(`/tracking/cotacao${qs}`));
    } catch (e: any) {
      setFreteErr(e?.message || 'indisponível');
    } finally {
      setFreteLoading(false);
    }
  }, [cepDestino, pecas, lojaCode, carrier, code]);

  useEffect(() => {
    if (autoFetch && code) void fetchIt();
  }, [autoFetch, code, fetchIt]);

  /**
   * Cota só quando NÃO se sabe o que a etiqueta custou. Com o custo gravado, a
   * pergunta "quanto custou esse frete?" já está respondida — e cada cotação é
   * uma chamada de ~2,5 s na API do transportador por pedido aberto.
   */
  useEffect(() => {
    if (autoFetch && code && cepDestino && custoEtiqueta == null) void cotar();
  }, [autoFetch, code, cepDestino, custoEtiqueta, cotar]);

  if (!code) return null;

  const previsao = dataBr(data?.estimatedAt);
  const diasPrevisao = diasAte(data?.estimatedAt);
  const postado = dataBr(data?.postedAt);
  const horaPostagem = horaBr(data?.postedAt);
  const entregue = dataBr(data?.deliveredAt);
  const diasEmTransito = data?.postedAt && !data?.delivered ? -(diasAte(data.postedAt) ?? 0) : null;
  const atrasoNaEntrega =
    data?.delivered && data?.deliveredAt && data?.estimatedAt
      ? -(diasAte(data.estimatedAt, data.deliveredAt) ?? 0)
      : null;

  /**
   * "+EXPRESSO", "+ECONÔMICO" — o Mais Envios batiza os serviços dele com nome
   * próprio, e é ESSE nome que vem no rastreio. A tela mostra a família que a
   * loja usa no dia a dia (SEDEX/PAC) e guarda o nome cru embaixo, senão o
   * card fala uma língua que ninguém do balcão usa.
   */
  const familiaServico = (cru: string | null | undefined): string | null => {
    const t = String(cru || '').toUpperCase();
    if (!t) return null;
    if (/SEDEX|EXPRESS/.test(t)) return 'SEDEX';
    if (/PAC|ECON/.test(t)) return 'PAC';
    return null;
  };
  const familia = familiaServico(data?.service);

  // A cotação que corresponde ao que a cliente pagou: casa pelo nome do método
  // do pedido e, na falta dele, pela família do serviço que o objeto declara.
  const alvoServico = `${metodoPago || ''} ${familia || data?.service || ''}`.toUpperCase();
  const opcaoPaga = frete?.opcoes.find((o) => alvoServico.includes(o.servico.toUpperCase())) ?? null;
  /**
   * 🔴 VEREDITO SÓ QUANDO A COMPARAÇÃO É LEGÍTIMA (25/08).
   *
   * Ordem de confiança: o CUSTO GRAVADO na emissão é a conta de verdade —
   * quando ele existe, a margem sai dele e ponto. Sem ele, a cotação de hoje
   * só vale como veredito se vier do MESMO provedor da etiqueta e do CEP da
   * loja que postou: a primeira versão gritou "frete no prejuízo: R$ 9,01" num
   * envio do Mais Envios cotado no balcão dos Correios, saindo de uma cidade
   * a 300 km de onde a caixa saiu.
   */
  const margem =
    fretePago == null
      ? null
      : custoEtiqueta != null
        ? fretePago - custoEtiqueta
        : frete?.comparavel && opcaoPaga?.precoReais != null
          ? fretePago - opcaoPaga.precoReais
          : null;
  const nomeProvedor = frete?.provedor === 'maisenvios' ? 'Mais Envios' : 'Correios';

  const temFicha = !!data && (!!data.service || !!postado || !!previsao || data.weightGrams != null);
  const temDinheiro = fretePago != null || !!frete || freteLoading || !!freteErr;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">📦</span>
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Rastreio {carrier ? `(${carrier.toUpperCase()})` : ''}
            </div>
            <div className="font-mono text-xs text-slate-500">{code}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={fetchIt}
          disabled={loading}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {err && (
        <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          {err}
        </div>
      )}

      {data?.error && (
        <div className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠️ {data.error}
        </div>
      )}

      {/* FICHA DO OBJETO — o que os Correios sabem DESTE envio. */}
      {temFicha && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {data?.service && (
            <Ficha
              rotulo="Serviço"
              valor={familia || data.service.toUpperCase()}
              detalhe={
                [
                  // Nome cru do provedor, quando é diferente da família.
                  familia && familia !== data.service.toUpperCase() ? data.service : null,
                  data.serviceDesc || null,
                  data.provider === 'maisenvios' ? 'via Mais Envios' : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || null
              }
            />
          )}
          {postado && (
            <Ficha
              rotulo="Postado"
              valor={`${postado}${horaPostagem ? ` · ${horaPostagem}` : ''}`}
              detalhe={
                [
                  data?.origin && data?.destination
                    ? `${data.origin} → ${data.destination}`
                    : data?.origin || data?.destination || null,
                  diasEmTransito != null && diasEmTransito > 0
                    ? `${diasEmTransito} dia(s) em trânsito`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || null
              }
            />
          )}
          {/* ETIQUETA EMITIDA NÃO É POSTAGEM. Enquanto os Correios não
              registram a postagem, a caixa está no balcão da loja — foi assim
              que a REM-732 ficou 8 dias parada. O card diz isso em vez de
              simplesmente omitir a linha. */}
          {!postado && !!data && data.events.length > 0 && !data.delivered && (
            <Ficha
              rotulo="Postagem"
              valor="ainda não postado"
              tom="atencao"
              detalhe="etiqueta emitida — a caixa não saiu da loja"
            />
          )}
          {previsao && !data?.delivered && (
            <Ficha
              rotulo="Previsão de entrega"
              valor={previsao}
              tom={diasPrevisao != null && diasPrevisao < 0 ? 'ruim' : 'neutro'}
              detalhe={
                diasPrevisao == null
                  ? null
                  : diasPrevisao < 0
                    ? `atrasado há ${-diasPrevisao} dia(s)`
                    : diasPrevisao === 0
                      ? 'chega hoje'
                      : diasPrevisao === 1
                        ? 'chega amanhã'
                        : `faltam ${diasPrevisao} dias`
              }
            />
          )}
          {data?.delivered && entregue && (
            <Ficha
              rotulo="Entregue"
              valor={entregue}
              tom={atrasoNaEntrega != null && atrasoNaEntrega > 0 ? 'atencao' : 'bom'}
              detalhe={
                previsao == null
                  ? null
                  : atrasoNaEntrega != null && atrasoNaEntrega > 0
                    ? `${atrasoNaEntrega} dia(s) depois do prazo (${previsao})`
                    : `dentro do prazo (${previsao})`
              }
            />
          )}
          {data?.weightGrams != null && <Ficha rotulo="Peso" valor={kg(data.weightGrams) || ''} />}
        </div>
      )}

      {/* O DINHEIRO — o que a cliente pagou × o que o TRANSPORTE DELE cobra hoje. */}
      {temDinheiro && (
        <div className="mt-2 rounded-lg border border-slate-200 px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
            {fretePago != null && (
              <span className="text-slate-700">
                Frete pago pela cliente: <b className="text-sm text-slate-900">{brl(fretePago)}</b>
              </span>
            )}
            {/* O QUE A CASA PAGOU — o número que a cotação nunca vai ser. */}
            {custoEtiqueta != null && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-800">
                Pagamos: <b className="text-sm">{brl(custoEtiqueta)}</b>
                {custoEtiquetaFonte === 'cotacao' ? (
                  <span className="text-slate-500"> (cotado na emissão)</span>
                ) : null}
              </span>
            )}
            {freteLoading && <span className="text-slate-400">cotando o frete…</span>}
            {frete?.opcoes
              .filter((o) => o.precoReais != null)
              .map((o) => (
                <span
                  key={o.codigo}
                  className={`rounded px-2 py-0.5 ${
                    opcaoPaga?.codigo === o.codigo
                      ? 'bg-slate-100 font-semibold text-slate-900'
                      : 'text-slate-600'
                  }`}
                >
                  {o.servico} {nomeProvedor} hoje: {brl(o.precoReais)}
                  {o.prazoDias != null ? ` · ${o.prazoDias} dia(s) úteis` : ''}
                </span>
              ))}
            {margem != null && (
              <span
                className={`rounded px-2 py-0.5 font-bold ${
                  margem < 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                }`}
              >
                {margem < 0 ? `frete no prejuízo: ${brl(-margem)}` : `sobra ${brl(margem)}`}
              </span>
            )}
          </div>
          {frete && !frete.erro && (
            <div className="mt-1 text-[10px] leading-tight text-slate-400">
              Cotação de hoje no {nomeProvedor} ({frete.motivo}), saindo de{' '}
              {frete.lojaNome ? `${frete.lojaNome} — CEP ${frete.cepOrigem}` : `CEP ${frete.cepOrigem}`}
              {' · '}caixa de {frete.pecas} peça(s), {frete.pesoGramas} g.
              {frete.comparavel
                ? ' Serve pra conferir o preço cobrado, não é a fatura deste envio.'
                : ' ⚠️ Não dá pra saber de qual loja o objeto saiu, então isto é só referência — sem essa origem, comparar com o frete cobrado acusaria prejuízo que pode não existir.'}
            </div>
          )}
          {(freteErr || frete?.erro) && (
            <div className="mt-1 text-[10px] text-slate-400">
              Cotação indisponível ({freteErr || frete?.erro}).
            </div>
          )}
        </div>
      )}

      {data?.delivered && (
        <div className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
          ✅ Objeto entregue
        </div>
      )}

      {data?.lastStatus && !data.delivered && (
        <div className="mt-3 rounded bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <span className="font-semibold">Último status:</span> {data.lastStatus}
        </div>
      )}

      {data && data.events.length > 0 && (
        <>
          {compact && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 text-xs font-medium text-sky-700 hover:underline"
            >
              Ver histórico completo ({data.events.length} eventos)
            </button>
          )}
          {expanded && (
            <ol className="mt-4 space-y-3 border-l-2 border-slate-200 pl-4">
              {data.events.map((ev, i) => (
                <li key={i} className="relative">
                  <span
                    className={`absolute -left-[22px] top-1 h-3 w-3 rounded-full border-2 border-white ${
                      ev.isDelivery
                        ? 'bg-emerald-500'
                        : i === 0
                          ? 'bg-sky-500'
                          : 'bg-slate-400'
                    }`}
                  />
                  <div className="text-sm font-medium text-slate-900">
                    {ev.description}
                  </div>
                  <div className="text-xs text-slate-600">
                    {ev.date} {ev.time && `· ${ev.time}`}
                    {ev.location && ` · ${ev.location}`}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {data && data.events.length === 0 && !data.error && !loading && (
        <div className="mt-3 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Ainda sem eventos registrados pelo Correios. Pode levar até 24h após a postagem.
        </div>
      )}

      {data?.fetchedAt && (
        <div className="mt-3 text-right text-[10px] text-slate-400">
          Atualizado: {new Date(data.fetchedAt).toLocaleTimeString('pt-BR')}
        </div>
      )}
    </div>
  );
}
