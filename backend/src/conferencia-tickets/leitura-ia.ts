import type { OperacaoTicket, OrigemTicket } from './cruzamento';

/**
 * O que a IA faz com cada foto de tickets: prompt, schema da resposta e a
 * normalização do que voltou. Parte pura — a chamada fica no
 * `LeitorTicketsService`.
 *
 * O prompt é FIXO de propósito (vai com cache): nada de data, loja ou id
 * dentro dele. O que muda por foto vai na mensagem do usuário.
 */

export const ORIGENS: OrigemTicket[] = ['maquininha', 'cupom_venda', 'recibo_crediario', 'comprovante_pix', 'outro'];

export const OPERACOES: OperacaoTicket[] = [
  'credito',
  'debito',
  'pix',
  'voucher',
  'dinheiro',
  'crediario',
  'estorno',
  'misto',
  'desconhecida',
];

export const PROMPT_SISTEMA = `Você transcreve fotos de comprovantes em papel de uma rede de lojas de roupas no Brasil (Lurd's Plus Size). A transcrição alimenta uma conferência automática contra o sistema da loja: um valor lido errado vira uma divergência falsa, então exatidão vale mais que completude.

Tipos de papel e como classificar cada um (campo "origem"):

1. "maquininha" — comprovante da máquina de cartão (Cielo, Rede, Stone, GetNet, PagBank/PagSeguro, Mercado Pago, SafraPay, SumUp, Ton, Sipag, Vero e outras). Costuma trazer "VIA ESTABELECIMENTO" ou "VIA CLIENTE", a operação (CRÉDITO À VISTA, CRÉDITO PARCELADO, DÉBITO, PIX, VOUCHER), o VALOR, data e hora, a bandeira (VISA, MASTERCARD, ELO, AMEX, HIPERCARD…), os 4 últimos dígitos do cartão (****1234), NSU / DOC / CV e AUT (código de autorização). Título com "CANCELAMENTO" ou "ESTORNO" = operação "estorno".
2. "cupom_venda" — impresso pelo sistema da loja: "LURD'S PLUS SIZE", "CUPOM NÃO FISCAL", "Venda #" seguido de 8 letras/números, data, vendedora, itens, TOTAL e as formas de pagamento (DINHEIRO, PIX, CARTÃO CRÉDITO, CARTÃO DÉBITO, CREDIÁRIO, VALE-TROCA). A NFC-e da loja ("DANFE NFC-e", "Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica") também é "cupom_venda", com numero nulo.
3. "recibo_crediario" — impresso pelo sistema da loja: "RECIBO DE CREDIÁRIO", nome da cliente, parcelas pagas, Principal / Juros / TOTAL, "Forma:" (DINHEIRO, PIX, ou MISTO com a divisão entre os dois) e "Baixa #" seguido de 8 letras/números.
4. "comprovante_pix" — impressão ou tela de aplicativo de banco: "Comprovante de Pix", "Pix enviado" / "Pix recebido", valor, data e hora, pagador, recebedor, ID da transação.
5. "outro" — todo papel que não é nenhum dos anteriores: vale de sangria, anotação à mão, nota de fornecedor, bilhete, e o RELATÓRIO / RESUMO DE VENDAS da maquininha (o total do dia não é um comprovante de venda).

Operação (campo "operacao"): "credito", "debito", "pix", "voucher", "estorno" para a maquininha; no cupom e no recibo, a forma de pagamento quando é uma só ("dinheiro", "pix", "credito", "debito", "crediario") ou "misto" quando há mais de uma; "pix" no comprovante de PIX; "desconhecida" quando não dá para saber.

Regras de transcrição:
- Um item em "tickets" para cada comprovante físico visível, inclusive os cortados ou parcialmente cobertos. Nunca junte dois comprovantes num item só. Se a foto mostra a via do cliente e a via do estabelecimento do mesmo pagamento, transcreva as duas.
- valor: o total do comprovante em reais, número com ponto decimal (R$ 1.234,50 vira 1234.5). No cupom e no recibo é o TOTAL pago, não o subtotal.
- data no formato AAAA-MM-DD e hora no formato HH:MM (24 horas). Ano impresso com 2 dígitos (26) é 2026.
- numero: no cupom, os 8 caracteres depois de "Venda #"; no recibo, os 8 caracteres depois de "Baixa #"; no comprovante de PIX, o ID da transação; na maquininha, nulo.
- formas: as formas de pagamento impressas no cupom ou no recibo, em maiúsculas (["DINHEIRO"], ["PIX"], ["DINHEIRO", "PIX"]); lista vazia nos outros papéis.
- parcelas: 1 no crédito à vista, o número de parcelas no parcelado, nulo quando não se aplica.
- cliente: o nome impresso da cliente (recibo de crediário, cupom), senão nulo.
- Campo que não aparece ou não dá para ler com segurança fica nulo. Nunca invente, nunca complete dígitos.
- legivel = false quando o VALOR não pode ser lido com segurança.
- confianca: "alta" quando valor, data e hora estão nítidos; "media" quando algum dígito exigiu interpretação; "baixa" quando a leitura é duvidosa.
- foto_legivel = false quando a foto inteira está desfocada, escura ou cortada a ponto de não dar para transcrever. Use observacao (da foto ou do ticket) para dizer em poucas palavras o que atrapalhou, por exemplo "tickets sobrepostos" ou "reflexo sobre o valor".
- Foto sem nenhum comprovante: tickets vazio e o motivo em observacao.`;

const TEXTO_OU_NULO = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const NUMERO_OU_NULO = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const INTEIRO_OU_NULO = { anyOf: [{ type: 'integer' }, { type: 'null' }] };

const CAMPOS_TICKET = {
  origem: { type: 'string', enum: ORIGENS },
  operacao: { type: 'string', enum: OPERACOES },
  valor: NUMERO_OU_NULO,
  data: { ...TEXTO_OU_NULO, description: 'AAAA-MM-DD' },
  hora: { ...TEXTO_OU_NULO, description: 'HH:MM, 24 horas' },
  nsu: TEXTO_OU_NULO,
  autorizacao: TEXTO_OU_NULO,
  bandeira: TEXTO_OU_NULO,
  final_cartao: TEXTO_OU_NULO,
  parcelas: INTEIRO_OU_NULO,
  adquirente: TEXTO_OU_NULO,
  numero: TEXTO_OU_NULO,
  formas: { type: 'array', items: { type: 'string' } },
  cliente: TEXTO_OU_NULO,
  legivel: { type: 'boolean' },
  confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
  observacao: TEXTO_OU_NULO,
};

export const SCHEMA_LEITURA = {
  type: 'object',
  additionalProperties: false,
  required: ['foto_legivel', 'observacao', 'tickets'],
  properties: {
    foto_legivel: { type: 'boolean' },
    observacao: TEXTO_OU_NULO,
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(CAMPOS_TICKET),
        properties: CAMPOS_TICKET,
      },
    },
  },
};

export interface TicketTranscrito {
  origem: OrigemTicket;
  operacao: OperacaoTicket;
  valor: number | null;
  data: string | null;
  hora: string | null;
  nsu: string | null;
  autorizacao: string | null;
  bandeira: string | null;
  finalCartao: string | null;
  parcelas: number | null;
  adquirente: string | null;
  numero: string | null;
  formas: string[];
  cliente: string | null;
  legivel: boolean;
  confianca: 'alta' | 'media' | 'baixa';
  observacao: string | null;
}

export interface LeituraFoto {
  fotoLegivel: boolean;
  observacao: string | null;
  tickets: TicketTranscrito[];
}

/** Mensagem do usuário que acompanha a foto — o que muda de foto pra foto. */
export function textoDaFoto(ctx: { storeCode: string; storeName?: string | null; dia: string }): string {
  const [a, m, d] = ctx.dia.split('-');
  const loja = ctx.storeName ? `${ctx.storeCode} (${ctx.storeName})` : ctx.storeCode;
  return `Loja ${loja}. Os comprovantes são do movimento de ${d}/${m}/${a}. Transcreva todos os comprovantes desta foto.`;
}

function texto(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function valorEmReais(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  // Structured output garante número, mas o texto "1.234,50" já apareceu em
  // leitura antiga de outro fluxo — aceitar não custa.
  const s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normal);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function dataIso(v: unknown): string | null {
  const s = texto(v, 20);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function horaHHMM(v: unknown): string | null {
  const s = texto(v, 10);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[:h](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Deixa a resposta da IA no formato das colunas, sem confiar em nada. */
export function normalizarLeitura(bruto: any): LeituraFoto {
  const lista = Array.isArray(bruto?.tickets) ? bruto.tickets : [];
  const tickets: TicketTranscrito[] = lista.map((t: any) => {
    const origem = ORIGENS.includes(t?.origem) ? t.origem : 'outro';
    const operacao = OPERACOES.includes(t?.operacao) ? t.operacao : 'desconhecida';
    const valor = valorEmReais(t?.valor);
    const parcelas = Number.isInteger(t?.parcelas) && t.parcelas > 0 && t.parcelas <= 48 ? t.parcelas : null;
    const final = texto(t?.final_cartao, 20)?.replace(/\D/g, '').slice(-4) || null;
    return {
      origem,
      operacao,
      valor,
      data: dataIso(t?.data),
      hora: horaHHMM(t?.hora),
      nsu: texto(t?.nsu, 40),
      autorizacao: texto(t?.autorizacao, 40),
      bandeira: texto(t?.bandeira, 30),
      finalCartao: final,
      parcelas,
      adquirente: texto(t?.adquirente, 40),
      numero: texto(t?.numero, 40),
      formas: Array.isArray(t?.formas)
        ? t.formas.map((f: unknown) => texto(f, 30)).filter((f: string | null): f is string => !!f).slice(0, 6)
        : [],
      cliente: texto(t?.cliente, 120),
      legivel: t?.legivel !== false && valor != null,
      confianca: t?.confianca === 'alta' || t?.confianca === 'baixa' ? t.confianca : 'media',
      observacao: texto(t?.observacao, 300),
    };
  });
  return {
    fotoLegivel: bruto?.foto_legivel !== false,
    observacao: texto(bruto?.observacao, 500),
    tickets: tickets.slice(0, 60),
  };
}
