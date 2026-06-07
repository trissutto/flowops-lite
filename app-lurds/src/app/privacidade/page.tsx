import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata = { title: 'Política de Privacidade' };

export default function PrivacidadePage() {
  return (
    <div className="min-h-dvh pb-12">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Política de Privacidade</h1>
      </header>
      <article className="prose-app px-5 mt-6 text-sm text-cream/80 leading-relaxed space-y-4">
        <p className="text-xs text-cream/50">Última atualização: 07/06/2026</p>

        <h2 className="font-serif text-lg font-bold text-white">1. Quem somos</h2>
        <p>
          Lurd's Plus Size é uma rede de lojas femininas. Esta política descreve como
          coletamos, usamos e protegemos suas informações pessoais no app Lurd's
          (app.lurds.com.br).
        </p>

        <h2 className="font-serif text-lg font-bold text-white">2. Dados que coletamos</h2>
        <ul className="list-disc list-inside space-y-1">
          <li>CPF, nome completo, telefone (WhatsApp) e e-mail (opcional)</li>
          <li>Histórico de compras nas nossas lojas físicas e site</li>
          <li>Saldo e movimentações de cashback</li>
          <li>Preferências de notificação (push)</li>
          <li>Dados técnicos (navegador, sistema operacional, idioma)</li>
        </ul>

        <h2 className="font-serif text-lg font-bold text-white">3. Como usamos</h2>
        <ul className="list-disc list-inside space-y-1">
          <li>Identificá-la como cliente e creditar cashback</li>
          <li>Enviar promoções segmentadas pelo seu perfil</li>
          <li>Avisar quando uma live começar</li>
          <li>Comunicar status de pedidos do site</li>
          <li>Melhorar o app analisando uso agregado</li>
        </ul>

        <h2 className="font-serif text-lg font-bold text-white">4. Compartilhamento</h2>
        <p>
          Não vendemos seus dados. Compartilhamos apenas com prestadores essenciais
          (hospedagem Vercel/Railway, envio de notificação Google FCM/Apple APNs)
          sob acordo de confidencialidade.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">5. Seus direitos (LGPD)</h2>
        <p>
          Você pode solicitar a qualquer momento: acesso aos seus dados, correção,
          exclusão (esquecimento), portabilidade ou revogação do consentimento.
          Basta entrar em contato pelo WhatsApp da loja ou e-mail
          <a href="mailto:contato@lurds.com.br" className="text-gold underline ml-1">
            contato@lurds.com.br
          </a>.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">6. Retenção</h2>
        <p>
          Mantemos seus dados enquanto sua conta estiver ativa. Após pedido de exclusão,
          dados pessoais são apagados em até 30 dias (exceto obrigações fiscais/legais).
        </p>

        <h2 className="font-serif text-lg font-bold text-white">7. Cookies</h2>
        <p>
          Usamos armazenamento local (localStorage) pra manter você logada e
          lembrar preferências. Não usamos cookies de rastreamento de terceiros.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">8. Crianças</h2>
        <p>
          O app é destinado a maiores de 18 anos. Não coletamos dados de menores intencionalmente.
        </p>

        <h2 className="font-serif text-lg font-bold text-white">9. Mudanças</h2>
        <p>
          Podemos atualizar esta política. Mudanças importantes serão comunicadas
          por push notification ou e-mail.
        </p>
      </article>
    </div>
  );
}
