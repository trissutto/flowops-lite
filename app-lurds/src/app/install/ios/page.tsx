'use client';

import Link from 'next/link';
import { ArrowLeft, Share, Plus, CheckCircle2, AlertCircle } from 'lucide-react';

/**
 * Tutorial visual passo-a-passo pra instalar PWA no iOS (Safari).
 *
 * Por que existe: iOS não tem prompt nativo de instalação como Android.
 * Cliente precisa: Safari → botão Compartilhar → Adicionar à Tela de Início.
 * Sem isso, push notifications NÃO funcionam no iOS.
 *
 * Visual: passos numerados com ícones grandes, contraste alto.
 */
export default function IOSInstallTutorial() {
  return (
    <div className="min-h-dvh pb-12">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link
          href="/"
          className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Como instalar no iPhone</h1>
      </header>

      {/* Aviso: precisa Safari */}
      <div className="mt-6 mx-5 card-gold-border bg-gold/10 border-gold/40 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-gold shrink-0 mt-0.5" />
        <div className="text-sm">
          <strong className="text-gold">Importante:</strong> precisa abrir esta página no{' '}
          <strong>Safari</strong> (não funciona no Chrome do iPhone). Se estiver em outro
          navegador, copia o link e cola no Safari.
        </div>
      </div>

      {/* Passos */}
      <div className="mt-8 px-5 space-y-6">
        <Step
          number={1}
          title="Toque no botão Compartilhar"
          description={
            <>
              No rodapé do Safari, toque no ícone <strong>Compartilhar</strong>{' '}
              (quadrado com setinha pra cima).
            </>
          }
          icon={<Share className="w-12 h-12 text-gold" />}
        />

        <Step
          number={2}
          title='Selecione "Adicionar à Tela de Início"'
          description={
            <>
              Role pra baixo no menu que abriu e toque em{' '}
              <strong>"Adicionar à Tela de Início"</strong>.
            </>
          }
          icon={<Plus className="w-12 h-12 text-gold" />}
        />

        <Step
          number={3}
          title="Confirme e pronto!"
          description={
            <>
              Toque em <strong>Adicionar</strong> no canto superior direito. O ícone do
              Lurd's aparece na sua tela inicial igual aos outros apps.
            </>
          }
          icon={<CheckCircle2 className="w-12 h-12 text-gold" />}
        />
      </div>

      {/* Recompensa */}
      <div className="mt-10 mx-5 rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-5 text-ink">
        <h3 className="font-serif text-xl font-black">
          🎁 Depois de instalar, ganhe R$ 20
        </h3>
        <p className="text-sm mt-1 opacity-90">
          Cadastra seu CPF e o cashback de R$ 20 cai automaticamente na sua primeira compra.
        </p>
      </div>

      {/* FAQ rápido */}
      <div className="mt-10 px-5 space-y-4">
        <h3 className="font-serif text-lg font-bold">Dúvidas comuns</h3>

        <details className="card-dark group">
          <summary className="cursor-pointer font-semibold text-sm flex justify-between items-center">
            Vou receber notificação de promoção?
            <span className="text-gold group-open:rotate-180 transition">⌃</span>
          </summary>
          <p className="mt-2 text-sm text-cream/70">
            Sim. Depois de instalar e abrir o app, você pode autorizar as notificações pra
            receber promoções, ofertas exclusivas, e avisos quando uma live começar.
          </p>
        </details>

        <details className="card-dark group">
          <summary className="cursor-pointer font-semibold text-sm flex justify-between items-center">
            Ocupa espaço no celular?
            <span className="text-gold group-open:rotate-180 transition">⌃</span>
          </summary>
          <p className="mt-2 text-sm text-cream/70">
            Menos de 5 MB. É bem mais leve que apps comuns porque é um app web (PWA).
          </p>
        </details>

        <details className="card-dark group">
          <summary className="cursor-pointer font-semibold text-sm flex justify-between items-center">
            Como desinstalo se eu quiser?
            <span className="text-gold group-open:rotate-180 transition">⌃</span>
          </summary>
          <p className="mt-2 text-sm text-cream/70">
            Igual aos outros apps: segura o ícone na tela inicial e toca em "Remover App".
          </p>
        </details>
      </div>

      {/* Voltar pro app */}
      <div className="mt-10 px-5">
        <Link href="/" className="btn-gold-lg w-full">
          Voltar pro app
        </Link>
      </div>
    </div>
  );
}

function Step({
  number,
  title,
  description,
  icon,
}: {
  number: number;
  title: string;
  description: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="card-dark flex gap-4">
      <div className="shrink-0 flex flex-col items-center">
        <div className="w-10 h-10 rounded-full bg-gold text-ink font-black font-serif text-lg flex items-center justify-center shadow-gold">
          {number}
        </div>
      </div>
      <div className="flex-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-serif text-lg font-bold leading-tight">{title}</h3>
          <div className="shrink-0">{icon}</div>
        </div>
        <p className="mt-2 text-sm text-cream/80 leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
