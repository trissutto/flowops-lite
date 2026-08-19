import Link from 'next/link';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { AcessoConta } from '@/components/conta/AcessoConta';
import { ResgatarPontos } from '@/components/conta/ResgatarPontos';
import { comoCliente } from '@/lib/conta';
import { buildMetadata } from '@/lib/seo';

/**
 * MEUS PONTOS — o outro lado da avaliação.
 *
 * Pedir opinião e prometer pontos sem lugar nenhum pra ver o saldo é a versão
 * moderna do "ganha um brinde": ninguém acredita na segunda vez. A tela existe
 * pelo mesmo motivo que a de cashback — saldo que a cliente não vê não muda
 * comportamento, é custo sem retorno.
 *
 * O EXTRATO importa tanto quanto o saldo: sem ele, "60 pontos" é um número que
 * ela não sabe de onde veio, e número que ela não entende ela não gasta.
 */

export const metadata = buildMetadata({
  title: 'Meus pontos',
  path: '/conta/pontos',
  noIndex: true,
});

export const dynamic = 'force-dynamic';

interface Movimento {
  id: string;
  pontos: number;
  saldoApos: number;
  tipo: string;
  descricao: string | null;
  data: string | null;
}

interface Extrato {
  saldo: number;
  ganhos: number;
  gastos: number;
  valeEmReais: number;
  regras: {
    pontosPorAvaliacao: number;
    pontosComFoto: number;
    pontosPorReal: number;
    minimoResgate: number;
  };
  transacoes: Movimento[];
}

function dataCurta(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default async function PontosPage() {
  const extrato = await comoCliente<Extrato>('/me/pontos');

  if (!extrato) {
    return (
      <Section space="lg">
        <Container>
          <h1 className="mb-8 text-center text-h2">Meus pontos</h1>
          <AcessoConta />
        </Container>
      </Section>
    );
  }

  const { saldo, valeEmReais, regras, transacoes } = extrato;
  const faltam = Math.max(0, regras.minimoResgate - saldo);

  return (
    <Section space="lg">
      <Container width="text">
        <header className="mb-8">
          <p className="eyebrow text-muted">Minha conta</p>
          <h1 className="text-h2">Meus pontos</h1>
        </header>

        <div className="rounded-sm border border-border bg-surface p-6">
          <p className="text-small text-muted">Saldo</p>
          <p className="mt-1 text-4xl font-light text-ink">
            {saldo} <span className="text-lg text-muted">pontos</span>
          </p>
          <p className="mt-1 text-body text-ink-soft">
            valem <strong>R$ {valeEmReais},00</strong> de desconto
          </p>

          {faltam > 0 ? (
            <p className="mt-4 text-small text-muted">
              Faltam <strong>{faltam} pontos</strong> pro primeiro resgate (mínimo{' '}
              {regras.minimoResgate}).
            </p>
          ) : (
            <ResgatarPontos
              saldo={saldo}
              pontosPorReal={regras.pontosPorReal}
              minimoResgate={regras.minimoResgate}
            />
          )}
        </div>

        {/* A regra do jogo, sempre à vista */}
        <div className="mt-4 rounded-sm border border-primary/30 bg-primary-wash p-5 text-small text-ink">
          <p>
            <strong>{regras.pontosPorAvaliacao} pontos</strong> por peça que você avalia depois de
            receber — e <strong>{regras.pontosComFoto}</strong> quando manda uma foto usando, em
            qualquer nota.
          </p>
          <p className="mt-2 text-muted">
            {regras.pontosPorReal} pontos = R$ 1,00. O convite chega no WhatsApp alguns dias depois
            da entrega. Os pontos entram no saldo quando a avaliação é publicada.
          </p>
        </div>

        <h2 className="mb-3 mt-10 text-h4">Extrato</h2>
        {transacoes.length === 0 ? (
          <p className="rounded-sm border border-border p-6 text-body text-muted">
            Você ainda não tem movimentação. Assim que avaliar uma peça que recebeu, ela aparece
            aqui.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {transacoes.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate text-body text-ink">{m.descricao || m.tipo}</p>
                  <p className="text-small text-muted">{dataCurta(m.data)}</p>
                </div>
                <span
                  className={`shrink-0 text-body font-medium ${
                    m.pontos > 0 ? 'text-success' : 'text-ink-soft'
                  }`}
                >
                  {m.pontos > 0 ? '+' : ''}
                  {m.pontos}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Link href="/conta" className="mt-8 inline-block text-small text-muted underline">
          Voltar pra minha conta
        </Link>
      </Container>
    </Section>
  );
}
