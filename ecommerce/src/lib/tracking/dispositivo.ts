/**
 * CELULAR, TABLET OU PC — classificação pelo user-agent, no servidor.
 *
 * ── O BURACO QUE ISTO FECHA (medido em 31/08/2026) ──
 *
 * Das **20.767 sessões** de uma semana, **100% estavam sem dispositivo**: a
 * chave simplesmente não existia em `site_eventos.dados`. E **52% do tráfego
 * vem de `paid_social`**, que é celular quase inteiro.
 *
 * Isso deixava cego o time inteiro de perguntas que decidem layout: a queda de
 * 88,5% entre "viu a peça" e "pôs na sacola" é a mesma no celular e no PC? O
 * checkout perde 41% no passo da entrega nos dois? Sem a resposta, toda decisão
 * de tela é palpite — inclusive as que saíram nesta mesma leva.
 *
 * ── POR QUE NO SERVIDOR, E NÃO NO NAVEGADOR ──
 *
 * `window.innerWidth` responde a pergunta errada (janela ≠ aparelho) e some em
 * quem bloqueia script. O user-agent já chega no `/api/events` — que é o ÚNICO
 * ponto com ele na mão, pelo mesmo motivo documentado em `bot-detect.ts`: em
 * qualquer outro lugar o UA é o da Vercel. Um lugar só, nenhum byte a mais
 * saindo do navegador, e funciona igual pra quem recusou o banner.
 *
 * ── O QUE NÃO ENTRA ──
 *
 * Modelo, versão de sistema, marca. `site_eventos` é tabela de métrica anônima
 * e três valores fechados respondem a pergunta sem chegar perto de identificar
 * ninguém — a mesma regra que já barra e-mail, telefone e endereço lá.
 */

export type Dispositivo = 'celular' | 'tablet' | 'pc';

/**
 * Tablet ANTES de celular: quase todo UA de tablet Android também diz
 * "android", e o iPad moderno se anuncia como "macintosh" com toque. Invertida
 * a ordem, todo tablet vira celular e a distinção não existe.
 */
const TABLET = /ipad|android(?!.*mobile)|tablet|kindle|silk|playbook/;
const CELULAR = /iphone|ipod|android.*mobile|windows phone|blackberry|bb10|opera mini|iemobile|mobile safari/;

export function dispositivoDoUserAgent(userAgent?: string | null): Dispositivo {
  const ua = String(userAgent || '').toLowerCase();
  // Sem UA a resposta honesta é a mais comum da casa, não um quarto valor:
  // "desconhecido" só recriaria o buraco que este arquivo existe pra fechar.
  if (!ua) return 'pc';
  if (TABLET.test(ua)) return 'tablet';
  if (CELULAR.test(ua)) return 'celular';
  return 'pc';
}
