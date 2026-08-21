/**
 * Tipos da ficha do produto — compartilhados entre `/retaguarda/produto-master`
 * (a tela antiga) e `/retaguarda/produtos` (a nova). Extraídos em 21/08/2026,
 * sem mudança de forma.
 */
import type { FotoCor } from '@/components/FotosDaCor';

export type SkuRow = {
  codigo: string;
  ref: string;
  descricao: string;
  marca: string | null;
  cor: string;
  tamanho: string;
  preco: number | null;
  estoque: number | null;
  custo?: number | null;
  margem?: number | null;
  estoqueLojas?: Record<string, number>;
};

export type AtributoRef = { id: string; nome: string };

export type Grade = { id: string; nome: string; linhas: unknown[] };

export type FichaCor = {
  cor: string;
  tituloComercial: string | null;
  youtubeUrl: string | null;
  statusPublicacao: string;
  fotos: FotoCor[];
  /** Bolinha do seletor de cor do site — ver <FotosDaCor>. */
  swatchTipo: 'cor' | 'foto';
  corHex: string | null;
  swatchFocoX: number | null;
  swatchFocoY: number | null;
};

export type Ficha = {
  ref: string;
  marca: string;
  nomeCurto: string | null;
  descricao: string | null;
  tecidoId: string | null;
  colecaoId: string | null;
  ocasioes: AtributoRef[];
  modelagens: AtributoRef[];
  gradeMedidasId: string | null;
  elasticidade: string | null;
  cores: FichaCor[];
};

/** Uma peça da cascata: REF + MARCA + COR, com seus tamanhos. */
export type Produto = {
  chave: string;
  ref: string;
  marca: string;
  cor: string;
  nomeCurto: string;
  precos: number[];
  skus: SkuRow[];
};

export const STATUS_LABEL: Record<string, { texto: string; cor: string }> = {
  publicado: { texto: 'No ar', cor: 'bg-green-100 text-green-800' },
  pronto: { texto: 'Pronto pra publicar', cor: 'bg-sky-100 text-sky-800' },
  sem_fotos: { texto: 'Faltam fotos', cor: 'bg-amber-100 text-amber-800' },
  nao_publicar: { texto: 'Fora do site', cor: 'bg-slate-100 text-slate-600' },
};

/**
 * Transferência JÁ AUTORIZADA e ainda não concluída — o que responde
 * "essa peça eu já pedi?". Vem de /realignment/pendencias e cobre TODA origem
 * (realinhamento automático, tela de realinhamento, esta ficha).
 *
 * `pending` = pedido, peça ainda na loja (estoque não baixou).
 * `in_transit` = já saiu (origem já baixou; falta a entrada no destino).
 */
export type Pendencia = {
  codigo: string;
  de: string;
  para: string;
  qty: number;
  status: 'pending' | 'in_transit';
};

/**
 * Um movimento = UMA peça saindo de uma loja pra outra. Arrastar de novo
 * empilha outra linha; é assim que "de 1 em 1" fica literal e o desfazer
 * volta exatamente um passo.
 */
export type Movimento = {
  codigo: string;
  ref: string;
  cor: string;
  tamanho: string;
  desc: string;
  de: string;
  para: string;
  /** Estoque na origem ANTES de qualquer movimento — o backend pede. */
  estoqueOrigemAntes: number;
};

export const ELASTICIDADE_LABEL: [string, string][] = [
  ['', '— não informado —'],
  ['nao', 'Não estica'],
  ['pouco', 'Estica pouco'],
  ['muito', 'Estica muito'],
];
export type ArvoreSite = {
  categorias: Array<{ slug: string; nome: string; ativo: boolean }>;
  subcategorias: Array<{ slug: string; nome: string; pai: string; ativo: boolean }>;
};

export type VitrinesPeca = {
  ok?: boolean;
  erro?: string;
  refs?: string[];
  publicado?: boolean;
  categorias: string[];
  subcategorias: string[];
  principal?: string | null;
};
