'use client';
import Link from 'next/link';
import { ArrowLeft, KeyRound, MessageCircle } from 'lucide-react';

export default function EsqueciSenhaPage() {
  return (
    <div className="min-h-dvh flex flex-col px-6 pt-6 pb-8">
      <header className="flex items-center gap-3 mb-6">
        <Link href="/login" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
      </header>
      <div className="text-center mb-8">
        <KeyRound className="w-12 h-12 mx-auto text-gold" />
        <h1 className="font-serif text-2xl font-bold mt-3">Esqueci minha senha</h1>
        <p className="text-sm text-cream/70 mt-2">
          Em breve você poderá recuperar pelo WhatsApp.<br />
          Enquanto isso, fala com a gente:
        </p>
      </div>
      <a
        href="https://wa.me/5511999999999?text=Oi%20Lurd's,%20esqueci%20minha%20senha%20do%20app"
        target="_blank"
        rel="noopener"
        className="btn-gold-lg w-full"
      >
        <MessageCircle className="w-5 h-5" />
        Falar no WhatsApp
      </a>
      <Link href="/login" className="btn-ghost mt-4 mx-auto">
        Voltar pro login
      </Link>
    </div>
  );
}
