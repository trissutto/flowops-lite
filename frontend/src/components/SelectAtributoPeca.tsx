'use client';

/**
 * Select de classificação da peça (ocasião · tecido · modelagem · coleção).
 *
 * Usado no pedido de compra e na tela master — os dois precisam do MESMO
 * comportamento, então mora aqui em vez de duplicado nas duas telas.
 *
 * Duas decisões que valem registro:
 *
 * 1. "+ novo" ao lado do rótulo, igual GRUPO/SUBGRUPO no pedido de compra.
 *    Sem isso, classificar exige abrir outra tela, cadastrar e voltar — e o
 *    que acontece na prática é a pessoa deixar em branco.
 *
 * 2. Múltiplo NÃO usa <select multiple>: aquilo fica três linhas mais alto que
 *    os vizinhos e exige ctrl+clique, que ninguém acerta no balcão. Aqui é um
 *    select normal que empilha chips embaixo, então a linha só cresce quando
 *    tem escolha feita.
 */

import { useState } from 'react';
import { api } from '@/lib/api';

export type TipoAtributo = 'ocasiao' | 'tecido' | 'modelagem' | 'colecao';
export type Atributo = { id: string; nome: string };
export type AtributosPorTipo = Partial<Record<TipoAtributo, Atributo[]>>;

/** Rótulo no singular — tirar o "s" não funciona em português ("ocasiões"). */
const SINGULAR: Record<TipoAtributo, string> = {
  ocasiao: 'ocasião',
  tecido: 'tecido',
  modelagem: 'modelagem',
  colecao: 'coleção',
};

export function SelectAtributoPeca({
  tipo, label, opcoes, value, values, onChange, onChangeMany, onCriado, multiplo,
}: {
  tipo: TipoAtributo;
  label: string;
  opcoes?: Atributo[];
  value?: string;
  values?: string[];
  onChange?: (v: string) => void;
  onChangeMany?: (v: string[]) => void;
  /** Avisa a tela que a lista mudou, pra ela recarregar o cadastro. */
  onCriado?: (tipo: TipoAtributo, novo: Atributo) => void;
  multiplo?: boolean;
}) {
  const [criando, setCriando] = useState(false);
  const lista = opcoes ?? [];
  const escolhidos = values ?? [];
  const disponiveis = multiplo ? lista.filter((o) => !escolhidos.includes(o.id)) : lista;
  const vazio = lista.length === 0;

  async function criar() {
    const nome = prompt(`Nome ${tipo === 'tecido' ? 'do novo' : 'da nova'} ${SINGULAR[tipo]}:`)?.trim();
    if (!nome) return;
    setCriando(true);
    try {
      const novo = await api<Atributo>(`/atributos-peca/${tipo}`, {
        method: 'POST',
        body: JSON.stringify({ nome }),
      });
      onCriado?.(tipo, novo);
      // Já deixa escolhido: quem cadastrou na hora queria usar agora.
      if (multiplo) onChangeMany?.([...escolhidos, novo.id]);
      else onChange?.(novo.id);
    } catch (e: any) {
      alert(`Erro ao criar ${SINGULAR[tipo]}: ` + (e?.message || ''));
    } finally {
      setCriando(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-1">
        <label className="text-[10px] font-bold text-slate-600 uppercase">{label}</label>
        {onCriado && (
          <button
            type="button"
            onClick={() => void criar()}
            disabled={criando}
            title={`Cadastrar ${SINGULAR[tipo]} sem sair da tela`}
            className="text-[10px] font-bold text-violet-600 hover:text-violet-800 disabled:opacity-40"
          >
            {criando ? '...' : '+ novo'}
          </button>
        )}
      </div>

      <select
        // No modo múltiplo o select é só o "adicionar": volta pro vazio a cada
        // escolha, e o que foi escolhido vira chip.
        value={multiplo ? '' : (value ?? '')}
        disabled={vazio || (multiplo && disponiveis.length === 0)}
        title={vazio ? 'Nada cadastrado ainda — use o "+ novo" ao lado' : undefined}
        onChange={(e) => {
          if (!multiplo) { onChange?.(e.target.value); return; }
          if (e.target.value) onChangeMany?.([...escolhidos, e.target.value]);
        }}
        className={`w-full px-2 py-2 border rounded text-sm bg-white disabled:opacity-50 disabled:cursor-not-allowed ${
          multiplo && escolhidos.length > 0 ? 'border-violet-400' : ''
        }`}
      >
        {/* Com escolha feita o campo TEM que dizer isso. Só "+ adicionar" faz
            parecer que a escolha não entrou — o que a pessoa vê é o select
            inalterado e uns chips soltos embaixo. */}
        <option value="">
          {!multiplo
            ? '— nenhum —'
            : escolhidos.length === 0
              ? '+ adicionar'
              : `${escolhidos.length} escolhida(s) — + adicionar outra`}
        </option>
        {disponiveis.map((o) => (
          <option key={o.id} value={o.id}>{o.nome}</option>
        ))}
      </select>

      {multiplo && escolhidos.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {escolhidos.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 text-[11px] bg-violet-50 text-violet-800 border border-violet-200 rounded px-1.5 py-0.5"
            >
              {lista.find((o) => o.id === id)?.nome ?? id}
              <button
                type="button"
                aria-label="Remover"
                onClick={() => onChangeMany?.(escolhidos.filter((x) => x !== id))}
                className="text-violet-500 hover:text-violet-900 leading-none"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
