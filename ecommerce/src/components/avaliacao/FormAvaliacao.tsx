'use client';

import { useMemo, useState } from 'react';
import { Camera, Check, Loader2, Star, X } from 'lucide-react';
import { AppLink } from '@/components/ui/AppLink';
import type { Convite, PecaDoConvite } from '@/lib/avaliacoes';

/**
 * "COMO FICOU?" — o formulário que a cliente abre pelo link do WhatsApp.
 *
 * ── AS DECISÕES DE TELA ──
 *
 * 1. **Uma peça por vez, na ordem, sem paredes.** Sem login, sem CPF (a menos
 *    que o pedido não tenha), sem cadastro. O link chega no WhatsApp e é aberto
 *    no celular — cada campo a mais é gente desistindo no meio.
 *
 * 2. **A estrela é o primeiro toque.** Ela responde a pergunta inteira sozinha;
 *    comentário e foto são convites, nunca obrigações. Formulário que exige
 *    texto recebe "bom" de todo mundo.
 *
 * 3. **O bônus da foto aparece ANTES de ela escolher a foto**, com o número na
 *    frente ("40 pontos em vez de 20"). Recompensa que só se descobre depois de
 *    fazer não muda comportamento nenhum.
 *
 * 4. **A foto dobra em QUALQUER nota** (decisão do dono, 19/08). Pagar mais por
 *    5★ compra avaliação: enviesa a média e, quando a cliente percebe que só
 *    existe 5★, ela para de acreditar no bloco — o mesmo fim dos depoimentos
 *    inventados que saíram do ar em 06/08.
 *
 * 5. **A foto vai direto pro Cloudflare**, não passa pelo site: no 4G da rua,
 *    fazer o arquivo dar duas voltas é o que transforma "mandei" em "travou".
 */

interface Resposta {
  nota: number;
  comentario: string;
  fotoId: string | null;
  fotoPreview: string | null;
  enviandoFoto: boolean;
}

const VAZIA: Resposta = {
  nota: 0,
  comentario: '',
  fotoId: null,
  fotoPreview: null,
  enviandoFoto: false,
};

/** Limite de arquivo — foto de celular moderna passa fácil de 8 MB. */
const MAX_BYTES = 12 * 1024 * 1024;

const LEGENDA: Record<number, string> = {
  1: 'Não gostei',
  2: 'Deixou a desejar',
  3: 'Serviu, mas nada demais',
  4: 'Gostei bastante',
  5: 'Amei!',
};

export function FormAvaliacao({ convite }: { convite: Convite }) {
  const pendentes = useMemo(
    () => convite.pecas.filter((p) => !p.avaliada),
    [convite.pecas],
  );
  const jaAvaliadas = useMemo(
    () => convite.pecas.filter((p) => !!p.avaliada),
    [convite.pecas],
  );

  const [respostas, setRespostas] = useState<Record<string, Resposta>>(() =>
    Object.fromEntries(pendentes.map((p) => [p.chave, { ...VAZIA }])),
  );
  const [cpf, setCpf] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [pronto, setPronto] = useState<{ pontos: number; comFoto: number; credita: boolean } | null>(
    null,
  );

  const { pontosPorAvaliacao, pontosComFoto, pontosPorReal } = convite.regras;

  function mexer(chave: string, patch: Partial<Resposta>) {
    setRespostas((r) => ({ ...r, [chave]: { ...r[chave], ...patch } }));
  }

  /** Soma o que ela ganha SE enviar agora — atualiza a cada estrela e cada foto. */
  const pontosAgora = useMemo(
    () =>
      Object.values(respostas).reduce(
        (s, r) => (r.nota ? s + (r.fotoId ? pontosComFoto : pontosPorAvaliacao) : s),
        0,
      ),
    [respostas, pontosComFoto, pontosPorAvaliacao],
  );
  const respondidas = Object.values(respostas).filter((r) => r.nota > 0).length;

  async function escolherFoto(chave: string, arquivo: File) {
    setErro(null);
    if (!arquivo.type.startsWith('image/')) {
      setErro('Escolhe uma foto (JPG ou PNG).');
      return;
    }
    if (arquivo.size > MAX_BYTES) {
      setErro('Essa foto é muito grande. Tenta uma com menos de 12 MB.');
      return;
    }
    mexer(chave, { enviandoFoto: true });
    try {
      const ticket = await fetch(`/api/avaliacoes/${convite.token}/foto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: arquivo.name }),
      });
      const dados = await ticket.json();
      if (!ticket.ok || !dados?.uploadURL) {
        throw new Error(dados?.error || 'Não consegui preparar o envio da foto.');
      }

      const form = new FormData();
      form.append('file', arquivo);
      const envio = await fetch(dados.uploadURL, { method: 'POST', body: form });
      if (!envio.ok) throw new Error('A foto não subiu. Tenta de novo?');

      mexer(chave, {
        fotoId: dados.id,
        fotoPreview: URL.createObjectURL(arquivo),
        enviandoFoto: false,
      });
    } catch (e) {
      mexer(chave, { enviandoFoto: false });
      setErro(e instanceof Error ? e.message : 'A foto não subiu.');
    }
  }

  function tirarFoto(chave: string) {
    const atual = respostas[chave];
    if (atual?.fotoPreview) URL.revokeObjectURL(atual.fotoPreview);
    mexer(chave, { fotoId: null, fotoPreview: null });
  }

  async function enviar() {
    setErro(null);
    const itens = pendentes
      .filter((p) => respostas[p.chave]?.nota > 0)
      .map((p) => ({
        refBase: p.refBase,
        cor: p.cor,
        nota: respostas[p.chave].nota,
        comentario: respostas[p.chave].comentario.trim() || undefined,
        fotoId: respostas[p.chave].fotoId || undefined,
      }));

    if (!itens.length) {
      setErro('Dá uma nota pra pelo menos uma peça 💛');
      return;
    }
    const digitos = cpf.replace(/\D/g, '');
    if (convite.precisaCpf && digitos.length !== 11) {
      setErro('Precisamos do seu CPF pra creditar os pontos.');
      return;
    }

    setEnviando(true);
    try {
      const r = await fetch(`/api/avaliacoes/${convite.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itens, ...(digitos.length === 11 ? { cpf: digitos } : {}) }),
      });
      const dados = await r.json();
      if (!r.ok || dados?.ok === false) {
        throw new Error(dados?.error || 'Não consegui salvar sua avaliação.');
      }
      setPronto({
        pontos: dados.pontosPrevistos ?? 0,
        comFoto: dados.comFoto ?? 0,
        credita: dados.creditaPontos !== false,
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui salvar sua avaliação.');
    } finally {
      setEnviando(false);
    }
  }

  // ── Depois de enviar ──────────────────────────────────────────────────
  if (pronto) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-wash">
          <Check className="h-7 w-7 text-primary-strong" />
        </div>
        <h2 className="text-2xl font-light text-ink">Obrigada de verdade 💛</h2>
        <p className="mt-3 text-body font-light text-ink-soft">
          Sua opinião vai aparecer na página da peça e ajudar outra cliente a decidir o tamanho — que
          é a dúvida que mais trava a compra por aqui.
        </p>
        {pronto.credita ? (
          <p className="mt-4 text-body text-ink">
            Você garantiu <strong>{pronto.pontos} pontos</strong>
            {pronto.comFoto > 0 && <> (com o dobro em {pronto.comFoto} peça{pronto.comFoto > 1 ? 's' : ''} por causa da foto)</>}.
            Eles entram no seu saldo assim que a gente publicar — costuma levar até um dia.
          </p>
        ) : (
          <p className="mt-4 text-body text-ink-soft">
            Não achamos um CPF no seu pedido, então não temos onde creditar os pontos — mas a
            avaliação valeu do mesmo jeito.
          </p>
        )}
        <AppLink
          href="/novidades"
          className="mt-6 inline-flex items-center justify-center rounded-full bg-ink px-8 py-3.5 text-button uppercase tracking-widest text-light transition hover:bg-primary-strong"
        >
          Ver novidades
        </AppLink>
      </div>
    );
  }

  // ── O formulário ──────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {jaAvaliadas.length > 0 && (
        <div className="rounded-xl border border-border bg-surface-alt px-4 py-3 text-sm text-ink-soft">
          Você já avaliou {jaAvaliadas.length} peça{jaAvaliadas.length > 1 ? 's' : ''} deste pedido.
          Obrigada! 💛
        </div>
      )}

      {pendentes.map((peca) => (
        <PecaCard
          key={peca.chave}
          peca={peca}
          resposta={respostas[peca.chave] ?? VAZIA}
          pontosPorAvaliacao={pontosPorAvaliacao}
          pontosComFoto={pontosComFoto}
          onNota={(nota) => mexer(peca.chave, { nota })}
          onComentario={(comentario) => mexer(peca.chave, { comentario })}
          onFoto={(arquivo) => escolherFoto(peca.chave, arquivo)}
          onTirarFoto={() => tirarFoto(peca.chave)}
        />
      ))}

      {convite.precisaCpf && (
        <div className="rounded-xl border border-border bg-surface p-5">
          <label className="block text-sm font-medium text-ink" htmlFor="cpf-pontos">
            Seu CPF (pra creditar os pontos)
          </label>
          <p className="mt-1 text-xs text-ink-soft">
            É a mesma chave do seu cashback nas lojas. Sem ele a avaliação vale, mas os pontos não
            têm onde entrar.
          </p>
          <input
            id="cpf-pontos"
            inputMode="numeric"
            value={cpf}
            onChange={(e) => setCpf(e.target.value.replace(/\D/g, '').slice(0, 11))}
            placeholder="Só números"
            className="mt-3 w-full rounded-lg border border-border bg-background px-4 py-3 text-base text-ink outline-none focus:border-primary"
          />
        </div>
      )}

      {erro && (
        <p className="rounded-lg border border-secondary/40 bg-secondary-wash px-4 py-3 text-sm text-secondary">
          {erro}
        </p>
      )}

      {/* Barra de envio — o número dos pontos anda junto com a escolha dela */}
      <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface/95 px-4 py-4 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink-soft">
            {respondidas === 0 ? (
              'Toque nas estrelas pra começar'
            ) : (
              <>
                <strong className="text-ink">{pontosAgora} pontos</strong> por{' '}
                {respondidas} peça{respondidas > 1 ? 's' : ''} · valem R${' '}
                {Math.floor(pontosAgora / pontosPorReal)},00 de desconto
              </>
            )}
          </div>
          <button
            type="button"
            onClick={enviar}
            disabled={enviando || respondidas === 0}
            className="inline-flex items-center gap-2 rounded-full bg-ink px-8 py-3.5 text-button uppercase tracking-widest text-light transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
            Enviar avaliação
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================

function PecaCard({
  peca,
  resposta,
  pontosPorAvaliacao,
  pontosComFoto,
  onNota,
  onComentario,
  onFoto,
  onTirarFoto,
}: {
  peca: PecaDoConvite;
  resposta: Resposta;
  pontosPorAvaliacao: number;
  pontosComFoto: number;
  onNota: (n: number) => void;
  onComentario: (v: string) => void;
  onFoto: (f: File) => void;
  onTirarFoto: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex gap-4">
        {peca.foto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={peca.foto}
            alt={peca.nome}
            className="h-24 w-20 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="h-24 w-20 shrink-0 rounded-lg bg-surface-alt" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-medium leading-snug text-ink">{peca.nome}</h3>
          <p className="mt-0.5 text-sm text-ink-soft">
            {[peca.cor, peca.tamanho && `tam ${peca.tamanho}`].filter(Boolean).join(' · ')}
          </p>

          {/* Estrelas — alvo grande, é dedo em celular */}
          <div className="mt-3 flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onNota(n)}
                /* O nome da peça vai no rótulo porque a MESMA fileira de
                   estrelas se repete pra cada peça do pedido: sem ele, quem usa
                   leitor de tela ouve "5 estrelas" três vezes sem saber de qual
                   peça está falando. */
                aria-label={`${n} estrela${n > 1 ? 's' : ''} para ${peca.nome}`}
                aria-pressed={resposta.nota === n}
                className="p-1"
              >
                <Star
                  className={`h-8 w-8 transition ${
                    n <= resposta.nota
                      ? 'fill-primary text-primary'
                      : 'text-border-strong hover:text-primary'
                  }`}
                />
              </button>
            ))}
            {resposta.nota > 0 && (
              <span className="ml-2 text-sm text-ink-soft">{LEGENDA[resposta.nota]}</span>
            )}
          </div>
        </div>
      </div>

      {/* Comentário e foto só depois da nota: um formulário inteiro aberto de
          cara parece trabalho, e trabalho ninguém faz de graça. */}
      {resposta.nota > 0 && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <textarea
            value={resposta.comentario}
            onChange={(e) => onComentario(e.target.value.slice(0, 1500))}
            rows={3}
            placeholder="Como serviu? O tecido é o que você esperava? (opcional)"
            className="w-full resize-none rounded-lg border border-border bg-background px-4 py-3 text-base text-ink outline-none placeholder:text-ink-muted focus:border-primary"
          />

          {resposta.fotoPreview ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resposta.fotoPreview}
                alt="Sua foto"
                className="h-20 w-20 rounded-lg object-cover"
              />
              <div className="text-sm">
                <p className="font-medium text-primary-strong">
                  Foto anexada · {pontosComFoto} pontos
                </p>
                <button
                  type="button"
                  onClick={onTirarFoto}
                  className="mt-1 inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
                >
                  <X className="h-3 w-3" /> trocar
                </button>
              </div>
            </div>
          ) : (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-dashed border-primary/50 bg-primary-wash px-4 py-3 transition hover:border-primary">
              <span className="flex items-center gap-2 text-sm text-ink">
                {resposta.enviandoFoto ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary-strong" />
                ) : (
                  <Camera className="h-4 w-4 text-primary-strong" />
                )}
                {resposta.enviandoFoto ? 'Enviando sua foto…' : 'Mandar uma foto usando'}
              </span>
              <span className="shrink-0 rounded-full bg-primary-strong px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-light">
                {pontosComFoto} pts em vez de {pontosPorAvaliacao}
              </span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={resposta.enviandoFoto}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFoto(f);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
