import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MauticClient } from './mautic.client';
import { EmailService } from '../email/email.service';

/**
 * CAMPANHA DE E-MAIL PELO FLOWOPS (dono, 14/08/2026).
 *
 * A operadora escolhe um segmento do Mautic, escreve assunto e texto e dispara
 * — sem abrir o Mautic. Este service é a regra de negócio no meio:
 *
 *   · monta o HTML no padrão da marca a partir do texto simples (a operadora
 *     não escreve HTML);
 *   · a PRÉVIA vai pelo NOSSO e-mail (EmailService/SES) pra um endereço de
 *     teste — valida como a peça CHEGA, sem sujar o Mautic com e-mail de teste;
 *   · o ENVIO REAL cria o e-mail-lista no Mautic e dispara pro segmento, que é
 *     quem tem a base, a entregabilidade e o descadastro.
 */
@Injectable()
export class EmailMarketingService {
  private readonly logger = new Logger(EmailMarketingService.name);

  constructor(
    private readonly mautic: MauticClient,
    private readonly email: EmailService,
  ) {}

  async status() {
    if (!this.mautic.configurado()) {
      return { ok: false, configurado: false, erro: 'Mautic ainda não conectado (faltam MAUTIC_BASE/USER/PASS + API habilitada).' };
    }
    const s = await this.mautic.status();
    return { ok: s.ok, configurado: true, erro: s.erro };
  }

  async segmentos() {
    const lista = await this.mautic.segmentos();
    // Maior primeiro — a operadora quase sempre quer o público grande no topo.
    return lista.sort((a, b) => (b.contatos ?? 0) - (a.contatos ?? 0));
  }

  /**
   * TEXTO SIMPLES → HTML da marca. A operadora escreve como escreveria no
   * WhatsApp; a gente veste. Cada linha em branco separa parágrafo; `**x**`
   * vira negrito; uma linha só com um link vira botão.
   */
  private montarHtml(assunto: string, corpo: string, cupom?: string | null): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const paras = corpo
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const comBold = esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
        return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3a3630">${comBold}</p>`;
      })
      .join('');

    const blocoCupom = cupom
      ? `<p style="font-size:22px;font-weight:bold;background:#FBF6E6;border:2px dashed #B8912B;border-radius:12px;padding:14px;text-align:center;letter-spacing:2px;color:#8C7325;margin:0 0 20px">${esc(cupom)}</p>`
      : '';

    return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:10px">
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#b8912b">Lurd's Plus Size</p>
      <h1 style="margin:12px 0 18px;font-size:22px;color:#1a1a1a;font-weight:600">${esc(assunto)}</h1>
    </td></tr>
    <tr><td style="padding:0 28px 8px">${paras}${blocoCupom}</td></tr>
    <tr><td style="padding:8px 28px 28px">
      <a href="https://www.lurdsplussize.com.br" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600">Ver no site</a>
    </td></tr>
    <tr><td style="padding:16px 28px 28px;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#999">Moda plus size do 46 ao 60 · 14 lojas físicas · troca fácil.<br>
      Você recebe porque se cadastrou na Lurd's. Para não receber mais, responda com "SAIR".</p>
    </td></tr>
  </table>
</body></html>`;
  }

  private validar(assunto: string, corpo: string) {
    if (String(assunto).trim().length < 3) throw new BadRequestException('Escreva um assunto (mín. 3 letras).');
    if (String(corpo).trim().length < 10) throw new BadRequestException('Escreva o texto do e-mail (mín. 10 letras).');
  }

  /** Prévia no e-mail de teste — pelo NOSSO SES, sem tocar no Mautic. */
  async enviarPrevia(input: { destino: string; assunto: string; corpo: string; cupom?: string | null }) {
    this.validar(input.assunto, input.corpo);
    const destino = String(input.destino || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(destino)) throw new BadRequestException('E-mail de teste inválido.');
    const html = this.montarHtml(input.assunto, input.corpo, input.cupom);
    const ok = await this.email.send(destino, `[PRÉVIA] ${input.assunto}`, html, input.corpo);
    if (!ok) throw new BadRequestException('Não conseguimos enviar a prévia — confira o SMTP/SES do backend.');
    return { ok: true, destino };
  }

  /**
   * ENVIO REAL: cria o e-mail-lista no Mautic e dispara pro segmento.
   * `agendarPara` (ISO) opcional — o Mautic só parte a partir dela.
   */
  async enviarCampanha(input: {
    segmentoId: number;
    assunto: string;
    corpo: string;
    cupom?: string | null;
    agendarPara?: string | null;
  }) {
    this.validar(input.assunto, input.corpo);
    if (!Number.isFinite(input.segmentoId) || input.segmentoId <= 0) {
      throw new BadRequestException('Escolha o público (segmento) do disparo.');
    }
    const html = this.montarHtml(input.assunto, input.corpo, input.cupom);
    const nome = `[FlowOps] ${input.assunto}`.slice(0, 120);

    const email = await this.mautic.criarEmailLista({
      nome,
      assunto: input.assunto,
      html,
      segmentoId: input.segmentoId,
      publishUp: input.agendarPara ?? null,
    });

    // Agendado: NÃO dispara agora — o Mautic parte na data. Disparar aqui
    // furaria o agendamento e mandaria na hora.
    if (input.agendarPara) {
      this.logger.log(`[campanha] agendada #${email.id} → segmento ${input.segmentoId} pra ${input.agendarPara}`);
      return { ok: true, emailId: email.id, agendado: true, para: input.agendarPara };
    }

    const envio = await this.mautic.enviarParaSegmento(email.id);
    this.logger.log(`[campanha] enviada #${email.id} → segmento ${input.segmentoId} · enfileirados ${envio.enfileirados ?? '?'}`);
    return { ok: envio.sucesso, emailId: email.id, agendado: false, enfileirados: envio.enfileirados };
  }
}
