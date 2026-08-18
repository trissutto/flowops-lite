'use client';

/**
 * VITRINES DA HOME — a ordem dos blocos do site, sem deploy.
 *
 * Até 17/08/2026 as duas listas da home eram array chumbado no código do site:
 * mudar a ordem era commit + deploy na Vercel. Aqui é seta pra cima e seta pra
 * baixo.
 *
 * PRINCÍPIO DA TELA: a lista é a home. A ordem de cima pra baixo aqui é
 * exatamente a ordem em que a cliente vê — por isso cada linha mostra o número
 * da posição, e não um campo "ordem" pra digitar (que é como a tela de
 * categorias faz, e ninguém acerta de primeira sem ver o resultado).
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  AlertTriangle, ArrowDown, ArrowUp, ExternalLink, Eye, EyeOff, Image as ImageIcon,
  Loader2, Plus, Save, Trash2,
} from 'lucide-react';

type Bloco = 'atalho' | 'carrossel';

type Vitrine = {
  id: string;
  bloco: Bloco;
  tipo: 'novidades' | 'destaques' | 'promocao' | 'categoria' | 'colecao';
  chave: string;
  /** De onde vêm as peças, em português ("Blusas", "Outlet (só peça em promoção)"). */
  nomeFonte: string;
  href: string | null;
  titulo: string | null;
  tituloMobile: string | null;
  /** O que o site vai mostrar de fato — o título digitado ou o nome da fonte. */
  tituloExibido: string;
  eyebrow: string | null;
  descricao: string | null;
  ctaLabel: string | null;
  limite: number;
  ordem: number;
  ativo: boolean;
  /** Foto da categoria (a mesma da tela Categorias) — só o atalho usa. */
  imagemUrl: string | null;
  qtdPecas: number;
  posicao: number;
};

type Disponivel = { bloco: Bloco; tipo: string; chave: string; nome: string; qtdPecas: number };

type Resposta = {
  atalhos: Vitrine[];
  carrosseis: Vitrine[];
  disponiveis: { atalho: Disponivel[]; carrossel: Disponivel[] };
};

const ROTULO_TIPO: Record<string, string> = {
  novidades: 'por data',
  destaques: 'relevância',
  promocao: 'promoção',
  categoria: 'categoria',
  colecao: 'coleção curada',
};

function mensagem(e: any, padrao: string): string {
  return e?.message?.replace(/^\d+:\s*/, '') || padrao;
}

export default function VitrinesHomePage() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvandoOrdem, setSalvandoOrdem] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setDados(await api<Resposta>('/site-vitrines'));
      setErro(null);
    } catch (e: any) {
      setErro(mensagem(e, 'Não consegui carregar'));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /**
   * A ordem muda na TELA primeiro e só depois no banco (otimista). Clicar a
   * seta e esperar a resposta pra ver a linha andar faz a pessoa clicar de
   * novo achando que não pegou — e aí o bloco anda duas casas.
   */
  async function mover(bloco: Bloco, indice: number, direcao: -1 | 1) {
    if (!dados) return;
    const chaveLista = bloco === 'atalho' ? 'atalhos' : 'carrosseis';
    const atual = dados[chaveLista];
    const destino = indice + direcao;
    if (destino < 0 || destino >= atual.length) return;

    const nova = [...atual];
    [nova[indice], nova[destino]] = [nova[destino], nova[indice]];
    setDados({ ...dados, [chaveLista]: nova.map((v, i) => ({ ...v, posicao: i + 1 })) });
    setSalvandoOrdem(true);
    setErro(null);
    try {
      await api('/site-vitrines/ordem', {
        method: 'PATCH',
        body: JSON.stringify({ ids: nova.map((v) => v.id) }),
      });
    } catch (e: any) {
      setErro(mensagem(e, 'Não consegui salvar a ordem'));
      void carregar(); // desfaz o otimismo com a verdade do banco
    } finally {
      setSalvandoOrdem(false);
    }
  }

  async function adicionar(d: Disponivel) {
    setErro(null);
    try {
      await api('/site-vitrines', {
        method: 'POST',
        body: JSON.stringify({ bloco: d.bloco, tipo: d.tipo, chave: d.chave }),
      });
      await carregar();
    } catch (e: any) {
      setErro(mensagem(e, 'Não consegui adicionar'));
    }
  }

  return (
    <div className="max-w-[1000px] mx-auto p-4 space-y-5">
      <div>
        <h1 className="text-xl font-black text-slate-800">Vitrines da home</h1>
        <p className="text-xs text-slate-500 mt-1">
          Estas listas <b>são a home</b>: a ordem aqui é a ordem em que a cliente vê. Use{' '}
          <ArrowUp className="w-3 h-3 inline" /> <ArrowDown className="w-3 h-3 inline" /> pra mudar
          de lugar — salva sozinho. O site atualiza em até 1 minuto.
        </p>
        <a
          href="https://www.lurdsplussize.com.br"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-violet-700 underline"
        >
          <ExternalLink className="w-3 h-3" /> ver a home
        </a>
      </div>

      {erro && (
        <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded-lg p-3 text-sm font-bold">
          {erro}
        </div>
      )}

      {salvandoOrdem && (
        <div className="text-[11px] font-bold text-violet-700 inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> salvando a ordem…
        </div>
      )}

      {carregando || !dados ? (
        <div className="text-center py-12 text-slate-400 text-sm">Carregando…</div>
      ) : (
        <>
          <SecaoBloco
            numero={1}
            titulo="Atalhos abaixo do banner"
            explicacao="Os cards com foto que aparecem logo depois da capa. É a primeira escolha da cliente — quem estiver em 1º leva mais clique."
            bloco="atalho"
            itens={dados.atalhos}
            disponiveis={dados.disponiveis.atalho}
            vazioTexto="Sem atalho nenhum, a home vai do banner direto pra vitrine."
            onMover={mover}
            onAdicionar={adicionar}
            onMudou={carregar}
            onErro={setErro}
          />

          <SecaoBloco
            numero={2}
            titulo="Vitrines de produto"
            explicacao="Os carrosséis de peças que rolam na horizontal. Cada um é uma seção da página, na ordem abaixo."
            bloco="carrossel"
            itens={dados.carrosseis}
            disponiveis={dados.disponiveis.carrossel}
            vazioTexto="Sem vitrine, a home fica só com o banner, os atalhos e as lojas."
            onMover={mover}
            onAdicionar={adicionar}
            onMudou={carregar}
            onErro={setErro}
          />
        </>
      )}
    </div>
  );
}

function SecaoBloco({
  numero, titulo, explicacao, bloco, itens, disponiveis, vazioTexto,
  onMover, onAdicionar, onMudou, onErro,
}: {
  numero: number;
  titulo: string;
  explicacao: string;
  bloco: Bloco;
  itens: Vitrine[];
  disponiveis: Disponivel[];
  vazioTexto: string;
  onMover: (bloco: Bloco, indice: number, direcao: -1 | 1) => void;
  onAdicionar: (d: Disponivel) => Promise<void>;
  onMudou: () => Promise<void> | void;
  onErro: (e: string | null) => void;
}) {
  const ativas = itens.filter((v) => v.ativo).length;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="text-sm font-black text-slate-800">
          {numero}. {titulo}
        </h2>
        <span className="text-[11px] font-bold text-slate-500">
          {ativas} no ar{itens.length > ativas ? ` · ${itens.length - ativas} desligada(s)` : ''}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 -mt-1">{explicacao}</p>

      {itens.length === 0 ? (
        <div className="text-center py-6 text-slate-400 text-xs border border-dashed border-slate-300 rounded-lg">
          {vazioTexto}
        </div>
      ) : (
        <div className="space-y-2">
          {itens.map((v, i) => (
            <CardVitrine
              key={v.id}
              vitrine={v}
              primeira={i === 0}
              ultima={i === itens.length - 1}
              onMover={(dir) => onMover(bloco, i, dir)}
              onMudou={onMudou}
              onErro={onErro}
            />
          ))}
        </div>
      )}

      <Adicionar bloco={bloco} disponiveis={disponiveis} onAdicionar={onAdicionar} />
    </section>
  );
}

function CardVitrine({
  vitrine, primeira, ultima, onMover, onMudou, onErro,
}: {
  vitrine: Vitrine;
  primeira: boolean;
  ultima: boolean;
  onMover: (direcao: -1 | 1) => void;
  onMudou: () => Promise<void> | void;
  onErro: (e: string | null) => void;
}) {
  const [form, setForm] = useState<Vitrine>(vitrine);
  const [aberto, setAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const eAtalho = vitrine.bloco === 'atalho';

  /**
   * Só reinicia o formulário quando a LINHA muda de vitrine — recarregar a
   * lista não pode jogar o retorno do servidor por cima do que está sendo
   * digitado (foi o bug dos banners, 07/08).
   *
   * Mas o que o SERVIDOR resolve tem que entrar: posição, ligado/desligado,
   * contagem de peças e o título já salvo. Sem isso, salvar "Blusas que a
   * gente ama" gravava certo e o cabeçalho continuava escrito "Blusas" até
   * alguém dar F5 — parece que não salvou (achado no teste da tela).
   */
  useEffect(() => {
    setForm((f) =>
      f.id !== vitrine.id
        ? vitrine
        : {
            ...f,
            posicao: vitrine.posicao,
            ativo: vitrine.ativo,
            tituloExibido: vitrine.tituloExibido,
            nomeFonte: vitrine.nomeFonte,
            href: vitrine.href,
            qtdPecas: vitrine.qtdPecas,
            imagemUrl: vitrine.imagemUrl,
          },
    );
  }, [vitrine]);

  const campo = <K extends keyof Vitrine>(k: K, v: Vitrine[K]) => setForm((f) => ({ ...f, [k]: v }));

  const temMudanca =
    (form.titulo ?? '') !== (vitrine.titulo ?? '') ||
    (form.tituloMobile ?? '') !== (vitrine.tituloMobile ?? '') ||
    (form.eyebrow ?? '') !== (vitrine.eyebrow ?? '') ||
    (form.descricao ?? '') !== (vitrine.descricao ?? '') ||
    (form.ctaLabel ?? '') !== (vitrine.ctaLabel ?? '') ||
    form.limite !== vitrine.limite;

  async function salvar(patch?: Partial<Vitrine>) {
    setSalvando(true);
    onErro(null);
    try {
      await api(`/site-vitrines/${vitrine.id}`, {
        method: 'PATCH',
        body: JSON.stringify(
          patch ?? {
            titulo: form.titulo, tituloMobile: form.tituloMobile, eyebrow: form.eyebrow,
            descricao: form.descricao, ctaLabel: form.ctaLabel, limite: form.limite,
          },
        ),
      });
      await onMudou();
    } catch (e: any) {
      onErro(mensagem(e, 'Não consegui salvar'));
    } finally {
      setSalvando(false);
    }
  }

  async function remover() {
    const aviso = eAtalho
      ? `Tirar o atalho "${form.tituloExibido}" da home?`
      : `Tirar a vitrine "${form.tituloExibido}" da home?\n\nOs textos que você escreveu se perdem. Pra guardar sem apagar, use "Desligar".`;
    if (!confirm(aviso)) return;
    setSalvando(true);
    try {
      await api(`/site-vitrines/${vitrine.id}`, { method: 'DELETE' });
      await onMudou();
    } catch (e: any) {
      onErro(mensagem(e, 'Não consegui remover'));
      setSalvando(false);
    }
  }

  const input = 'w-full px-2 py-2 border border-slate-300 rounded text-sm';
  const rotulo = 'text-[10px] font-bold text-slate-600 uppercase';
  const semPeca = form.qtdPecas === 0;

  return (
    <div className={`border rounded-lg ${form.ativo ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-70'}`}>
      <div className="flex items-center gap-3 p-3">
        {/* Posição + setas */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`w-7 h-7 rounded-full grid place-items-center text-xs font-black ${
            form.ativo ? 'bg-violet-100 text-violet-700' : 'bg-slate-200 text-slate-500'
          }`}>
            {form.posicao}
          </span>
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => onMover(-1)}
              disabled={primeira}
              title="Subir na home"
              className="p-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-25 disabled:hover:bg-transparent"
            >
              <ArrowUp className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => onMover(1)}
              disabled={ultima}
              title="Descer na home"
              className="p-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-25 disabled:hover:bg-transparent"
            >
              <ArrowDown className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Foto: só o atalho é um card com imagem */}
        {eAtalho && (
          <div className="w-10 h-12 rounded border border-slate-200 bg-slate-50 overflow-hidden shrink-0 grid place-items-center">
            {form.imagemUrl ? (
              // eslint-disable-next-line @next/next/no-img-element — miniatura da
              // foto que a tela de Categorias já resolve (manual ou automática).
              <img src={form.imagemUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <ImageIcon className="w-4 h-4 text-slate-300" />
            )}
          </div>
        )}

        {/* Identificação */}
        <button type="button" onClick={() => setAberto((a) => !a)} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-slate-800 truncate">{form.tituloExibido}</span>
            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
              {ROTULO_TIPO[form.tipo] ?? form.tipo}
            </span>
            {!form.ativo && (
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                desligada
              </span>
            )}
            {semPeca && (
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> sem peça — não sai no site
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5 truncate">
            {eAtalho ? 'leva pra' : 'peças de'} <b>{eAtalho ? form.href : form.nomeFonte}</b>
            {!eAtalho && ` · ${form.qtdPecas} no site`} ·{' '}
            <span className="text-violet-700">{aberto ? 'fechar' : eAtalho ? 'mudar o nome' : 'editar textos'}</span>
          </div>
        </button>

        {/* Ações */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void salvar({ ativo: !form.ativo } as any)}
            disabled={salvando}
            title={form.ativo ? 'Guardar sem apagar (some do site)' : 'Voltar pro site'}
            className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1 ${
              form.ativo
                ? 'border border-slate-300 text-slate-700 bg-white hover:bg-slate-50'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
          >
            {form.ativo ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {form.ativo ? 'Desligar' : 'Ligar'}
          </button>
          <button
            type="button"
            onClick={() => void remover()}
            disabled={salvando}
            title="Tirar da home"
            className="p-1.5 rounded border border-rose-200 text-rose-600 hover:bg-rose-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {aberto && (
        <div className="border-t border-slate-200 p-3 space-y-2 bg-slate-50/60">
          {eAtalho ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className={rotulo}>
                    Nome no card <span className="text-slate-400 normal-case">(vazio = {form.nomeFonte})</span>
                  </label>
                  <input
                    value={form.titulo ?? ''}
                    onChange={(e) => campo('titulo', e.target.value || null)}
                    placeholder={form.nomeFonte}
                    className={input}
                  />
                </div>
                <p className="text-[11px] text-slate-500 self-end pb-2">
                  A <b>foto</b> deste card vem da tela <b>Categorias</b> — trocar lá troca aqui.
                  Sem foto escolhida, o site usa a arte do mockup.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <label className={rotulo}>
                    Chamada <span className="text-slate-400 normal-case">(a linha de cima)</span>
                  </label>
                  <input
                    value={form.eyebrow ?? ''}
                    onChange={(e) => campo('eyebrow', e.target.value || null)}
                    placeholder="Acabou de chegar"
                    className={input}
                  />
                </div>
                <div>
                  <label className={rotulo}>
                    Título <span className="text-slate-400 normal-case">(vazio = {form.nomeFonte})</span>
                  </label>
                  <input
                    value={form.titulo ?? ''}
                    onChange={(e) => campo('titulo', e.target.value || null)}
                    placeholder={form.nomeFonte}
                    className={input}
                  />
                </div>
                <div>
                  <label className={rotulo}>
                    Título no celular <span className="text-slate-400 normal-case">(curto)</span>
                  </label>
                  <input
                    value={form.tituloMobile ?? ''}
                    onChange={(e) => campo('tituloMobile', e.target.value || null)}
                    placeholder={form.titulo ?? form.nomeFonte}
                    className={input}
                  />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <label className={rotulo}>Frase de apoio (opcional)</label>
                  <input
                    value={form.descricao ?? ''}
                    onChange={(e) => campo('descricao', e.target.value || null)}
                    placeholder="Uma frase curta que apresenta a vitrine."
                    className={input}
                  />
                </div>
                <div>
                  <label className={rotulo}>Texto do botão</label>
                  <input
                    value={form.ctaLabel ?? ''}
                    onChange={(e) => campo('ctaLabel', e.target.value || null)}
                    placeholder={`Ver tudo em ${form.tituloExibido}`}
                    className={input}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-[11px] text-slate-600 font-bold">
                  peças no carrossel
                  <input
                    type="number"
                    min={4}
                    max={24}
                    value={form.limite}
                    onChange={(e) => campo('limite', Number(e.target.value) || 12)}
                    className="ml-1.5 w-14 px-1.5 py-1 border border-slate-300 rounded text-xs"
                  />
                </label>
                <span className="text-[11px] text-slate-500">
                  {form.href ? (
                    <>o botão leva pra <code className="text-violet-700">{form.href}</code></>
                  ) : (
                    'sem página própria — a vitrine sai sem botão'
                  )}
                </span>
              </div>
            </>
          )}

          <div className="flex items-center gap-2">
            {temMudanca && (
              <span className="text-[11px] font-bold text-amber-700">
                Você mudou e ainda não salvou
              </span>
            )}
            <button
              type="button"
              onClick={() => void salvar()}
              disabled={salvando}
              className={`ml-auto inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg text-white disabled:opacity-50 ${
                temMudanca ? 'bg-amber-600 hover:bg-amber-700' : 'bg-violet-600 hover:bg-violet-700'
              }`}
            >
              {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Salvar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * O QUE DÁ PRA ADICIONAR — só o que existe de verdade: categoria com peça
 * publicada, coleção curada e as vitrines do catálogo inteiro. Não há campo
 * livre de propósito: vitrine digitada à mão vira carrossel vazio.
 */
function Adicionar({
  bloco, disponiveis, onAdicionar,
}: { bloco: Bloco; disponiveis: Disponivel[]; onAdicionar: (d: Disponivel) => Promise<void> }) {
  const [aberto, setAberto] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  if (!disponiveis.length) {
    return (
      <p className="text-[11px] text-slate-400 py-1">
        Tudo que podia entrar aqui já está na home.
      </p>
    );
  }

  return (
    <div className="border border-dashed border-slate-300 rounded-lg p-3 bg-white">
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        className="inline-flex items-center gap-1.5 text-xs font-bold text-violet-700 hover:text-violet-900"
      >
        <Plus className="w-4 h-4" /> {bloco === 'atalho' ? 'Adicionar atalho' : 'Adicionar vitrine'}
      </button>

      {aberto && (
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {disponiveis.map((d) => (
            <button
              key={`${d.tipo}:${d.chave}`}
              type="button"
              disabled={ocupado}
              onClick={async () => {
                setOcupado(true);
                await onAdicionar(d);
                setOcupado(false);
                setAberto(false);
              }}
              className="flex items-center justify-between gap-2 text-left border border-slate-200 rounded px-2.5 py-2 hover:border-violet-400 hover:bg-violet-50 disabled:opacity-50"
            >
              <span className="text-xs font-bold text-slate-700 truncate">{d.nome}</span>
              <span className="text-[10px] text-slate-500 shrink-0">
                {d.qtdPecas} peça(s) · {ROTULO_TIPO[d.tipo] ?? d.tipo}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
