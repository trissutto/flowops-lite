'use client';

/**
 * /retaguarda/produtos — a porta de entrada do catálogo.
 *
 * DESENHO (dono, 21/08/2026): a tela em branco mostra SÓ A BUSCA. Nada de
 * lista antes de você pedir — quem abre aqui já sabe qual peça quer, e uma
 * lista de 65 mil variações no carregamento não ajuda ninguém.
 *
 * ⚠️ REF SOZINHA NÃO IDENTIFICA. REF numérica é reciclada entre fornecedores,
 * então cada resultado leva REF **e** MARCA pra ficha. Quando a mesma REF
 * aparece com duas marcas, as duas aparecem como linhas separadas — é a
 * pessoa que sabe qual é a peça dela.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, PackageSearch, Search } from 'lucide-react';
import {
  Badge, Button, Card, CardHead, Table, TabelaVazia, Td, Th, Tr,
} from '@/components/ui';
import {
  agruparPorPeca, buscarPecas, classeDaRef, type Peca,
} from '@/features/produtos/busca';

function brl(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function faixaDePreco(p: Peca): string {
  if (p.precoMin == null) return '—';
  if (p.precoMax == null || p.precoMin === p.precoMax) return brl(p.precoMin);
  return `${brl(p.precoMin)} – ${brl(p.precoMax)}`;
}

function ProdutosBuscaConteudo() {
  const router = useRouter();
  const params = useSearchParams();

  const [termo, setTermo] = useState('');
  const [pecas, setPecas] = useState<Peca[] | null>(null);
  const [classificacao, setClassificacao] = useState<Array<{ ref: string; tipoProduto: number }>>([]);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const buscar = useCallback(async (q: string) => {
    setBuscando(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await buscarPecas(q);
      const agrupadas = agruparPorPeca(r.rows);
      setPecas(agrupadas);
      setClassificacao(r.classificacao || []);
      setAviso(r.aviso);
      if (!agrupadas.length) setErro(`Nada encontrado pra "${q}".`);
      /* uma peça só: vai direto pra ficha, sem clique de cortesia */
      if (agrupadas.length === 1) {
        const p = agrupadas[0];
        router.push(`/retaguarda/produtos/${encodeURIComponent(p.ref)}?marca=${encodeURIComponent(p.marca)}`);
      }
    } catch (e: any) {
      setErro(e?.message || 'A busca falhou.');
      setPecas([]);
    } finally {
      setBuscando(false);
    }
  }, [router]);

  /**
   * ⚠️ O termo da URL é lido em useEffect, NUNCA no inicializador do useState:
   * na navegação client-side do Next o componente monta ANTES da URL trocar, e
   * a busca sairia vazia.
   */
  useEffect(() => {
    const q = params.get('q');
    if (q && q.trim().length >= 2) {
      setTermo(q);
      void buscar(q);
    }
  }, [params, buscar]);

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    const q = termo.trim();
    if (q.length < 2) { setErro('Digite ao menos 2 caracteres.'); return; }
    void buscar(q);
  }

  return (
    <div className="min-h-screen bg-ground">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link
            href="/retaguarda"
            title="Voltar"
            className="rounded-field p-2 text-ink-soft transition-colors hover:bg-line-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <PackageSearch className="h-5 w-5 text-ink-soft" />
          <h1 className="text-[17px] font-extrabold tracking-[-.02em] text-ink">Produtos</h1>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
        <Card className="p-4">
          <form onSubmit={enviar} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-[240px] flex-1 flex-col gap-1">
              <label
                htmlFor="busca-produto"
                className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-soft"
              >
                REF, código, EAN ou pedaço da descrição
              </label>
              <input
                id="busca-produto"
                autoFocus
                value={termo}
                onChange={(e) => setTermo(e.target.value)}
                placeholder="13050, 7891234567890, vestido bordado…"
                className="w-full rounded-field border border-line bg-surface px-3 py-2 text-[14px] text-ink placeholder:text-ink-faint focus:border-action focus:outline-none focus:ring-2 focus:ring-action"
              />
            </div>
            <Button type="submit" variant="primary" size="lg" disabled={buscando}>
              <Search className="h-4 w-4" />
              {buscando ? 'Buscando…' : 'Buscar'}
            </Button>
          </form>
          <p className="mt-2 text-[12px] text-ink-faint">
            Pode bipar a etiqueta direto no campo. Buscar por REF e cor junto funciona; se a cor
            não existir naquela REF, a tela avisa em vez de dizer que não achou nada.
          </p>
        </Card>

        {aviso && (
          <Card className="border-warn bg-warn-soft px-4 py-3 text-[13px] text-warn">{aviso}</Card>
        )}
        {erro && (
          <Card className="border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">{erro}</Card>
        )}

        {pecas !== null && pecas.length > 0 && (
          <Card>
            <CardHead titulo={`${pecas.length} peça(s)`}>
              Cada linha é uma peça — REF mais marca. A mesma REF de fornecedores diferentes
              aparece duas vezes, porque são peças diferentes.
            </CardHead>
            <div className="p-4">
              <Table>
                <thead>
                  <tr>
                    <Th>REF</Th>
                    <Th>Peça</Th>
                    <Th>Marca</Th>
                    <Th>Cores</Th>
                    <Th align="right">Preço</Th>
                    <Th align="right">Estoque</Th>
                  </tr>
                </thead>
                <tbody>
                  {pecas.map((p) => (
                    <Tr key={p.chave} estado={p.estoque > 0 ? undefined : 'warn'}>
                      <Td>
                        <Link
                          href={`/retaguarda/produtos/${encodeURIComponent(p.ref)}?marca=${encodeURIComponent(p.marca)}`}
                          className="font-mono text-[13px] font-bold text-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                        >
                          {p.ref}
                        </Link>
                      </Td>
                      <Td>
                        <span className="font-medium">{p.nome}</span>
                        <Badge
                          tom={classeDaRef(p.ref, classificacao) === 'BASICO' ? 'neutro' : 'ok'}
                          className="ml-2"
                        >
                          {classeDaRef(p.ref, classificacao)}
                        </Badge>
                      </Td>
                      <Td className="text-ink-soft">{p.marca || '—'}</Td>
                      <Td className="text-ink-soft">
                        {p.cores.length} · {p.cores.slice(0, 3).join(', ')}
                        {p.cores.length > 3 ? '…' : ''}
                      </Td>
                      <Td align="right" num>{faixaDePreco(p)}</Td>
                      <Td align="right" num className="font-semibold">
                        {p.estoque > 0 ? p.estoque : <Badge tom="warn">zerado</Badge>}
                      </Td>
                    </Tr>
                  ))}
                  {!pecas.length && <TabelaVazia colSpan={6}>Nada por aqui.</TabelaVazia>}
                </tbody>
              </Table>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}

/**
 * `useSearchParams()` exige limite de Suspense pra rota estática no Next 14 —
 * mesmo padrão de /beta/clientes.
 */
export default function ProdutosBuscaPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[320px] items-center justify-center gap-2 text-[13px] text-ink-soft">
          <Search className="h-4 w-4" /> Abrindo a busca…
        </div>
      }
    >
      <ProdutosBuscaConteudo />
    </Suspense>
  );
}
