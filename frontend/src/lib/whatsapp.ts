/**
 * ABRIR A CONVERSA NO WHATSAPP QUE JÁ ESTÁ NO PC (dono, 24/08/2026).
 *
 * A queixa, na tela de carrinhos: "toda vez que clica ele tenta abrir uma nova
 * aba de whats, isso não tá legal... devemos abrir direto no whats que já está
 * no pc". Era `window.open` no `web.whatsapp.com` — num turno de fila a
 * operadora terminava com dez abas, cada uma pedindo QR ou recarregando o
 * histórico inteiro.
 *
 * O protocolo `whatsapp://` entrega a conversa pro APLICATIVO instalado (que já
 * está logado) e não abre aba nenhuma. Funciona igual no celular.
 *
 * Vive em `lib/` porque o mesmo `window.open` está espalhado por mais de dez
 * telas (CRM, PDV, minha-loja, recuperação): quando cada uma for migrando, é um
 * import — e a regra fica escrita num lugar só.
 */

/** Só dígitos, com DDI 55 na frente. É o formato que o WhatsApp espera. */
export function telefoneWhatsApp(raw: string): string | null {
  const d = String(raw ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length < 10 || d.length > 11) return null;
  return `55${d}`;
}

/**
 * Abre a conversa no app instalado; cai pro WhatsApp Web só se o app não
 * atender.
 *
 * ⚠️ Precisa ser chamada DENTRO do clique (gesto síncrono) — protocolo e popup
 * disparados fora do gesto são bloqueados pelo navegador.
 *
 * @param telefone telefone com DDI, só dígitos (use `telefoneWhatsApp`)
 * @param mensagem texto já pronto, sem encode
 */
export function abrirWhatsApp(telefone: string, mensagem: string): void {
  const texto = encodeURIComponent(mensagem);

  // Âncora escondida em vez de `location.href`: trocar o href da página levaria
  // a tela embora se o protocolo não estivesse registrado no PC.
  const link = document.createElement('a');
  link.href = `whatsapp://send?phone=${telefone}&text=${texto}`;
  link.style.display = 'none';
  document.body.appendChild(link);

  /**
   * Sem o app instalado, o clique acima não faz NADA e quem clicou fica olhando
   * pro botão morto — o pior desfecho possível numa tela de atendimento. Se o
   * navegador perdeu o foco, o app abriu; se em 2s continuar em foco, caiu no
   * vazio, e aí sim vale a aba do Web.
   */
  let abriu = false;
  const marcarAberto = () => { abriu = true; };
  window.addEventListener('blur', marcarAberto, { once: true });
  document.addEventListener('visibilitychange', marcarAberto, { once: true });

  link.click();
  link.remove();

  window.setTimeout(() => {
    window.removeEventListener('blur', marcarAberto);
    document.removeEventListener('visibilitychange', marcarAberto);
    if (abriu || document.hidden) return;
    // Nome fixo na janela: caindo aqui duas vezes, reaproveita a MESMA aba em
    // vez de empilhar — que é a queixa que começou tudo isto.
    const w = window.open(`https://web.whatsapp.com/send?phone=${telefone}&text=${texto}`, 'lurds_whatsapp_web');
    if (!w) {
      alert('Não consegui abrir o WhatsApp deste PC. Abra o aplicativo e procure pelo telefone da cliente.');
    }
  }, 2000);
}
