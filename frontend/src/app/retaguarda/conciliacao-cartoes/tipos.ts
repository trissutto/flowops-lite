/**
 * Tipos e rótulos da Conferência dos cartões (vendas no cartão × Stone).
 * Espelham backend/src/conciliacao-cartao/*.
 */

export type StatusDia =
  | 'confere'
  | 'atencao'
  | 'divergente'
  | 'aguardando_arquivo'
  | 'erro_arquivo'
  | 'sem_stone'
  | 'em_andamento'
  | 'sem_movimento';

export type LinhaLista = {
  storeCode: string;
  storeName: string;
  dia: string;
  diaCurto: string;
  status: StatusDia;
  qtdSistema: number;
  valorSistema: number;
  qtdStone: number;
  valorStone: number;
  divergencias: number;
  atencoes: number;
  valorDivergente: number;
  frases: string[];
  conferidoEm: string | null;
  revisadoEm: string | null;
  revisadoPor: string | null;
  revisadoNota: string | null;
};

export type RespostaLista = {
  de: string;
  ate: string;
  linhas: LinhaLista[];
  contagem: Partial<Record<StatusDia, number>>;
  totais: { valorDivergente: number; valorSistema: number; valorStone: number };
  chaves: number;
  lojasComStone: number;
};

export type Situacao =
  | 'confere'
  | 'confere_com_nota'
  | 'sem_transacao'
  | 'sem_venda'
  | 'valor_diferente'
  | 'estornada_na_maquininha'
  | 'estornada_so_no_sistema'
  | 'estornada_nos_dois'
  | 'cancelada_na_maquininha';

export type PagamentoDetalhe = {
  id: string;
  venda: string;
  valor: number;
  tipo: 'credito' | 'debito';
  metodo: string;
  bandeira: string | null;
  parcelas: number | null;
  hora: string | null;
  horaVenda: string | null;
  vendaCancelada: boolean;
  vendedora: string | null;
  cliente: string | null;
  obrigatorio?: boolean;
};

export type TransacaoDetalhe = {
  id: string;
  nsu: string;
  valorCapturado: number;
  valorCancelado: number;
  tipo: string;
  bandeira: string | null;
  parcelas: number | null;
  hora: string | null;
  finalCartao: string | null;
  autorizacao: string | null;
  terminal: string | null;
  stoneCode: string;
  taxa: number | null;
  valorLiquido: number | null;
  previsaoPagamento: string | null;
};

export type LinhaDetalhe = {
  situacao: Situacao;
  valorSistema: number | null;
  valorMaquininha: number | null;
  diferenca: number;
  notas: string[];
  pagamento: PagamentoDetalhe | null;
  transacao: TransacaoDetalhe | null;
};

export type ArquivoDia = {
  stoneCode: string;
  status: string;
  capturas?: number;
  erro: string | null;
  baixadoEm: string | null;
  ultimaTentativa?: string | null;
};

export type Detalhe = {
  storeCode: string;
  storeName: string;
  dia: string;
  diaCurto: string;
  status: StatusDia;
  totais: {
    sistema: { qtd: number; valor: number };
    maquininha: { qtd: number; valor: number };
    valorDivergente: number;
  };
  contagem: { confere: number; atencao: number; divergencia: number; semTransacao: number; semVenda: number } | null;
  frases: string[];
  stoneCodes: string[];
  arquivos: ArquivoDia[];
  linhas: LinhaDetalhe[];
  revisadoEm: string | null;
  revisadoPor: string | null;
  revisadoNota: string | null;
};

export type Integracao = {
  ligado: boolean;
  chaves: number;
  carga: { rodando: boolean; inicio?: string; fim?: string; feitos: number; total: number; erros: string[] };
  lojas: { code: string; nome: string; tipo: string; stoneCodes: string[] }[];
  whats?: { ativo: boolean; destinos: string[]; hora: number };
  arquivos: (ArquivoDia & { storeCode: string | null; dia: string; cancelamentos: number })[];
};

type Tom = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export const STATUS: Record<StatusDia, { rotulo: string; tom: Tom; ordem: number }> = {
  divergente: { rotulo: 'Divergência', tom: 'danger', ordem: 0 },
  erro_arquivo: { rotulo: 'Erro no arquivo da Stone', tom: 'danger', ordem: 1 },
  atencao: { rotulo: 'Atenção', tom: 'warning', ordem: 2 },
  aguardando_arquivo: { rotulo: 'Aguardando a Stone', tom: 'info', ordem: 3 },
  sem_stone: { rotulo: 'Sem StoneCode', tom: 'muted', ordem: 4 },
  em_andamento: { rotulo: 'Hoje — confere amanhã', tom: 'muted', ordem: 5 },
  confere: { rotulo: 'Bate', tom: 'success', ordem: 6 },
  sem_movimento: { rotulo: 'Sem venda no cartão', tom: 'muted', ordem: 7 },
};

export const SITUACAO: Record<Situacao, { rotulo: string; tom: Tom }> = {
  sem_transacao: { rotulo: 'Venda sem transação na Stone', tom: 'danger' },
  sem_venda: { rotulo: 'Transação na Stone sem venda no sistema', tom: 'danger' },
  valor_diferente: { rotulo: 'Valor diferente', tom: 'danger' },
  estornada_na_maquininha: { rotulo: 'Estornada só na maquininha', tom: 'danger' },
  estornada_so_no_sistema: { rotulo: 'Estornada só no sistema', tom: 'danger' },
  confere_com_nota: { rotulo: 'Confere, com observação', tom: 'warning' },
  confere: { rotulo: 'Confere', tom: 'success' },
  estornada_nos_dois: { rotulo: 'Estornada nos dois lados', tom: 'muted' },
  cancelada_na_maquininha: { rotulo: 'Passada e cancelada na maquininha', tom: 'muted' },
};

export const TOM_TEXTO: Record<Tom, string> = {
  success: 'text-oo-success',
  warning: 'text-oo-warning',
  danger: 'text-oo-danger',
  info: 'text-oo-info',
  muted: 'text-oo-muted',
};

export const TOM_PONTO: Record<Tom, string> = {
  success: 'bg-oo-success',
  warning: 'bg-oo-warning',
  danger: 'bg-oo-danger',
  info: 'bg-oo-info',
  muted: 'border-[1.5px] border-oo-muted bg-transparent',
};

export const reais = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Datas SEMPRE em Brasília — `toISOString()` puro vira o dia seguinte depois das 21h. */
export function hojeBr(): string {
  return new Date(Date.now() - 3 * 60 * 60_000).toISOString().slice(0, 10);
}

export function diaMais(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function inicioDoMesBr(): string {
  return `${hojeBr().slice(0, 8)}01`;
}

export function tipoCartao(tipo: string | null | undefined, parcelas?: number | null): string {
  if (tipo === 'debito') return 'Débito';
  if (tipo === 'credito') return parcelas && parcelas > 1 ? `Crédito ${parcelas}x` : 'Crédito';
  if (tipo === 'voucher') return 'Voucher';
  return tipo || '—';
}

export function dataBr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

export function dataHoraBr(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
