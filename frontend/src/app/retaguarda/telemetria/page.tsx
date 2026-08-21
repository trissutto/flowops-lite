'use client';

/**
 * /retaguarda/telemetria — quais telas são realmente usadas.
 *
 * POR QUE ESTA TELA EXISTE: "essa tela ninguém usa" era achismo. A telemetria
 * (`page_access`, ligada em 11/08/2026) grava hits, última visita e o papel de
 * quem abriu. Mas ela só tem linha pra rota que foi acessada ALGUMA vez — e a
 * rota que ninguém abriu, que é justamente a que queremos cortar, não aparece
 * em lugar nenhum. Por isso a tela cruza a API com `src/data/rotas.json`
 * (gerado por `scripts/gerar-rotas.mjs`): o silêncio vira uma linha vermelha.
 *
 * É também a primeira tela do sistema SEMÁFORO — a prova dos primitivos de
 * `@/components/ui`. Nenhuma cor arbitrária inline aqui.
 *
 * ⚠️ Sem filtro De/Até de propósito: `page_access` guarda hits acumulados e
 * uma única `lastAt`, sem série temporal. Um intervalo responderia "quais
 * telas foram vistas por último entre X e Y", que não é pergunta de ninguém. A
 * pergunta real é "há quanto tempo esta tela está em silêncio" — daí o corte
 * por dias parados. Tela com série de verdade continua usando o FiltroData.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Activity, RefreshCw, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import inventario from '@/data/rotas.json';
import {
  Badge,
  Button,
  Card,
  CardHead,
  Input,
  Numero,
  Select,
  Table,
  TabelaVazia,
  Tabs,
  Td,
  Th,
  Tr,
  type Aba,
  type EstadoLinha,
} from '@/components/ui';

interface Acesso {
  path: string;
  hits: number;
  lastAt: string;
  lastRole: string | null;
  lastStore: string | null;
}

interface Linha {
  path: string;
  hits: number;
  lastAt: string | null;
  lastRole: string | null;
  lastStore: string | null;
  diasParada: number | null;
  /** rota que responde na telemetria mas não existe mais no código */
  fantasma: boolean;
}

type AbaId = 'silencio' | 'pouco' | 'ativas' | 'fantasmas';

const DIAS_SILENCIO = 14;
const POUCO_USO = 5;

/** Área da rota: primeiro segmento. `/retaguarda/dre` → `retaguarda`. */
function areaDe(path: string): string {
  const p = path.split('/').filter(Boolean);
  return p[0] || '(raiz)';
}

function diasDesde(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function dataBr(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

export default function TelemetriaPage() {
  const [acessos, setAcessos] = useState<Acesso[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [aba, setAba] = useState<AbaId>('silencio');
  const [area, setArea] = useState('todas');
  const [busca, setBusca] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setAcessos(await api<Acesso[]>('/telemetria/paginas'));
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErro(
        msg.includes('403') || /admin/i.test(msg)
          ? 'Só admin vê a telemetria. Entre com um usuário admin pra abrir esta tela.'
          : `Não deu pra carregar a telemetria: ${msg}`,
      );
      setAcessos(null);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* Cruza o inventário do código com o que a telemetria viu. */
  const linhas = useMemo<Linha[]>(() => {
    if (!acessos) return [];
    const vistos = new Map(acessos.map((a) => [a.path, a]));
    const doCodigo: Linha[] = inventario.rotas.map((path) => {
      const a = vistos.get(path);
      return {
        path,
        hits: a?.hits ?? 0,
        lastAt: a?.lastAt ?? null,
        lastRole: a?.lastRole ?? null,
        lastStore: a?.lastStore ?? null,
        diasParada: diasDesde(a?.lastAt ?? null),
        fantasma: false,
      };
    });
    const noCodigo = new Set(inventario.rotas);
    const fantasmas: Linha[] = acessos
      .filter((a) => !noCodigo.has(a.path))
      .map((a) => ({
        path: a.path,
        hits: a.hits,
        lastAt: a.lastAt,
        lastRole: a.lastRole,
        lastStore: a.lastStore,
        diasParada: diasDesde(a.lastAt),
        fantasma: true,
      }));
    return [...doCodigo, ...fantasmas];
  }, [acessos]);

  const areas = useMemo(
    () => [...new Set(linhas.map((l) => areaDe(l.path)))].sort(),
    [linhas],
  );

  const grupos = useMemo(() => {
    const silencio = linhas.filter((l) => !l.fantasma && l.hits === 0);
    const pouco = linhas.filter(
      (l) =>
        !l.fantasma &&
        l.hits > 0 &&
        (l.hits <= POUCO_USO || (l.diasParada ?? 0) >= DIAS_SILENCIO),
    );
    const ativas = linhas.filter(
      (l) => !l.fantasma && l.hits > POUCO_USO && (l.diasParada ?? 999) < DIAS_SILENCIO,
    );
    const fantasmas = linhas.filter((l) => l.fantasma);
    return { silencio, pouco, ativas, fantasmas };
  }, [linhas]);

  const visiveis = useMemo(() => {
    const base = grupos[aba];
    const q = busca.trim().toLowerCase();
    return base
      .filter((l) => area === 'todas' || areaDe(l.path) === area)
      .filter((l) => !q || l.path.toLowerCase().includes(q))
      .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
  }, [grupos, aba, area, busca]);

  const abas: Aba<AbaId>[] = [
    { id: 'silencio', label: 'Nunca abertas', contagem: grupos.silencio.length, tom: 'crit' },
    { id: 'pouco', label: 'Quase paradas', contagem: grupos.pouco.length, tom: 'warn' },
    { id: 'ativas', label: 'Em uso', contagem: grupos.ativas.length, tom: 'ok' },
    { id: 'fantasmas', label: 'Fora do código', contagem: grupos.fantasmas.length },
  ];

  function estadoDa(l: Linha): EstadoLinha | undefined {
    if (l.fantasma) return undefined;
    if (l.hits === 0) return 'crit';
    if (l.hits <= POUCO_USO || (l.diasParada ?? 0) >= DIAS_SILENCIO) return 'warn';
    return 'ok';
  }

  return (
    <div className="min-h-screen bg-ground">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <Link
            href="/retaguarda"
            title="Voltar"
            className="rounded-field p-2 text-ink-soft transition-colors hover:bg-line-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Activity className="h-5 w-5 text-ink-soft" />
          <div className="flex-1">
            <h1 className="text-[17px] font-extrabold tracking-[-.02em] text-ink">
              Uso das telas
            </h1>
            <p className="text-[12px] text-ink-soft">
              {inventario.rotas.length} rotas no código · inventário de {inventario.geradoEm} ·
              contagem desde 11/08
            </p>
          </div>
          <Button variant="primary" onClick={carregar} disabled={carregando}>
            <RefreshCw className={carregando ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {carregando ? 'Lendo…' : 'Atualizar'}
          </Button>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-3 p-4">
        {erro && (
          <Card className="border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">{erro}</Card>
        )}

        <Card className="grid grid-cols-2 divide-x divide-line sm:grid-cols-4">
          <Numero
            rotulo="Nunca abertas"
            valor={grupos.silencio.length}
            apoio="candidatas a corte"
            tom={grupos.silencio.length ? 'crit' : undefined}
          />
          <Numero
            rotulo="Quase paradas"
            valor={grupos.pouco.length}
            apoio={`≤${POUCO_USO} acessos ou ${DIAS_SILENCIO}d sem abrir`}
            tom={grupos.pouco.length ? 'warn' : undefined}
          />
          <Numero rotulo="Em uso" valor={grupos.ativas.length} apoio="ficam" tom="ok" />
          <Numero
            rotulo="Acessos no total"
            valor={linhas.reduce((s, l) => s + l.hits, 0).toLocaleString('pt-BR')}
            apoio="todas as rotas somadas"
          />
        </Card>

        <Card>
          <CardHead
            titulo="Telas por situação"
            acao={
              <>
                <Select
                  aria-label="Área"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  className="w-auto"
                >
                  <option value="todas">Todas as áreas</option>
                  {areas.map((a) => (
                    <option key={a} value={a}>
                      /{a}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label="Buscar rota"
                  placeholder="Buscar rota…"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  className="w-48"
                />
              </>
            }
          >
            A faixa vermelha é rota que nunca foi aberta desde 11/08. &quot;Fora do código&quot; é
            rota que a telemetria viu mas que não existe mais — link velho apontando pra lugar
            nenhum.
          </CardHead>

          <div className="px-4 pt-1">
            <Tabs abas={abas} valor={aba} onChange={setAba} />
          </div>

          <div className="p-4">
            <Table>
              <thead>
                <tr>
                  <Th>Rota</Th>
                  <Th align="right">Acessos</Th>
                  <Th align="right">Última visita</Th>
                  <Th align="right">Parada há</Th>
                  <Th>Quem abriu</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {carregando && (
                  <TabelaVazia colSpan={6}>Lendo a telemetria…</TabelaVazia>
                )}
                {!carregando && !visiveis.length && (
                  <TabelaVazia colSpan={6}>
                    Nenhuma rota aqui com esses filtros.
                  </TabelaVazia>
                )}
                {!carregando &&
                  visiveis.map((l) => (
                    <Tr key={l.path} estado={estadoDa(l)}>
                      <Td className="font-medium">{l.path}</Td>
                      <Td align="right" num>
                        {l.hits ? l.hits.toLocaleString('pt-BR') : <Badge tom="crit">zero</Badge>}
                      </Td>
                      <Td align="right" num className="text-ink-soft">
                        {dataBr(l.lastAt)}
                      </Td>
                      <Td align="right" num>
                        {l.diasParada === null ? (
                          <span className="text-ink-faint">—</span>
                        ) : l.diasParada >= DIAS_SILENCIO ? (
                          <Badge tom="warn">{l.diasParada}d</Badge>
                        ) : (
                          <span className="text-ink-soft">{l.diasParada}d</span>
                        )}
                      </Td>
                      <Td className="text-ink-soft">
                        {l.lastRole ? (
                          <>
                            {l.lastRole}
                            {l.lastStore ? ` · loja ${l.lastStore}` : ''}
                          </>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </Td>
                      <Td align="right">
                        <Link
                          href={l.path}
                          title="Abrir a tela"
                          className="inline-flex rounded-field p-1.5 text-ink-faint transition-colors hover:bg-line-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      </Td>
                    </Tr>
                  ))}
              </tbody>
            </Table>
          </div>
        </Card>

        <p className="px-1 text-[12px] leading-relaxed text-ink-faint">
          Rota dinâmica (<code>/pedidos/[id]</code>) chega já normalizada do beacon. Rota pública de
          propósito — <code>/cadastro-live</code>, <code>/meus-pedidos</code>, <code>/p/[id]</code> —
          aparece com pouco acesso de admin e não é candidata a corte. Depois de criar ou apagar
          rota, rode <code>node scripts/gerar-rotas.mjs</code> pra atualizar o inventário.
        </p>
      </main>
    </div>
  );
}
