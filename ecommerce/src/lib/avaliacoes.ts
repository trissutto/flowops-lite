import 'server-only';
import { api } from '@/lib/api';

/**
 * AVALIAÇÕES — a ponte entre o site e o FlowOps.
 *
 * A REGRA mora inteira no backend (`PosVendaService`): quem pode avaliar, o que
 * vale quantos pontos, o que já foi respondido e o que aparece na vitrine. Aqui
 * é só a tela. Duas telas com duas regras seria duas regras divergindo sozinhas
 * — a lição que o cupom já deu (BFF calculava um desconto, backend cobrava
 * outro).
 */

export interface PecaDoConvite {
  chave: string;
  refBase: string;
  cor: string | null;
  tamanho: string | null;
  nome: string;
  slug: string | null;
  foto: string | null;
  avaliada: {
    nota: number;
    comentario: string | null;
    temFoto: boolean;
    status: 'pending' | 'approved' | 'rejected';
    pontos: number;
  } | null;
}

export interface Convite {
  token: string;
  pedido: string | null;
  cliente: string | null;
  entregueEm: string | null;
  respondidoEm: string | null;
  precisaCpf: boolean;
  regras: {
    pontosPorAvaliacao: number;
    pontosComFoto: number;
    pontosPorReal: number;
    minimoResgate: number;
  };
  saldoAtual: number;
  pecas: PecaDoConvite[];
}

export interface AvaliacaoPublica {
  id: string;
  nota: number;
  comentario: string | null;
  foto: string | null;
  cor: string | null;
  tamanho: string | null;
  autor: string | null;
  cidade: string | null;
  data: string | null;
  compraVerificada: boolean;
}

export interface ResumoAvaliacoes {
  refBase: string;
  media: number;
  total: number;
  distribuicao: Record<string, number>;
  avaliacoes: AvaliacaoPublica[];
}

/** O convite pelo token do link. `null` = link inválido, usado ou vencido. */
export async function buscarConvite(token: string): Promise<Convite | null> {
  try {
    return await api<Convite>(`/public/avaliacoes/convite/${encodeURIComponent(token)}`, {
      revalidate: 0,
    });
  } catch {
    return null;
  }
}

/**
 * As avaliações de uma peça, pra PDP.
 *
 * Cache de 5 minutos: avaliação nova passa por aprovação humana antes de
 * existir aqui, então ela nunca é urgente — e a PDP é a página mais acessada
 * do site. Falha vira bloco ausente, nunca página quebrada: a peça continua
 * vendendo sem o bloco, e não vende nenhuma se a página não abrir.
 */
export async function buscarAvaliacoesDoProduto(ref: string): Promise<ResumoAvaliacoes | null> {
  const chave = String(ref || '').trim();
  if (!chave) return null;
  try {
    const r = await api<ResumoAvaliacoes>(
      `/public/avaliacoes/produto/${encodeURIComponent(chave)}`,
      { revalidate: 300, tags: [`avaliacoes:${chave}`] },
    );
    return r?.total ? r : null;
  } catch {
    return null;
  }
}
