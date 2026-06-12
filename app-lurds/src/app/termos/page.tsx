import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata = { title: 'Termos de Uso' };

export default function TermosPage() {
  return (
    <div className="min-h-dvh pb-12">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Termos de Uso</h1>
      </header>
      <article className="px-5 mt-6 text-sm text-cream/80 leading-relaxed space-y-4">
        <p className="text-xs text-cream/50">Última atualização: 07/06/2026</p>

        <h2 className="font-serif text-lg font-bold text-white">1. Aceitação</h2>
        <p>
          Ao criar conta no app Lurd's Plus Size você concorda com estes termos.
          Se não concordar, não use o app.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">2. Conta e segurança</h2>
        <ul className="list-disc list-inside space-y-1">
          <li>1 conta por CPF. Não compartilhe sua senha</li>
          <li>Você é responsável pela atividade na sua conta</li>
          <li>Suspeitou de uso indevido? Avisa imediatamente</li>
        </ul>

        <h2 className="font-serif text-lg font-bold text-white">3. Cashback</h2>
        <ul className="list-disc list-inside space-y-1">
          <li>É um benefício de fidelidade — não é dinheiro</li>
          <li>Pode ser usado em compras na loja física ou site Lurd's</li>
          <li>Validade conforme regra interna (mín. 30 dias)</li>
          <li>Não cumulativo com outras promoções, salvo indicado</li>
          <li>Bônus de R$ 20 (instalação + 1ª compra): 1 por CPF</li>
        </ul>

        <h2 className="font-serif text-lg font-bold text-white">4. Compras</h2>
        <p>
          As compras pelo app redirecionam pro nosso site lurds.com.br ou são
          finalizadas em loja física. As regras de cada canal seguem os termos
          do respectivo canal.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">5. Notificações</h2>
        <p>
          Você pode ativar/desativar push notifications a qualquer momento em
          /conta/notificacoes. Promoções são segmentadas por preferência e perfil.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">6. Uso aceitável</h2>
        <p>
          Não use o app pra: tentar burlar segurança, automatizar requisições
          em massa, criar contas falsas, ou qualquer ato que prejudique outros usuários.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">7. Encerramento</h2>
        <p>
          Você pode encerrar sua conta a qualquer momento. A Lurd's pode encerrar
          contas que violem estes termos, com aviso prévio quando possível.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">8. Foro</h2>
        <p>
          Estes termos são regidos pelas leis brasileiras. Foro: comarca de
          Itanhaém — SP.
        </p>
      </article>
    </div>
  );
}
