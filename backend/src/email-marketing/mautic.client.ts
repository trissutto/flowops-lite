import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * CLIENTE DA API DO MAUTIC (dono, 14/08/2026).
 *
 * A comunicação com o Mautic passa a ser VIA SISTEMA: a operadora dispara pela
 * tela do FlowOps, o backend fala com a API do Mautic (mkt.lurds.com.br) e o
 * Mautic entrega pelo SES, contando abertura/clique e respeitando descadastro.
 *
 * AUTENTICAÇÃO: Basic Auth (o mais simples do Mautic). Precisa de:
 *   MAUTIC_BASE=https://mkt.lurds.com.br
 *   MAUTIC_USER=<usuário do Mautic com permissão de API>
 *   MAUTIC_PASS=<senha desse usuário>
 * E, no Mautic: Configurações → API → "Habilitar API" + "Habilitar HTTP basic
 * auth". Sem isso a API responde 401 (é o estado de hoje).
 *
 * NUNCA loga usuário/senha. Erro de credencial vira mensagem clara pra tela,
 * nunca stack.
 */
@Injectable()
export class MauticClient {
  private readonly logger = new Logger(MauticClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get base(): string | null {
    const b = this.config.get<string>('MAUTIC_BASE');
    return b ? b.replace(/\/+$/, '') : null;
  }

  configurado(): boolean {
    return Boolean(this.base && this.config.get('MAUTIC_USER') && this.config.get('MAUTIC_PASS'));
  }

  private authHeader(): string {
    const u = this.config.get<string>('MAUTIC_USER') ?? '';
    const p = this.config.get<string>('MAUTIC_PASS') ?? '';
    return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  }

  private async call<T = any>(
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: any,
  ): Promise<T> {
    if (!this.configurado()) {
      throw new Error(
        'Mautic não configurado. Defina MAUTIC_BASE/MAUTIC_USER/MAUTIC_PASS no backend e habilite a API + Basic Auth no Mautic.',
      );
    }
    const url = `${this.base}/api${path}`;
    try {
      const res = await firstValueFrom(
        this.http.request<T>({
          method,
          url,
          data: body,
          headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
          timeout: 30_000,
        }),
      );
      return res.data;
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.errors?.[0]?.message ?? e?.message ?? 'erro desconhecido';
      // NUNCA vaza credencial; a URL não leva segredo, mas o log fica só no código.
      this.logger.warn(`Mautic ${method.toUpperCase()} ${path} → ${status ?? 'sem status'}: ${msg}`);
      if (status === 401) throw new Error('Mautic recusou a autenticação — confira usuário/senha da API.');
      if (status === 404) throw new Error(`Mautic não encontrou o recurso (${path}).`);
      throw new Error(`Falha ao falar com o Mautic: ${msg}`);
    }
  }

  /** Ping — usa /api/segments com page size 1 só pra validar credencial. */
  async status(): Promise<{ ok: boolean; erro?: string }> {
    try {
      await this.call('get', '/segments?limit=1');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, erro: e?.message ?? String(e) };
    }
  }

  /** Segmentos (listas) do Mautic com contagem — a fonte da campanha. */
  async segmentos(): Promise<Array<{ id: number; nome: string; alias: string; contatos: number | null }>> {
    const data = await this.call<any>('get', '/segments?limit=200&orderBy=name&orderByDir=asc');
    const lists = data?.lists ?? {};
    return Object.values(lists).map((s: any) => ({
      id: Number(s.id),
      nome: String(s.name ?? s.alias ?? `Segmento ${s.id}`),
      alias: String(s.alias ?? ''),
      // A contagem vem no campo `leadCount` em algumas versões; null se ausente.
      contatos: s.leadCount != null ? Number(s.leadCount) : null,
    }));
  }

  /**
   * Cria um e-mail do tipo LISTA já vinculado ao segmento. `publishUp` opcional
   * agenda a partida — o Mautic só envia a partir dessa data.
   *
   * `texto` e `headers` NÃO são enfeite (medição de 15/08/2026): as 5 campanhas
   * disparadas por aqui em 14/08 somaram 13.014 envios e **zero abertura**,
   * enquanto as campanhas de julho — mesma base, mesmo SES — abriam ~3,8%. A
   * diferença é que as nossas saíram sem versão texto e sem descadastro de 1
   * clique, os dois itens que Gmail e Outlook exigem de quem manda acima de
   * 5.000/dia. Sem eles o provedor bloqueia antes da caixa de entrada.
   */
  async criarEmailLista(input: {
    nome: string;
    assunto: string;
    html: string;
    texto?: string | null;
    segmentoId: number;
    publishUp?: string | null;
  }): Promise<{ id: number }> {
    const body: any = {
      name: input.nome,
      subject: input.assunto,
      customHtml: input.html,
      emailType: 'list',
      lists: [input.segmentoId],
      isPublished: true,
      // Descadastro de 1 clique direto no cabeçalho: o Gmail mostra o "Cancelar
      // inscrição" ao lado do remetente e conta como sinal de remetente sério.
      // `{unsubscribe_url}` é token do Mautic, trocado por contato no envio.
      headers: {
        'List-Unsubscribe': '<{unsubscribe_url}>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
    if (input.texto) body.plainText = input.texto;
    if (input.publishUp) body.publishUp = input.publishUp;
    const data = await this.call<any>('post', '/emails/new', body);
    const id = Number(data?.email?.id);
    if (!id) throw new Error('Mautic criou o e-mail mas não devolveu o id.');
    return { id };
  }

  /**
   * Dispara o e-mail pros contatos do(s) segmento(s) vinculado(s). O Mautic
   * respeita descadastro e "do not contact" sozinho. Devolve quantos entraram
   * na fila (`sentCount`/`pending`).
   */
  async enviarParaSegmento(emailId: number): Promise<{ enfileirados: number | null; sucesso: boolean }> {
    const data = await this.call<any>('post', `/emails/${emailId}/send`, {});
    return {
      sucesso: data?.success === 1 || data?.success === true,
      enfileirados: data?.sentCount != null ? Number(data.sentCount) : (data?.pending != null ? Number(data.pending) : null),
    };
  }
}
