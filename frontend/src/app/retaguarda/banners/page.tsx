'use client';

/**
 * BANNERS DA VITRINE — troca a cara do site sem deploy.
 *
 * Antes disto, o hero da home e a tarja do topo eram constantes no código do
 * ecommerce: trocar a foto de campanha era commit + build + deploy. Aqui é
 * cadastro.
 *
 * Três slots, porque são três lugares com regras diferentes:
 *   home-hero   → o banner grande (foto + título + dois botões)
 *   home-faixa  → faixas editoriais no meio da home
 *   tarja-topo  → as frases que giram acima do menu (só texto e link)
 *
 * A JANELA (de/até) é o que evita acordar de madrugada pra tirar campanha do
 * ar: vazio = vale sempre; preenchido = entra e sai sozinho.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  Image as ImageIcon, Loader2, Plus, Save, Smartphone, Trash2, Monitor,
} from 'lucide-react';

type Banner = {
  id: string;
  slot: string;
  eyebrow: string | null;
  titulo: string | null;
  destaque: string | null;
  subtitulo: string | null;
  imagemUrl: string | null;
  imagemMobileUrl: string | null;
  alt: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  cta2Label: string | null;
  cta2Href: string | null;
  ordem: number;
  ativo: boolean;
  inicioEm: string | null;
  fimEm: string | null;
};

const SLOTS: { id: string; nome: string; ajuda: string; comFoto: boolean }[] = [
  {
    id: 'home-hero',
    nome: 'Hero da home',
    ajuda: 'O banner grande da entrada. Foto na horizontal (2400×1350 ou maior) e, se quiser, um recorte vertical pro celular.',
    comFoto: true,
  },
  {
    id: 'home-faixa',
    nome: 'Faixas da home',
    ajuda: 'Blocos editoriais no meio da home. Entram na ordem definida abaixo.',
    comFoto: true,
  },
  {
    id: 'tarja-topo',
    nome: 'Tarja do topo',
    ajuda: 'As frases que giram na faixa preta acima do menu. Só texto e link — sem foto.',
    comFoto: false,
  },
  {
    id: 'lojas-hero',
    nome: 'Capa de Nossas Lojas',
    ajuda:
      'A foto do topo de /lojas. Horizontal, 2000px de largura ou mais: ela ocupa a tela inteira e o texto entra por cima, então evite arte com informação nos cantos. Sem banner aqui, vale a foto padrão da página.',
    comFoto: true,
  },
];

function paraInput(v: string | null): string {
  // <input type="datetime-local"> não aceita ISO com fuso; corta no minuto.
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BannersPage() {
  const [slot, setSlot] = useState(SLOTS[0].id);
  const [lista, setLista] = useState<Banner[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const meta = SLOTS.find((s) => s.id === slot)!;

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setLista(await api<Banner[]>(`/site-banners?slot=${encodeURIComponent(slot)}`));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, [slot]);

  useEffect(() => { void carregar(); }, [carregar]);

  async function criar() {
    try {
      const novo = await api<Banner>('/site-banners', {
        method: 'POST',
        body: JSON.stringify({
          slot,
          titulo: 'Novo banner',
          ordem: lista.length,
          ativo: false, // nasce fora do ar: ninguém publica sem foto e sem revisar
        }),
      });
      setLista((l) => [...l, novo]);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui criar');
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      <header>
        <h1 className="text-xl font-bold text-slate-800">Banners da vitrine</h1>
        <p className="text-sm text-slate-500">
          O que você muda aqui aparece no site em até 1 hora (o site guarda a página pronta
          pra abrir rápido). Banner fora do ar não é apagado — é só desligar.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {SLOTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSlot(s.id)}
            className={`px-3 py-2 rounded-lg text-sm font-bold border ${
              slot === s.id
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {s.nome}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-500">{meta.ajuda}</p>

      {erro && <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{erro}</p>}

      {carregando ? (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </p>
      ) : (
        <div className="space-y-3">
          {lista.map((b) => (
            <CardBanner
              key={b.id}
              banner={b}
              comFoto={meta.comFoto}
              onMudou={(novo) => setLista((l) => l.map((x) => (x.id === novo.id ? novo : x)))}
              onRemovido={() => setLista((l) => l.filter((x) => x.id !== b.id))}
            />
          ))}
          {lista.length === 0 && (
            <p className="text-sm text-slate-400 border border-dashed border-slate-300 rounded-lg p-6 text-center">
              Nenhum banner neste espaço ainda.
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void criar()}
        className="inline-flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700"
      >
        <Plus className="w-4 h-4" /> Novo banner
      </button>
    </div>
  );
}

function CardBanner({
  banner, comFoto, onMudou, onRemovido,
}: {
  banner: Banner;
  comFoto: boolean;
  onMudou: (b: Banner) => void;
  onRemovido: () => void;
}) {
  const [form, setForm] = useState<Banner>(banner);
  const [salvando, setSalvando] = useState(false);
  const [subindo, setSubindo] = useState<'desktop' | 'mobile' | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const fileDesktop = useRef<HTMLInputElement>(null);
  const fileMobile = useRef<HTMLInputElement>(null);

  /**
   * ⚠️ A TELA NÃO PODE APAGAR O QUE A PESSOA DIGITOU (bug real, 07/08).
   *
   * Antes: `setForm(banner)` a cada mudança da prop. Só que subir a foto (e,
   * depois, publicar) devolve o banner do SERVIDOR — sem os textos que ainda
   * estavam só na tela — e o efeito jogava esse retorno por cima do formulário.
   * O título e o texto sumiam na frente do dono, que redigitava; se ele
   * salvasse depois de um upload, gravava os campos VAZIOS por cima dos bons.
   * Foi assim que o "BANNER TESTE / Banner Novidades Agosto" virou tudo null.
   *
   * Agora: troca de banner (id diferente) reinicia o formulário; atualização do
   * MESMO banner só traz os campos que são do servidor — imagem, publicação e
   * carimbos. O que está sendo digitado fica onde está.
   */
  useEffect(() => {
    setForm((f) => {
      if (f.id !== banner.id) return banner;
      return {
        ...f,
        imagemUrl: banner.imagemUrl,
        imagemMobileUrl: banner.imagemMobileUrl,
        ativo: banner.ativo,
      };
    });
  }, [banner]);

  function campo<K extends keyof Banner>(k: K, v: Banner[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const salvo = await api<Banner>(`/site-banners/${form.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          eyebrow: form.eyebrow, titulo: form.titulo, destaque: form.destaque,
          subtitulo: form.subtitulo, alt: form.alt,
          ctaLabel: form.ctaLabel, ctaHref: form.ctaHref,
          cta2Label: form.cta2Label, cta2Href: form.cta2Href,
          ordem: form.ordem, ativo: form.ativo,
          inicioEm: form.inicioEm || null, fimEm: form.fimEm || null,
        }),
      });
      onMudou(salvo);
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  /**
   * PUBLICAR VALE NO CLIQUE (dono 07/08).
   *
   * Antes isto era um checkbox pequeno rotulado "Fora do ar" — que se lê como
   * ETIQUETA DE ESTADO, não como interruptor — e ainda dependia de lembrar de
   * clicar em Salvar. O dono montou o banner inteiro, saiu da tela e o site
   * seguiu com o hero antigo, sem nada avisando que faltava um passo.
   * Agora é um botão que diz o que faz e grava na hora.
   */
  async function alternarAtivo() {
    const novo = !form.ativo;
    setSalvando(true);
    setErro(null);
    campo('ativo', novo);
    try {
      const salvo = await api<Banner>(`/site-banners/${form.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ativo: novo }),
      });
      onMudou(salvo);
    } catch (e: any) {
      campo('ativo', !novo); // desfaz: a tela não pode mentir sobre o que está no ar
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui mudar a publicação');
    } finally {
      setSalvando(false);
    }
  }

  async function subir(arquivo: File, variante: 'desktop' | 'mobile') {
    setSubindo(variante);
    setErro(null);
    try {
      const fd = new FormData();
      fd.append('file', arquivo);
      const salvo = await api<Banner>(`/site-banners/${form.id}/imagem?variante=${variante}`, {
        method: 'POST',
        body: fd as any,
        // O Content-Type do multipart é tirado dentro do api() quando o body é
        // FormData — passar {} aqui NÃO removia nada (ver lib/api.ts).
      });
      onMudou(salvo);
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui subir a imagem');
    } finally {
      setSubindo(null);
    }
  }

  async function remover() {
    if (!confirm('Apagar este banner? A imagem sai do servidor junto.')) return;
    try {
      await api(`/site-banners/${form.id}`, { method: 'DELETE' });
      onRemovido();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui apagar');
    }
  }

  /** Texto/janela/ordem diferentes do que está gravado = falta salvar. */
  const temMudanca = (
    ['eyebrow', 'titulo', 'destaque', 'subtitulo', 'alt',
      'ctaLabel', 'ctaHref', 'cta2Label', 'cta2Href', 'inicioEm', 'fimEm'] as const
  ).some((k) => (form[k] ?? '') !== (banner[k] ?? '')) || form.ordem !== banner.ordem;

  const input = 'w-full px-2 py-2 border border-slate-300 rounded text-sm';
  const rotulo = 'text-[10px] font-bold text-slate-600 uppercase';

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-black uppercase px-2 py-1 rounded ${
              form.ativo
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                : 'bg-slate-100 text-slate-500 border border-slate-300'
            }`}
          >
            {form.ativo ? '● No ar' : '○ Fora do ar'}
          </span>
          <button
            type="button"
            onClick={() => void alternarAtivo()}
            disabled={salvando || (comFoto && !form.imagemUrl && !form.ativo)}
            title={
              comFoto && !form.imagemUrl && !form.ativo
                ? 'Suba a foto do computador antes de publicar'
                : form.ativo
                  ? 'Tira do site agora (não apaga o banner)'
                  : 'Coloca no site agora — sem precisar salvar depois'
            }
            className={`text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-40 ${
              form.ativo
                ? 'border border-slate-300 text-slate-700 bg-white hover:bg-slate-50'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
          >
            {salvando ? '...' : form.ativo ? 'Tirar do ar' : 'Publicar no site'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">
            ordem
            <input
              type="number"
              value={form.ordem}
              onChange={(e) => campo('ordem', Number(e.target.value) || 0)}
              className="ml-1 w-14 px-1.5 py-1 border border-slate-300 rounded text-sm"
            />
          </label>
          <button type="button" onClick={() => void remover()} title="Apagar"
            className="p-1.5 rounded text-rose-600 hover:bg-rose-50">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {comFoto && (
        <div className="grid gap-2 sm:grid-cols-2">
          {(['desktop', 'mobile'] as const).map((variante) => {
            const url = variante === 'desktop' ? form.imagemUrl : form.imagemMobileUrl;
            const ref = variante === 'desktop' ? fileDesktop : fileMobile;
            const Icone = variante === 'desktop' ? Monitor : Smartphone;
            return (
              <div key={variante}>
                <p className={rotulo}>
                  <Icone className="w-3 h-3 inline mr-1" />
                  {variante === 'desktop' ? 'Foto (computador)' : 'Recorte vertical (celular) — opcional'}
                </p>
                <button
                  type="button"
                  onClick={() => ref.current?.click()}
                  disabled={subindo !== null}
                  className="mt-1 w-full aspect-[16/7] rounded-lg border-2 border-dashed border-slate-300 overflow-hidden hover:border-violet-400 disabled:opacity-50 relative bg-slate-50"
                >
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xs text-slate-500 flex items-center justify-center gap-1.5 h-full">
                      <ImageIcon className="w-4 h-4" /> escolher imagem
                    </span>
                  )}
                  {subindo === variante && (
                    <span className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <Loader2 className="w-5 h-5 animate-spin text-white" />
                    </span>
                  )}
                </button>
                <input
                  ref={ref} type="file" accept="image/*" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void subir(f, variante);
                    e.target.value = '';
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={rotulo}>Chapéu <span className="text-slate-400">(linha pequena)</span></label>
          <input className={input} value={form.eyebrow ?? ''} onChange={(e) => campo('eyebrow', e.target.value)} />
        </div>
        <div>
          <label className={rotulo}>Título</label>
          <input className={input} value={form.titulo ?? ''} onChange={(e) => campo('titulo', e.target.value)} />
        </div>
        <div>
          <label className={rotulo}>Palavra em destaque</label>
          <input
            className={input} value={form.destaque ?? ''}
            onChange={(e) => campo('destaque', e.target.value)}
            placeholder="sai em itálico dourado"
          />
        </div>
      </div>

      <div>
        <label className={rotulo}>Texto</label>
        <textarea
          className={`${input} h-16`} value={form.subtitulo ?? ''}
          onChange={(e) => campo('subtitulo', e.target.value)}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <div>
          <label className={rotulo}>Botão 1</label>
          <input className={input} value={form.ctaLabel ?? ''} onChange={(e) => campo('ctaLabel', e.target.value)} />
        </div>
        <div>
          <label className={rotulo}>Link 1</label>
          <input className={`${input} font-mono`} value={form.ctaHref ?? ''} placeholder="/novidades"
            onChange={(e) => campo('ctaHref', e.target.value)} />
        </div>
        <div>
          <label className={rotulo}>Botão 2</label>
          <input className={input} value={form.cta2Label ?? ''} onChange={(e) => campo('cta2Label', e.target.value)} />
        </div>
        <div>
          <label className={rotulo}>Link 2</label>
          <input className={`${input} font-mono`} value={form.cta2Href ?? ''} placeholder="/lojas"
            onChange={(e) => campo('cta2Href', e.target.value)} />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={rotulo}>Entra em <span className="text-slate-400">(vazio = já)</span></label>
          <input type="datetime-local" className={input} value={paraInput(form.inicioEm)}
            onChange={(e) => campo('inicioEm', e.target.value || null)} />
        </div>
        <div>
          <label className={rotulo}>Sai em <span className="text-slate-400">(vazio = fica)</span></label>
          <input type="datetime-local" className={input} value={paraInput(form.fimEm)}
            onChange={(e) => campo('fimEm', e.target.value || null)} />
        </div>
        {comFoto && (
          <div>
            <label className={rotulo}>Descrição da imagem <span className="text-slate-400">(acessibilidade)</span></label>
            <input className={input} value={form.alt ?? ''} onChange={(e) => campo('alt', e.target.value)} />
          </div>
        )}
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      {/* TEXTO NÃO SALVO PRECISA GRITAR. Foto e publicação gravam sozinhas; os
          textos não — e nada dizia isso. O botão fica âmbar e escrito "Salvar
          textos" enquanto houver mudança pendente. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className={`inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg text-white disabled:opacity-50 ${
            temMudanca ? 'bg-amber-600 hover:bg-amber-700' : 'bg-violet-600 hover:bg-violet-700'
          }`}
        >
          {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {temMudanca ? 'Salvar textos' : 'Salvar'}
        </button>
        {temMudanca && (
          <span className="text-[11px] font-bold text-amber-700">
            Você mudou os textos e ainda não salvou
          </span>
        )}
      </div>
    </div>
  );
}
