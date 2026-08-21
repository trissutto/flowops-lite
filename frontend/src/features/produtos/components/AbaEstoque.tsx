'use client';

/**
 * Aba ESTOQUE da ficha — a grade cor × tamanho por loja, e o ajuste.
 *
 * É a ABA INICIAL: quando o dono abre uma peça, a primeira pergunta é onde ela
 * está.
 *
 * ⚠️ MOTIVO OBRIGATÓRIO. O backend (`/products-editor/movimentar`) sempre
 * exigiu — "Motivo é obrigatório em todo movimento" — mas a tela antiga
 * mandava a constante `'AJUSTE'` em todo ajuste, o que passava na validação e
 * enchia a auditoria de linhas que não explicam nada. Aqui a pessoa escolhe, e
 * o botão de salvar fica travado até escolher: sem motivo de verdade, o
 * histórico vira ruído em três meses.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Select, Table, TabelaVazia, Td, Th, Tr } from '@/components/ui';
import type { SkuRow } from '../types';

/**
 * Motivos de ajuste. Texto do jeito que a loja fala — quem lê a auditoria
 * depois precisa entender sem manual.
 */
const MOTIVOS: Array<{ valor: string; label: string }> = [
  { valor: '', label: '— escolha o motivo —' },
  { valor: 'CONTAGEM', label: 'Contagem física — a prateleira tem outra quantidade' },
  { valor: 'AVARIA', label: 'Peça avariada — saiu de circulação' },
  { valor: 'PERDA', label: 'Perda ou furto' },
  { valor: 'DEVOLUCAO_FORNECEDOR', label: 'Devolvida ao fornecedor' },
  { valor: 'ENTRADA_NAO_LANCADA', label: 'Entrada que não foi lançada' },
  { valor: 'CORRECAO_SISTEMA', label: 'Correção de erro do sistema' },
];

export default function AbaEstoque({
  skus,
  lojaNomes,
  podeAjustar,
  onMudou,
}: {
  skus: SkuRow[];
  lojaNomes: Map<string, string>;
  /** só matriz ajusta; loja lê */
  podeAjustar: boolean;
  onMudou: () => void;
}) {
  const [ajustes, setAjustes] = useState<Record<string, number>>({});
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  /** Lojas que aparecem: as que têm estoque de alguma variação. */
  const lojas = useMemo(() => {
    const set = new Set<string>();
    for (const s of skus) for (const l of Object.keys(s.estoqueLojas ?? {})) set.add(l);
    return [...set].sort();
  }, [skus]);

  const linhas = useMemo(
    () => [...skus].sort(
      (a, b) => (a.cor || '').localeCompare(b.cor || '') || (a.tamanho || '').localeCompare(b.tamanho || ''),
    ),
    [skus],
  );

  const definirAjuste = useCallback((codigo: string, loja: string, base: number, valor: number) => {
    const chave = `${codigo}|${loja}`;
    setAjustes((a) => {
      const proximo = { ...a };
      /* voltou pro valor original = não é mais ajuste */
      if (!Number.isFinite(valor) || valor < 0 || valor === base) delete proximo[chave];
      else proximo[chave] = valor;
      return proximo;
    });
  }, []);

  const pendentes = Object.entries(ajustes);

  async function salvar() {
    if (!pendentes.length || !motivo) return;
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const porCodigo = new Map(skus.map((s) => [s.codigo, s]));
      const movimentos = pendentes.flatMap(([chave, novo]) => {
        const [codigo, loja] = chave.split('|');
        const base = porCodigo.get(codigo)?.estoqueLojas?.[loja] ?? 0;
        const delta = novo - base;
        if (!delta) return [];
        return [{
          codigo, loja,
          qtd: Math.abs(delta),
          tipo: (delta > 0 ? 'entrada' : 'saida') as 'entrada' | 'saida',
          motivo,
        }];
      });
      if (!movimentos.length) { setSalvando(false); return; }

      const r = await api<{ aplicados?: number; total?: number }>('/products-editor/movimentar', {
        method: 'POST',
        body: JSON.stringify({ movimentos }),
      });
      setAjustes({});
      setMotivo('');
      setAviso(
        `${r?.aplicados ?? movimentos.length} de ${r?.total ?? movimentos.length} ajuste(s) gravado(s). ` +
        'A aba Histórico já mostra quem fez e por quê.',
      );
      onMudou();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar os ajustes.');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {aviso && (
        <Card className="border-ok bg-ok-soft px-4 py-3 text-[13px] text-ok">{aviso}</Card>
      )}
      {erro && (
        <Card className="border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">{erro}</Card>
      )}

      <Table>
        <thead>
          <tr>
            <Th>Cor</Th>
            <Th>Tam.</Th>
            {lojas.map((l) => (
              <Th key={l} align="right">{lojaNomes.get(l) || l}</Th>
            ))}
            <Th align="right">Total</Th>
          </tr>
        </thead>
        <tbody>
          {!linhas.length && (
            <TabelaVazia colSpan={lojas.length + 3}>
              Esta peça não tem variação cadastrada.
            </TabelaVazia>
          )}
          {linhas.map((s) => {
            const total = Object.values(s.estoqueLojas ?? {}).reduce((a, b) => a + b, 0);
            return (
              <Tr key={s.codigo} estado={total > 0 ? undefined : 'warn'}>
                <Td className="font-medium">{s.cor || '—'}</Td>
                <Td className="text-ink-soft">{s.tamanho || '—'}</Td>
                {lojas.map((l) => {
                  const base = s.estoqueLojas?.[l] ?? 0;
                  const chave = `${s.codigo}|${l}`;
                  const novo = ajustes[chave];
                  const mudou = novo !== undefined;
                  return (
                    <Td key={l} align="right" num>
                      {podeAjustar ? (
                        <input
                          type="number"
                          min={0}
                          aria-label={`Estoque de ${s.cor} ${s.tamanho} em ${lojaNomes.get(l) || l}`}
                          defaultValue={base}
                          onChange={(e) => definirAjuste(s.codigo, l, base, Number(e.target.value))}
                          className={
                            'w-16 rounded-field border bg-surface px-2 py-1 text-right text-[13px] tabular-nums ' +
                            'focus:outline-none focus:ring-2 focus:ring-action ' +
                            (mudou ? 'border-warn text-warn font-bold' : 'border-line text-ink')
                          }
                        />
                      ) : (
                        <span className={base > 0 ? 'text-ink' : 'text-ink-faint'}>{base}</span>
                      )}
                    </Td>
                  );
                })}
                <Td align="right" num className="font-bold">
                  {total > 0 ? total : <Badge tom="warn">zerado</Badge>}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>

      {podeAjustar && pendentes.length > 0 && (
        <Card className="flex flex-wrap items-end gap-3 border-warn bg-warn-soft p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warn">
            <AlertTriangle className="h-4 w-4" />
            {pendentes.length} quantidade(s) alterada(s)
          </div>
          <div className="min-w-[280px] flex-1">
            <Select
              rotulo="Por que está mudando?"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            >
              {MOTIVOS.map((m) => (
                <option key={m.valor} value={m.valor}>{m.label}</option>
              ))}
            </Select>
          </div>
          <Button variant="primary" onClick={salvar} disabled={!motivo || salvando}>
            <Save className="h-3.5 w-3.5" />
            {salvando ? 'Gravando…' : 'Gravar ajuste'}
          </Button>
          <p className="w-full text-[12px] text-ink-soft">
            O ajuste mexe no estoque agora e fica registrado com o seu nome. Sem motivo escolhido,
            não dá pra gravar.
          </p>
        </Card>
      )}

      {!podeAjustar && (
        <p className="px-1 text-[12px] text-ink-faint">
          Ajustar estoque é da matriz. Aqui a grade é só leitura.
        </p>
      )}
    </div>
  );
}
