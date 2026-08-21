'use client';

/**
 * Aba ESTOQUE da ficha — a grade cor × tamanho por loja.
 *
 * É a ABA INICIAL: quando o dono abre uma peça, a primeira pergunta é onde ela
 * está.
 *
 * ── DUAS CORREÇÕES DE 21/08, depois de ver a tela em produção ──
 *
 * 1. LEITURA PRIMEIRO, AJUSTE POR BOTÃO. A primeira versão punha um `<input>`
 *    em toda célula: 10 lojas × 30 variações = 300 caixinhas, e o número — que
 *    é o que se vem olhar — sumia no meio da moldura. Agora a grade é texto, e
 *    ajustar é um modo em que você entra de propósito. É o mesmo motivo do
 *    `modo: 'mover' | 'ajustar'` que a tela antiga já tinha.
 *
 * 2. ZERO NÃO É ALARME. A primeira versão dava faixa âmbar em toda linha sem
 *    estoque — mas tamanho esgotado é o normal de uma peça de moda, não
 *    pendência. Alarme falso mata a confiança na faixa inteira (foi o que
 *    derrubou a tarefa "Gerar etiqueta" em 11/08). Agora só ESTOQUE NEGATIVO
 *    ganha faixa, porque negativo é defeito de verdade: alguém vendeu o que
 *    não tinha, ou uma baixa rodou duas vezes.
 *
 * ⚠️ MOTIVO OBRIGATÓRIO no ajuste. O backend sempre exigiu — "Motivo é
 * obrigatório em todo movimento" — mas a tela antiga mandava a constante
 * 'AJUSTE' sempre, o que passava na validação e enchia a auditoria de linha que
 * não explica nada.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, Save, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Select, Table, TabelaVazia, Td, Th, Tr } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { SkuRow } from '../types';

const MOTIVOS: Array<{ valor: string; label: string }> = [
  { valor: '', label: '— escolha o motivo —' },
  { valor: 'CONTAGEM', label: 'Contagem física — a prateleira tem outra quantidade' },
  { valor: 'AVARIA', label: 'Peça avariada — saiu de circulação' },
  { valor: 'PERDA', label: 'Perda ou furto' },
  { valor: 'DEVOLUCAO_FORNECEDOR', label: 'Devolvida ao fornecedor' },
  { valor: 'ENTRADA_NAO_LANCADA', label: 'Entrada que não foi lançada' },
  { valor: 'CORRECAO_SISTEMA', label: 'Correção de erro do sistema' },
];

/** Colunas que ficam paradas quando a grade rola de lado. */
const FIXA = 'sticky bg-surface z-10';

export default function AbaEstoque({
  skus,
  lojas,
  lojaNomes,
  podeAjustar,
  onMudou,
}: {
  skus: SkuRow[];
  /** TODAS as lojas da rede, na ordem — não só as que têm peça */
  lojas: string[];
  lojaNomes: Map<string, string>;
  podeAjustar: boolean;
  onMudou: () => void;
}) {
  const [editando, setEditando] = useState(false);
  const [ajustes, setAjustes] = useState<Record<string, number>>({});
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const linhas = useMemo(
    () => [...skus].sort(
      (a, b) => (a.cor || '').localeCompare(b.cor || '')
        || (a.tamanho || '').localeCompare(b.tamanho || '', 'pt-BR', { numeric: true }),
    ),
    [skus],
  );

  /** Total da rede por variação. */
  const totalDe = useCallback(
    (s: SkuRow) => Object.values(s.estoqueLojas ?? {}).reduce((a, b) => a + b, 0),
    [],
  );

  /** Negativo em qualquer loja = defeito. É a ÚNICA coisa que ganha faixa. */
  const temNegativo = useCallback(
    (s: SkuRow) => Object.values(s.estoqueLojas ?? {}).some((q) => q < 0),
    [],
  );

  const negativas = linhas.filter(temNegativo).length;

  const definirAjuste = useCallback((codigo: string, loja: string, base: number, valor: number) => {
    const chave = `${codigo}|${loja}`;
    setAjustes((a) => {
      const proximo = { ...a };
      if (!Number.isFinite(valor) || valor < 0 || valor === base) delete proximo[chave];
      else proximo[chave] = valor;
      return proximo;
    });
  }, []);

  const pendentes = Object.entries(ajustes);

  function cancelar() {
    setEditando(false);
    setAjustes({});
    setMotivo('');
  }

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
      cancelar();
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
      <div className="flex flex-wrap items-center gap-3">
        {negativas > 0 && (
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-crit">
            <AlertTriangle className="h-4 w-4" />
            {negativas} variação(ões) com estoque negativo
          </span>
        )}
        {podeAjustar && !editando && (
          <Button variant="primary" className="ml-auto" onClick={() => setEditando(true)}>
            <Pencil className="h-3.5 w-3.5" /> Ajustar estoque
          </Button>
        )}
        {editando && (
          <Button variant="ghost" className="ml-auto" onClick={cancelar}>
            <X className="h-3.5 w-3.5" /> Cancelar
          </Button>
        )}
      </div>

      {aviso && <Card className="border-ok bg-ok-soft px-4 py-3 text-[13px] text-ok">{aviso}</Card>}
      {erro && <Card className="border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">{erro}</Card>}

      <Table>
        <thead>
          <tr>
            <Th className={cn(FIXA, 'left-0')}>Cor</Th>
            <Th className={cn(FIXA, 'left-[104px]')}>Tam.</Th>
            {/* a rede vem ANTES das lojas: é o número que se vem olhar, e no fim
                da linha ele saía da tela nas redes com muitas lojas */}
            <Th align="right" className={cn(FIXA, 'left-[160px]')}>Rede</Th>
            {lojas.map((l) => (
              <Th key={l} align="right" className="whitespace-nowrap">
                {lojaNomes.get(l) || l}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!linhas.length && (
            <TabelaVazia colSpan={lojas.length + 3}>
              Esta peça não tem variação cadastrada.
            </TabelaVazia>
          )}
          {linhas.map((s) => {
            const total = totalDe(s);
            return (
              <Tr key={s.codigo} estado={temNegativo(s) ? 'crit' : undefined}>
                <Td className={cn(FIXA, 'left-0 font-medium')}>{s.cor || '—'}</Td>
                <Td className={cn(FIXA, 'left-[104px] text-ink-soft')}>{s.tamanho || '—'}</Td>
                <Td
                  align="right"
                  num
                  className={cn(
                    FIXA, 'left-[160px] border-r border-line font-bold',
                    total > 0 ? 'text-ink' : 'text-ink-faint',
                  )}
                >
                  {total}
                </Td>

                {lojas.map((l) => {
                  const base = s.estoqueLojas?.[l] ?? 0;
                  const chave = `${s.codigo}|${l}`;
                  const mudou = ajustes[chave] !== undefined;
                  return (
                    <Td key={l} align="right" num>
                      {editando ? (
                        <input
                          type="number"
                          min={0}
                          aria-label={`Estoque de ${s.cor} ${s.tamanho} em ${lojaNomes.get(l) || l}`}
                          defaultValue={base}
                          onChange={(e) => definirAjuste(s.codigo, l, base, Number(e.target.value))}
                          className={cn(
                            'w-14 rounded-field border bg-surface px-1.5 py-1 text-right text-[13px] tabular-nums',
                            'focus:outline-none focus:ring-2 focus:ring-action',
                            mudou ? 'border-warn font-bold text-warn' : 'border-line text-ink',
                          )}
                        />
                      ) : (
                        /* zero fica apagado pra o número que existe saltar */
                        <span
                          className={cn(
                            base < 0 ? 'font-bold text-crit'
                              : base > 0 ? 'text-ink'
                              : 'text-ink-faint',
                          )}
                        >
                          {base}
                        </span>
                      )}
                    </Td>
                  );
                })}
              </Tr>
            );
          })}
        </tbody>
      </Table>

      {editando && pendentes.length > 0 && (
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

      <p className="px-1 text-[12px] leading-relaxed text-ink-faint">
        Todas as lojas da rede aparecem, mesmo sem peça — coluna vazia é informação.{' '}
        {negativas > 0 && (
          <>
            <Badge tom="crit">Faixa vermelha</Badge> é estoque negativo: alguém vendeu o que não
            tinha, ou uma baixa rodou duas vezes. Esgotado não ganha faixa, porque esgotar é normal.
          </>
        )}
        {!podeAjustar && ' Ajustar estoque é da matriz; aqui a grade é só leitura.'}
      </p>
    </div>
  );
}
