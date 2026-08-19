'use client';

import { useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Camera, Check, Loader2, Star, X } from 'lucide-react';

/**
 * CENTRO DE AVALIAÇÃO — "conte como serviu e ganhe pontos".
 *
 * Duas abas: o que está esperando avaliação e o que já foi avaliado.
 *
 * O formulário abre NO LUGAR da lista, uma peça por vez. É proposital: no
 * celular, formulário dentro de card empurra o conteúdo e a cliente perde a
 * peça de vista no meio do preenchimento — e overlay grande, além de brigar
 * com o teclado, é o que já congelou tela no site antes.
 *
 * O placar de pontos é AO VIVO: a cliente vê o número subir quando escreve o
 * vigésimo palavra ou anexa a foto. Sem isso, "escreva 20 palavras pra ganhar
 * 5 pontos" é promessa que ela não tem como conferir.
 *
 * ⚠️ O que paga é o TRABALHO, nunca a nota. A régua está no backend
 * (`AvaliacoesService.calcularPontos`) e aqui só se ESPELHA o cálculo pra
 * mostrar; quem credita é o servidor, com a config da matriz.
 */

interface Pendente {
  orderItemId: string;
  orderId: string;
  pedidoNumero: string | null;
  data: string | null;
  ref: string | null;
  refBase: string;
  cor: string | null;
  tamanho: string | null;
  nome: string;
  foto: string | null;
  slug: string | null;
  pontosPossiveis: number;
}

interface Avaliada {
  id: string;
  slug: string | null;
  nome: string | null;
  cor: string | null;
  tamanho: string | null;
  nota: number;
  texto: string | null;
  fotos: string[];
  caimento: string | null;
  pontos: number;
  status: string;
  data: string;
}

interface Regras {
  pontosEnvio: number;
  pontosTexto: number;
  pontosFoto: number;
  pontosMedidas: number;
  minPalavras: number;
  maxFotos: number;
  teto: number;
  diasAposPedido: number;
  /** Por quantos dias a peça continua avaliável, contados do pedido. */
  janelaDias: number;
  moderacao: boolean;
}

export interface DadosCentro {
  ativo: boolean;
  pontos: { saldo: number; pontosPorReal: number; equivaleReais: number };
  regras: Regras;
  pendentes: Pendente[];
  avaliadas: Avaliada[];
}

const CAIMENTOS = [
  { valor: 'pequeno', rotulo: 'Pequeno' },
  { valor: 'fiel', rotulo: 'Fiel ao tamanho' },
  { valor: 'grande', rotulo: 'Grande' },
];

const ROTULO_CAIMENTO: Record<string, string> = {
  pequeno: 'Veio pequeno',
  fiel: 'Fiel ao tamanho',
  grande: 'Veio grande',
};

function contarPalavras(texto: string) {
  return texto.trim().split(/\s+/).filter(Boolean).length;
}

function Estrelas({
  nota,
  onChange,
  tamanho = 'md',
}: {
  nota: number;
  onChange?: (n: number) => void;
  tamanho?: 'sm' | 'md';
}) {
  const classe = tamanho === 'sm' ? 'size-4' : 'size-8';
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => {
        const cheia = n <= nota;
        const icone = (
          <Star
            className={`${classe} ${cheia ? 'fill-primary text-primary' : 'text-border-strong'}`}
            strokeWidth={1.5}
          />
        );
        if (!onChange) return <span key={n}>{icone}</span>;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-label={`${n} ${n === 1 ? 'estrela' : 'estrelas'}`}
            aria-pressed={cheia}
            className="p-0.5 transition-transform hover:scale-110"
          >
            {icone}
          </button>
        );
      })}
    </div>
  );
}

function FotoDaPeca({ url, nome }: { url: string | null; nome: string }) {
  if (!url) {
    return (
      <div className="flex size-20 shrink-0 items-center justify-center rounded-sm bg-surface-alt text-caption text-ink-muted">
        sem foto
      </div>
    );
  }
  return (
    <Image
      src={url}
      alt={nome}
      width={80}
      height={107}
      className="size-20 shrink-0 rounded-sm object-cover"
      unoptimized
    />
  );
}

export function CentroDeAvaliacao({ dados }: { dados: DadosCentro }) {
  const router = useRouter();
  const [aba, setAba] = useState<'pendentes' | 'avaliadas'>(
    dados.pendentes.length ? 'pendentes' : 'avaliadas',
  );
  const [avaliando, setAvaliando] = useState<Pendente | null>(null);
  const [enviadaAgora, setEnviadaAgora] = useState<{ pontos: number } | null>(null);

  if (!dados.ativo) {
    return (
      <p className="text-body text-ink-muted">
        As avaliações estão pausadas no momento. Volte em breve.
      </p>
    );
  }

  if (avaliando) {
    return (
      <FormularioAvaliacao
        item={avaliando}
        regras={dados.regras}
        onCancelar={() => setAvaliando(null)}
        onPronto={(pontos) => {
          setAvaliando(null);
          setEnviadaAgora({ pontos });
          setAba('avaliadas');
          // Recarrega os dados do servidor: a peça sai da fila, o saldo sobe.
          router.refresh();
        }}
      />
    );
  }

  return (
    <div>
      <PlacarDePontos pontos={dados.pontos} regras={dados.regras} />

      {enviadaAgora && (
        <p className="mt-6 flex items-center gap-2 rounded-sm border border-success/40 bg-accent-wash px-4 py-3 text-small text-ink">
          <Check className="size-4 text-success" />
          Avaliação enviada
          {enviadaAgora.pontos > 0 ? ` — você ganhou ${enviadaAgora.pontos} pontos.` : '.'}
          {dados.regras.moderacao && ' Ela aparece no site depois da nossa conferência.'}
        </p>
      )}

      <div className="mt-8 flex gap-6 border-b border-border">
        {[
          { chave: 'pendentes' as const, rotulo: 'Aguardando avaliação', n: dados.pendentes.length },
          { chave: 'avaliadas' as const, rotulo: 'Avaliado', n: dados.avaliadas.length },
        ].map((t) => (
          <button
            key={t.chave}
            type="button"
            onClick={() => setAba(t.chave)}
            aria-current={aba === t.chave ? 'true' : undefined}
            className={`-mb-px border-b-2 pb-3 text-body transition-colors ${
              aba === t.chave
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {t.rotulo}
            {t.n > 0 && <span className="ml-1.5 text-ink-muted">({t.n})</span>}
          </button>
        ))}
      </div>

      {aba === 'pendentes' ? (
        <ListaPendentes
          itens={dados.pendentes}
          diasAposPedido={dados.regras.diasAposPedido}
          janelaDias={dados.regras.janelaDias}
          onAvaliar={setAvaliando}
        />
      ) : (
        <ListaAvaliadas itens={dados.avaliadas} />
      )}
    </div>
  );
}

function PlacarDePontos({
  pontos,
  regras,
}: {
  pontos: DadosCentro['pontos'];
  regras: Regras;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-alt px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-h3 tabular-nums">
          {pontos.saldo} <span className="text-body text-ink-soft">pontos</span>
        </p>
        <p className="text-small text-ink-soft">
          Cada peça avaliada vale até <strong className="font-medium">{regras.teto}</strong> pontos
        </p>
      </div>
      {/* Nada de "vale R$ X" sem resgate no ar: promessa que a tela não cumpre
          é o tipo de coisa que a cliente cobra no WhatsApp. */}
      <p className="mt-2 text-small text-ink-muted">
        Os pontos ficam guardados na sua conta. Em breve você vai poder trocar por desconto.
      </p>
    </div>
  );
}

function ListaPendentes({
  itens,
  diasAposPedido,
  janelaDias,
  onAvaliar,
}: {
  itens: Pendente[];
  diasAposPedido: number;
  janelaDias: number;
  onAvaliar: (p: Pendente) => void;
}) {
  if (!itens.length) {
    return (
      <p className="py-10 text-body text-ink-muted">
        Nenhuma peça esperando avaliação. As peças liberam quando a entrega é confirmada — ou{' '}
        {diasAposPedido} dias depois do pedido — e ficam avaliáveis por {janelaDias} dias.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {itens.map((i) => (
        <li key={i.orderItemId} className="flex items-start gap-4 py-5">
          <FotoDaPeca url={i.foto} nome={i.nome} />
          <div className="min-w-0 flex-1">
            {i.slug ? (
              <Link href={`/produto/${i.slug}`} className="link-underline text-body font-medium">
                {i.nome}
              </Link>
            ) : (
              <p className="text-body font-medium">{i.nome}</p>
            )}
            <p className="mt-0.5 text-small text-ink-muted">
              {[i.cor, i.tamanho].filter(Boolean).join(' · ')}
              {i.pedidoNumero ? ` · Pedido ${i.pedidoNumero}` : ''}
            </p>
            <p className="mt-1 text-small text-primary-strong">
              Ganhe até {i.pontosPossiveis} pontos
            </p>
          </div>
          <button
            type="button"
            onClick={() => onAvaliar(i)}
            className="shrink-0 rounded-pill border border-primary px-4 py-2 text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-primary-strong transition-colors hover:bg-primary-wash"
          >
            Avaliar
          </button>
        </li>
      ))}
    </ul>
  );
}

function ListaAvaliadas({ itens }: { itens: Avaliada[] }) {
  if (!itens.length) {
    return <p className="py-10 text-body text-ink-muted">Você ainda não avaliou nenhuma peça.</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {itens.map((a) => (
        <li key={a.id} className="py-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {a.slug ? (
              <Link href={`/produto/${a.slug}`} className="link-underline text-body font-medium">
                {a.nome || 'Peça'}
              </Link>
            ) : (
              <p className="text-body font-medium">{a.nome || 'Peça'}</p>
            )}
            <Estrelas nota={a.nota} tamanho="sm" />
          </div>
          <p className="mt-0.5 text-small text-ink-muted">
            {[a.cor, a.tamanho].filter(Boolean).join(' · ')}
            {a.caimento ? ` · ${ROTULO_CAIMENTO[a.caimento] ?? a.caimento}` : ''}
            {' · '}
            {new Date(a.data).toLocaleDateString('pt-BR')}
          </p>
          {a.texto && <p className="mt-2 text-body text-ink-soft">{a.texto}</p>}
          {a.fotos.length > 0 && (
            <div className="mt-3 flex gap-2">
              {a.fotos.map((url) => (
                <Image
                  key={url}
                  src={url}
                  alt=""
                  width={64}
                  height={64}
                  className="size-16 rounded-sm object-cover"
                  unoptimized
                />
              ))}
            </div>
          )}
          <p className="mt-2 text-small text-ink-muted">
            {a.pontos > 0 ? `+${a.pontos} pontos` : 'Enviada'}
            {a.status === 'oculta' && ' · em conferência'}
          </p>
        </li>
      ))}
    </ul>
  );
}

function FormularioAvaliacao({
  item,
  regras,
  onCancelar,
  onPronto,
}: {
  item: Pendente;
  regras: Regras;
  onCancelar: () => void;
  onPronto: (pontos: number) => void;
}) {
  const [nota, setNota] = useState(0);
  const [texto, setTexto] = useState('');
  const [fotos, setFotos] = useState<string[]>([]);
  const [caimento, setCaimento] = useState<string | null>(null);
  const [altura, setAltura] = useState('');
  const [peso, setPeso] = useState('');
  const [publicarMedidas, setPublicarMedidas] = useState(true);
  const [subindoFoto, setSubindoFoto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const inputFoto = useRef<HTMLInputElement>(null);

  const palavras = contarPalavras(texto);
  const temMedidas = Number(altura) > 0 && Number(peso) > 0;

  const pontosAgora = useMemo(() => {
    if (!nota) return 0;
    let t = regras.pontosEnvio;
    if (palavras >= regras.minPalavras) t += regras.pontosTexto;
    if (fotos.length > 0) t += regras.pontosFoto;
    if (temMedidas) t += regras.pontosMedidas;
    return t;
  }, [nota, palavras, fotos.length, temMedidas, regras]);

  async function subirFotos(arquivos: FileList | null) {
    if (!arquivos?.length) return;
    setErro(null);
    setSubindoFoto(true);
    try {
      const sobra = regras.maxFotos - fotos.length;
      for (const arquivo of Array.from(arquivos).slice(0, Math.max(sobra, 0))) {
        const corpo = new FormData();
        corpo.append('file', arquivo);
        // Sem Content-Type na mão: o navegador precisa escrever o boundary do
        // multipart, e defini-lo aqui quebra o upload em silêncio.
        const res = await fetch('/api/conta/avaliacoes/foto', { method: 'POST', body: corpo });
        const d = await res.json().catch(() => null);
        if (!res.ok || !d?.url) throw new Error(d?.erro || 'Não consegui enviar a foto.');
        setFotos((f) => [...f, d.url]);
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui enviar a foto.');
    } finally {
      setSubindoFoto(false);
      if (inputFoto.current) inputFoto.current.value = '';
    }
  }

  async function enviar() {
    if (!nota) {
      setErro('Escolha de 1 a 5 estrelas.');
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      const res = await fetch('/api/conta/avaliacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderItemId: item.orderItemId,
          nota,
          texto: texto.trim() || null,
          fotos,
          caimento,
          alturaCm: altura ? Number(altura) : null,
          pesoKg: peso ? Number(peso) : null,
          publicarMedidas,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.erro || 'Não consegui enviar sua avaliação.');
      onPronto(Number(d?.pontosGanhos) || 0);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui enviar sua avaliação.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
        <button
          type="button"
          onClick={onCancelar}
          className="link-underline text-small text-ink-muted hover:text-ink"
        >
          ← Voltar
        </button>
        <p className="text-small tabular-nums text-ink-soft">
          <strong className="font-medium text-primary-strong">{pontosAgora}</strong> / {regras.teto} pontos
        </p>
      </div>

      <div className="flex items-start gap-4 py-5">
        <FotoDaPeca url={item.foto} nome={item.nome} />
        <div className="min-w-0">
          <p className="text-body font-medium">{item.nome}</p>
          <p className="mt-0.5 text-small text-ink-muted">
            {[item.cor, item.tamanho].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>

      <fieldset className="border-t border-border py-6">
        <legend className="sr-only">Sua nota</legend>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-body font-medium">
            Sua nota <span className="text-danger">*</span>
          </p>
          <Estrelas nota={nota} onChange={setNota} />
        </div>
      </fieldset>

      <div className="border-t border-border py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-body font-medium">Fotos da peça em você</p>
          <p className="text-small text-primary-strong">+{regras.pontosFoto} pontos</p>
        </div>
        <p className="mt-1 text-small text-ink-muted">
          A foto de quem veste é o que mais ajuda outra cliente a decidir o tamanho.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {fotos.map((url) => (
            <span key={url} className="relative">
              <Image
                src={url}
                alt=""
                width={80}
                height={80}
                className="size-20 rounded-sm object-cover"
                unoptimized
              />
              <button
                type="button"
                onClick={() => setFotos((f) => f.filter((u) => u !== url))}
                aria-label="Remover foto"
                className="absolute -right-1.5 -top-1.5 rounded-pill bg-ink p-1 text-light"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}

          {fotos.length < regras.maxFotos && (
            <button
              type="button"
              onClick={() => inputFoto.current?.click()}
              disabled={subindoFoto}
              className="flex size-20 flex-col items-center justify-center gap-1 rounded-sm border border-dashed border-border-strong text-ink-muted transition-colors hover:border-primary hover:text-primary-strong disabled:opacity-50"
            >
              {subindoFoto ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <>
                  <Camera className="size-5" strokeWidth={1.5} />
                  <span className="text-[0.625rem]">Foto</span>
                </>
              )}
            </button>
          )}
        </div>
        <input
          ref={inputFoto}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => subirFotos(e.target.files)}
        />
      </div>

      <div className="border-t border-border py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="texto-avaliacao" className="text-body font-medium">
            O que você achou
          </label>
          <p className="text-small text-primary-strong">
            +{regras.pontosTexto} pontos com {regras.minPalavras}+ palavras
          </p>
        </div>
        <textarea
          id="texto-avaliacao"
          value={texto}
          onChange={(e) => setTexto(e.target.value.slice(0, 1000))}
          rows={5}
          placeholder="Como é o tecido? Serviu como você esperava? Usou pra quê?"
          className="mt-3 w-full rounded-sm border border-border bg-surface px-4 py-3 text-body outline-none transition-colors placeholder:text-ink-muted focus:border-primary"
        />
        <p className="mt-1 text-right text-small text-ink-muted tabular-nums">
          {palavras}/{regras.minPalavras} palavras · {texto.length}/1000
        </p>
      </div>

      <fieldset className="border-t border-border py-6">
        <legend className="text-body font-medium">Este item serviu bem em você?</legend>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {CAIMENTOS.map((c) => (
            <button
              key={c.valor}
              type="button"
              onClick={() => setCaimento(caimento === c.valor ? null : c.valor)}
              aria-pressed={caimento === c.valor}
              className={`rounded-sm border px-3 py-3 text-small transition-colors ${
                caimento === c.valor
                  ? 'border-ink bg-ink text-light'
                  : 'border-border text-ink-soft hover:border-primary'
              }`}
            >
              {c.rotulo}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="border-t border-border py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <legend className="text-body font-medium">Suas medidas</legend>
          <p className="text-small text-primary-strong">+{regras.pontosMedidas} pontos</p>
        </div>
        <p className="mt-1 text-small text-ink-muted">
          É o que faz o &ldquo;Descubra seu tamanho&rdquo; acertar melhor na próxima peça.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-small text-ink-soft">Altura (cm)</span>
            <input
              type="number"
              inputMode="numeric"
              value={altura}
              onChange={(e) => setAltura(e.target.value)}
              min={120}
              max={220}
              placeholder="165"
              className="mt-1 w-full rounded-sm border border-border bg-surface px-4 py-3 text-body outline-none transition-colors focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-small text-ink-soft">Peso (kg)</span>
            <input
              type="number"
              inputMode="numeric"
              value={peso}
              onChange={(e) => setPeso(e.target.value)}
              min={30}
              max={250}
              placeholder="90"
              className="mt-1 w-full rounded-sm border border-border bg-surface px-4 py-3 text-body outline-none transition-colors focus:border-primary"
            />
          </label>
        </div>
        <label className="mt-3 flex items-start gap-2.5 text-small text-ink-soft">
          <input
            type="checkbox"
            checked={publicarMedidas}
            onChange={(e) => setPublicarMedidas(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-primary)]"
          />
          {/* Desmarcado, altura e peso continuam valendo pro Fit AI — só não
              aparecem pra quem lê a avaliação. */}
          Mostrar minha altura e peso na avaliação, pra ajudar quem tem corpo parecido
        </label>
      </fieldset>

      {erro && (
        <p role="alert" className="mb-4 rounded-sm border border-danger/40 px-4 py-3 text-small text-danger">
          {erro}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-6">
        <button
          type="button"
          onClick={enviar}
          disabled={enviando || !nota}
          className="inline-flex items-center justify-center gap-2.5 rounded-pill bg-ink px-9 py-4 text-button font-medium uppercase tracking-[0.16em] text-light transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-primary-strong disabled:pointer-events-none disabled:opacity-50"
        >
          {enviando && <Loader2 className="size-4 animate-spin" />}
          Enviar avaliação
        </button>
        <p className="text-small text-ink-muted">
          {pontosAgora > 0 ? `Você leva ${pontosAgora} pontos` : 'Escolha as estrelas pra enviar'}
        </p>
      </div>
    </div>
  );
}
