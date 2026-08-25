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
 * ── ONDE VALE (25/08/2026, ordem do dono: "todos os botões whats do sistema
 * seguem esta mesma rotina quando precisarmos interagir com clientes") ──
 *
 * TODO botão de WhatsApp de dentro do SISTEMA passa por aqui — quem clica é
 * gente da casa, num PC da casa, com o app logado: carrinhos abandonados
 * (matriz e loja), CRM (segmentos, lista personalizada, ficha), leads,
 * recuperação, PDV (link de pagamento e PIX), recebimentos do crediário,
 * live-pdv, consultar (transferência entre lojas), separação e a ficha do
 * pedido. Nenhum deles monta `wa.me`/`web.whatsapp.com` na mão.
 *
 * ⚠️ NÃO vale nas páginas PÚBLICAS — vitrine, /nossaslojas, /qr/<token>,
 * /pg/<token>, o modal do Fit e o site novo (`ecommerce/`). Ali quem clica é a
 * CLIENTE, no aparelho dela: `wa.me` é o link universal e forçar o protocolo
 * do app quebraria quem usa o WhatsApp pelo navegador.
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
 * @param telefone telefone da cliente, cru ou já normalizado. Vazio/omitido
 *   abre o WhatsApp na LISTA DE CONTATOS (é o caso de "mandar o link de
 *   pagamento pra alguém" — quem escolhe o destino é quem clicou).
 * @param mensagem texto já pronto, sem encode
 * @returns `false` quando o telefone veio preenchido mas não é telefone —
 *   quem chamou decide o que dizer; o botão não pode simplesmente morrer.
 */
export function abrirWhatsApp(telefone?: string | null, mensagem = ''): boolean {
  const texto = encodeURIComponent(mensagem);

  /**
   * A NORMALIZAÇÃO MORA AQUI, não em cada tela.
   *
   * Antes cada botão fazia seu próprio `replace(/\D/g,'')` + `55` na mão e
   * cada um errava de um jeito: uns mandavam DDI dobrado (5555…), outros
   * mandavam o número cru com parêntese, e o WhatsApp abria em conversa
   * nenhuma. `telefoneWhatsApp` é idempotente — aceita `(13) 99621-8277`,
   * `13996218277` e `5513996218277` e devolve sempre a mesma coisa.
   */
  const cru = String(telefone ?? '').trim();
  const numero = cru ? telefoneWhatsApp(cru) : null;
  if (cru && !numero) return false;

  const destino = numero ? `phone=${numero}&` : '';

  // Âncora escondida em vez de `location.href`: trocar o href da página levaria
  // a tela embora se o protocolo não estivesse registrado no PC.
  const link = document.createElement('a');
  link.href = `whatsapp://send?${destino}text=${texto}`;
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
    const w = window.open(
      `https://web.whatsapp.com/send?${destino}text=${texto}`,
      'lurds_whatsapp_web',
    );
    if (!w) {
      alert('Não consegui abrir o WhatsApp deste PC. Abra o aplicativo e procure pelo telefone da cliente.');
    }
  }, 2000);
  return true;
}

/**
 * O MESMO clique, com a reclamação já pronta pra quem não tem telefone.
 *
 * Quase toda tela repetia estas quatro linhas (valida, avisa, abre) e algumas
 * esqueciam o aviso — o botão sumia ou não fazia nada, que é o pior desfecho
 * numa tela de atendimento. Use nos botões que falam com CLIENTE.
 */
export function falarComCliente(telefone?: string | null, mensagem = ''): void {
  if (!abrirWhatsApp(telefone, mensagem)) {
    alert('Essa cliente não tem um telefone válido no cadastro — não dá pra abrir o WhatsApp.');
  }
}
