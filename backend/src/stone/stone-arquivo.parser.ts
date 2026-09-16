import { DOMParser } from '@xmldom/xmldom';

/**
 * Leitor do ARQUIVO DE CONCILIAÇÃO da Stone (layouts XML 2.2 e 2.4).
 * Doc: https://conciliacao.stone.com.br/reference/layout-2-4
 *
 * Um arquivo = um StoneCode × um dia. Daqui só sai o que a conferência de
 * cartão usa, do container `FinancialTransactions` (transações e eventos DO
 * DIA do arquivo):
 *  - CAPTURA (`<Captures>1`): a venda na maquininha. Valor, tipo de conta,
 *    bandeira, parcelas e cartão só vêm nesse evento.
 *  - CANCELAMENTO (`<Cancellations>1`): pode vir junto da captura (cancelou no
 *    mesmo dia — `CanceledAmount` na própria transação) ou sozinho, dias
 *    depois, só com a chave da transação e o container `Cancellations`.
 *
 * Função pura: recebe o XML já descompactado.
 */

export type TipoConta = 'credito' | 'debito' | 'voucher' | 'boleto' | 'outro';

export interface CapturaStone {
  /** AcquirerTransactionKey — o NSU da Stone, único por transação */
  chave: string;
  iniciador: string | null;
  /** instante da captura em UTC */
  capturadaEm: Date;
  /** 'YYYY-MM-DD' e 'HH:MM' no horário local da Stone (Brasília) */
  diaLocal: string;
  horaLocal: string;
  tipo: TipoConta;
  /** código cru do AccountType (1 débito, 2 crédito, 3/4 pré-pago, 5 voucher) */
  tipoConta: number | null;
  parcelas: number | null;
  valorAutorizado: number;
  valorCapturado: number;
  valorCancelado: number;
  bandeira: string | null;
  finalCartao: string | null;
  autorizacao: string | null;
  terminal: string | null;
  serial: string | null;
  valorLiquido: number | null;
  taxa: number | null;
  /** primeira previsão de pagamento, 'YYYY-MM-DD' */
  previsaoPagamento: string | null;
  cancelamentos: CancelamentoStone[];
}

export interface CancelamentoStone {
  chave: string;
  canceladaEm: Date | null;
  valorDevolvido: number;
}

export interface ArquivoStone {
  stoneCode: string | null;
  dataReferencia: string | null;
  layout: string | null;
  capturas: CapturaStone[];
  /** cancelamentos de transações capturadas em outro dia */
  cancelamentosAvulsos: CancelamentoStone[];
}

const BANDEIRAS: Record<string, string> = {
  '1': 'VISA',
  '2': 'MASTERCARD',
  '3': 'AMEX',
  '4': 'CABAL',
  '5': 'UNIONPAY',
  '9': 'HIPERCARD',
  '171': 'ELO',
};

const TERMINAIS: Record<string, string> = {
  '1': 'POS',
  '2': 'MICRO POS',
  '3': 'TEF',
  '4': 'ECOMMERCE',
  '5': 'PINPAD',
  '6': 'SOFTWARE',
  '7': 'APLICATIVO',
};

function filhos(el: any, nome: string): any[] {
  const out: any[] = [];
  for (let n = el?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n.localName || n.nodeName) === nome) out.push(n);
  }
  return out;
}

function filho(el: any, nome: string): any | null {
  return filhos(el, nome)[0] || null;
}

function texto(el: any, nome: string): string | null {
  const f = filho(el, nome);
  const t = f?.textContent?.trim();
  return t ? t : null;
}

function numero(el: any, nome: string): number | null {
  const t = texto(el, nome);
  if (t == null) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const centavos = (n: number | null | undefined) => (n == null ? 0 : Math.round(n * 100) / 100);

/** 'aaaammddHHmmss' → partes; null se não bate o formato */
function partesData(s: string | null) {
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/);
  if (!m) return null;
  return { a: m[1], mes: m[2], d: m[3], h: m[4] || '00', min: m[5] || '00', s: m[6] || '00' };
}

function instanteUtc(s: string | null): Date | null {
  const p = partesData(s);
  if (!p) return null;
  const d = new Date(`${p.a}-${p.mes}-${p.d}T${p.h}:${p.min}:${p.s}.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function diaIso(s: string | null): string | null {
  const p = partesData(s);
  return p ? `${p.a}-${p.mes}-${p.d}` : null;
}

function tipoDaConta(codigo: number | null): TipoConta {
  switch (codigo) {
    case 1:
    case 3:
      return 'debito';
    case 2:
    case 4:
      return 'credito';
    case 5:
      return 'voucher';
    case 10:
      return 'boleto';
    default:
      return 'outro';
  }
}

function lerCancelamentos(transacao: any, chave: string): CancelamentoStone[] {
  const bloco = filho(transacao, 'Cancellations');
  if (!bloco) return [];
  return filhos(bloco, 'Cancellation').map((c) => ({
    chave,
    canceladaEm: instanteLocalComoUtc(texto(c, 'CancellationDateTime')),
    valorDevolvido: centavos(numero(c, 'ReturnedAmount')),
  }));
}

/**
 * `CancellationDateTime` não diz o fuso; a Stone usa o horário local nos
 * campos "Local" e o de cancelamento acompanha a captura local nos exemplos da
 * documentação. Guardamos como Brasília → UTC (+3h).
 */
function instanteLocalComoUtc(s: string | null): Date | null {
  const d = instanteUtc(s);
  return d ? new Date(d.getTime() + 3 * 60 * 60_000) : null;
}

export function lerArquivoStone(xml: string): ArquivoStone {
  const limpo = String(xml || '').replace(/^﻿/, '').trim();
  if (!limpo.startsWith('<')) throw new Error('o arquivo da Stone não é XML');
  const doc = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => undefined,
      fatalError: (msg: string) => {
        throw new Error(`XML da Stone inválido: ${msg}`);
      },
    },
  }).parseFromString(limpo, 'text/xml');
  const raiz = doc?.documentElement;
  if (!raiz || (raiz.localName || raiz.nodeName) !== 'Conciliation') {
    throw new Error('o arquivo da Stone não tem o nó <Conciliation>');
  }

  const header = filho(raiz, 'Header');
  const arquivo: ArquivoStone = {
    stoneCode: texto(header, 'StoneCode'),
    dataReferencia: diaIso(texto(header, 'ReferenceDate')),
    layout: texto(header, 'LayoutVersion'),
    capturas: [],
    cancelamentosAvulsos: [],
  };

  const bloco = filho(raiz, 'FinancialTransactions');
  for (const t of bloco ? filhos(bloco, 'Transaction') : []) {
    const chave = texto(t, 'AcquirerTransactionKey');
    if (!chave) continue;
    const eventos = filho(t, 'Events');
    const capturas = numero(eventos, 'Captures') || 0;
    const cancelamentos = numero(eventos, 'Cancellations') || 0;
    const listaCanc = lerCancelamentos(t, chave);

    if (capturas > 0) {
      const local = partesData(texto(t, 'CaptureLocalDateTime'));
      const utcAut = instanteUtc(texto(t, 'AuthorizationDateTime'));
      const capturadaEm =
        instanteLocalComoUtc(texto(t, 'CaptureLocalDateTime')) || utcAut || new Date(NaN);
      const parcelasNo = filho(t, 'Installments');
      const parcelas = parcelasNo ? filhos(parcelasNo, 'Installment') : [];
      let liquido: number | null = null;
      let taxa: number | null = null;
      let previsao: string | null = null;
      for (const p of parcelas) {
        const bruto = numero(p, 'GrossAmount');
        const liq = numero(p, 'NetAmount');
        if (liq != null) liquido = (liquido || 0) + liq;
        const tx = numero(p, 'MdrAmount') ?? numero(p, 'SaleFee');
        if (tx != null) taxa = (taxa || 0) + tx;
        else if (bruto != null && liq != null) taxa = (taxa || 0) + (bruto - liq);
        const prev = diaIso(texto(p, 'PrevisionPaymentDate'));
        if (prev && (!previsao || prev < previsao)) previsao = prev;
      }
      const tipoConta = numero(t, 'AccountType');
      const cartao = texto(t, 'CardNumber');
      const poi = filho(t, 'Poi');
      const capturado = centavos(numero(t, 'CapturedAmount') ?? numero(t, 'AuthorizedAmount'));
      const canceladoCampo = centavos(numero(t, 'CanceledAmount'));
      const canceladoLista = centavos(listaCanc.reduce((s, c) => s + c.valorDevolvido, 0));
      arquivo.capturas.push({
        chave,
        iniciador: texto(t, 'InitiatorTransactionKey'),
        capturadaEm,
        diaLocal: local ? `${local.a}-${local.mes}-${local.d}` : arquivo.dataReferencia || '',
        horaLocal: local ? `${local.h}:${local.min}` : '',
        tipo: tipoDaConta(tipoConta),
        tipoConta,
        parcelas: numero(t, 'NumberOfInstallments'),
        valorAutorizado: centavos(numero(t, 'AuthorizedAmount')),
        valorCapturado: capturado,
        valorCancelado: Math.max(canceladoCampo, canceladoLista),
        bandeira: BANDEIRAS[texto(t, 'BrandId') || ''] || (texto(t, 'BrandId') ? `BANDEIRA ${texto(t, 'BrandId')}` : null),
        finalCartao: cartao ? cartao.replace(/\D/g, '').slice(-4) || null : null,
        autorizacao: texto(t, 'IssuerAuthorizationCode'),
        terminal: TERMINAIS[texto(poi, 'PoiType') || ''] || null,
        serial: texto(poi, 'SerialNumber'),
        valorLiquido: liquido == null ? null : centavos(liquido),
        taxa: taxa == null ? null : centavos(taxa),
        previsaoPagamento: previsao,
        cancelamentos: listaCanc,
      });
    } else if (cancelamentos > 0) {
      arquivo.cancelamentosAvulsos.push(
        ...(listaCanc.length ? listaCanc : [{ chave, canceladaEm: null, valorDevolvido: 0 }]),
      );
    }
  }
  return arquivo;
}
