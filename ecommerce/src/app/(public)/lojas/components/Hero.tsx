'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
import { MapPin, ShoppingBag } from 'lucide-react';
import { AppLink } from '@/components/ui/AppLink';
import { site, imgSrc, BLUR_DATA_URL } from '../lib';

interface Props {
  onFindStore: () => void;
  onlineHref: string;
  onOnlineClick: () => void;
  /**
   * Arte do cadastro de banners (slot `lojas-hero`). Sem ela vale a foto
   * oficial do `lojas.json`; sem as duas, a arte tipográfica da marca.
   */
  imagem?: string | null;
}

export default function Hero({ onFindStore, onlineHref, onOnlineClick, imagem }: Props) {
  /**
   * CAPA: arte da retaguarda > foto oficial do cadastro > arte tipográfica.
   *
   * A terceira é o estado de hoje (16/08/2026): as fotos de banco de imagem
   * saíram do `lojas.json` a pedido do dono — só foto oficial da Lurds entra
   * no site. Sem capa a página NÃO fica sem hero: entra o fundo editorial da
   * marca (tinta + halo dourado + monograma), que é honesto e mantém o texto
   * branco legível. Subir a arte no slot `lojas-hero` ou preencher
   * `site.heroImage` liga a foto de volta sozinho.
   */
  const capa = imagem || (site.heroImage ? imgSrc(site.heroImage, 2000) : null);

  return (
    <section className="relative flex min-h-[55svh] items-center justify-center overflow-hidden bg-[var(--lj-ink)] py-12 sm:min-h-[70svh] sm:py-16">
      {capa ? (
        /* Fotografia editorial com zoom-out lento na entrada */
        <motion.div
          initial={{ scale: 1.06 }}
          animate={{ scale: 1 }}
          transition={{ duration: 2.2, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0"
        >
          <Image
            src={capa}
            alt="Lurd's Plus Size — moda plus size elegante"
            fill
            priority
            sizes="100vw"
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover object-center"
          />
        </motion.div>
      ) : (
        <div className="lojas-grain absolute inset-0" aria-hidden>
          <div
            className="absolute -right-32 -top-40 h-[42rem] w-[42rem] rounded-full opacity-45 blur-3xl"
            style={{ background: 'radial-gradient(circle, var(--lj-gold) 0%, transparent 70%)' }}
          />
          <div
            className="absolute -bottom-48 -left-40 h-[38rem] w-[38rem] rounded-full opacity-25 blur-3xl"
            style={{ background: 'radial-gradient(circle, var(--lj-gold-soft) 0%, transparent 70%)' }}
          />
          <span className="lojas-serif absolute inset-0 flex items-center justify-center text-[52vw] font-medium italic leading-none text-white/[0.05] sm:text-[26rem]">
            L
          </span>
        </div>
      )}
      {/* Gradiente leve só pra ancorar o texto — a foto continua protagonista */}
      {capa && <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/25 to-black/55" />}

      <div className="relative z-10 mx-auto max-w-4xl px-6 text-center text-white">
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="text-[11px] font-medium uppercase tracking-[0.4em] text-[var(--lj-gold-soft)]"
        >
          Lurd&apos;s Plus Size
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.35 }}
          className="lojas-serif mt-4 text-4xl font-medium leading-[1.08] sm:mt-6 sm:text-6xl lg:text-7xl"
        >
          Encontre a Lurds
          <br />
          <span className="italic text-[var(--lj-gold-soft)]">mais próxima</span> de você
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.5 }}
          className="mx-auto mt-4 max-w-xl text-sm font-light leading-relaxed text-white/85 sm:mt-6 sm:text-base"
        >
          Atendimento acolhedor, provadores confortáveis e moda plus size do 46 ao 60.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.65 }}
          className="mt-6 flex flex-col items-center justify-center gap-3 sm:mt-8 sm:flex-row sm:gap-4"
        >
          <button
            onClick={onFindStore}
            className="group inline-flex w-full items-center justify-center gap-3 rounded-full bg-white px-9 py-4 text-sm font-medium uppercase tracking-[0.18em] text-[var(--lj-ink)] transition-all duration-300 hover:bg-[var(--lj-gold-soft)] sm:w-auto"
          >
            <MapPin className="h-4 w-4 text-[var(--lj-gold-strong)] transition-colors group-hover:text-[var(--lj-ink)]" />
            Encontrar minha loja
          </button>
          <AppLink
            href={onlineHref}
            onClick={onOnlineClick}
            className="inline-flex w-full items-center justify-center gap-3 rounded-full border border-white/60 px-9 py-4 text-sm font-medium uppercase tracking-[0.18em] text-white transition-all duration-300 hover:border-white hover:bg-white/10 sm:w-auto"
          >
            <ShoppingBag className="h-4 w-4" />
            Comprar online
          </AppLink>
        </motion.div>
      </div>

    </section>
  );
}
