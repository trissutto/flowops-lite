import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A DESCRIÇÃO VIRA FICHA — extração por IA (dono, 12/08/2026).
 *
 * ── O problema ──
 *
 * A descrição da peça passa de 40 linhas e quase nada ali responde o que a
 * cliente plus size pergunta: estica? marca? é transparente? tem forro? Ela
 * gasta seis linhas em "charme retrô com pegada contemporânea" e esconde
 * "viscose com elastano" no meio de um parágrafo.
 *
 * A causa não é o texto — são os CAMPOS VAZIOS. Medido em 06/08: das 525 peças
 * publicadas, ZERO tinham modelagem preenchida. Sem lugar pra guardar tecido,
 * caimento e forro, quem cadastrou despejou tudo na descrição. Por tabela, os
 * filtros do menu (tecido, modelagem) não aparecem no site: não têm dado.
 *
 * ── O que este serviço faz ──
 *
 * Lê o texto que JÁ EXISTE (ficha, cadastro do site, descrição do catálogo) e
 * devolve o mesmo conteúdo organizado: um resumo de 2-3 linhas + os campos
 * preenchidos. Não inventa peça nem consulta a internet — se a informação não
 * está no texto, o campo volta vazio.
 *
 * ── As três regras que evitam estrago ──
 *
 * 1. **NUNCA sobrescreve o que gente escreveu.** Vale pro resumo, pro tecido,
 *    pra modelagem e pra elasticidade. Mesma regra da bolinha: escolha humana
 *    ganha da IA, sempre.
 *
 * 2. **Tecido e modelagem casam contra a LISTA CADASTRADA** (`atributos_peca`),
 *    nunca texto livre. Deixar a IA escrever "viscose", "Viscose" e "viscolinho"
 *    criaria três filtros pra mesma coisa e nenhum com peça suficiente — foi
 *    a lição do import de cores do WooCommerce ([[fotos-woocommerce-por-cor]]):
 *    casa contra lista fechada, o que não casa é reportado, nunca chutado.
 *
 * 3. **`iaEm` é o cursor.** Sem ele, cada clique no botão reprocessaria as
 *    mesmas peças do começo do alfabeto e cobraria de novo — o erro de fila
 *    que a varredura da bolinha tinha com `ORDER BY ref LIMIT`.
 */

export interface ResultadoLote {
  olhadas: number;
  enriquecidas: number;
  semTexto: number;
  falharam: number;
  restantes: number;
  /** Tecido/modelagem que a IA leu e o cadastro não tem — vira cadastro novo. */
  foraDoCadastro: string[];
  exemplosFalha: string[];
}

interface LeituraIa {
  resumo?: string;
  tecido?: string | null;
  modelagens?: string[];
  elasticidade?: string | null;
  fichaTecnica?: Array<{ rotulo: string; valor: string }>;
}

/** Uma rodada da varredura a cada 90s. */
const CICLO_MS = 90_000;
/** Fichas por rodada — 6 a cada 90s são 240/hora: o acervo em uma tarde. */
const POR_CICLO = 6;
/** Depois disso a ficha sai da fila, pra falha permanente não virar loop. */
const MAX_TENTATIVAS = 3;

@Injectable()
export class FichaIaService {
  private readonly logger = new Logger(FichaIaService.name);

  /** Uma peça por vez, mas o lote inteiro numa chamada só de tela. */
  private static readonly LOTE_PADRAO = 40;
  /** Teto do texto enviado: descrição de 40 linhas cabe folgada em 6 mil. */
  private static readonly MAX_TEXTO = 6000;

  private varrendo = false;
  /** id da ficha → falhas neste processo. Memória curta, de propósito. */
  private readonly falhas = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  private get apiKey(): string | null {
    const k = this.config.get<string>('ANTHROPIC_API_KEY');
    return k && k.trim() ? k.trim() : null;
  }

  /**
   * Modelo de TEXTO, não de visão: extrair campo de parágrafo é tarefa de
   * leitura, e o classificador (haiku) já roda em produção nesta conta.
   */
  private get modelo(): string {
    return (
      this.config.get<string>('ANTHROPIC_CLASSIFIER_MODEL') ||
      this.config.get<string>('ANTHROPIC_MODEL') ||
      'claude-haiku-4-5-20251001'
    );
  }

  /** `FICHA_IA_AUTO=0` desliga a varredura sem deploy. O botão continua. */
  private get automatico(): boolean {
    return String(this.config.get<string>('FICHA_IA_AUTO') ?? '1') !== '0';
  }

  /**
   * A VARREDURA — ninguém precisa ficar olhando (dono, 12/08/2026).
   *
   * A primeira versão saiu só com botão, e o dono perguntou na hora: "mas ela
   * fará sozinha? ou preciso ficar olhando?". É a MESMA lição da bolinha de
   * cor ([[bolinha-auto-varredura]]): quando a automação depende do caminho
   * por onde o dado entrou — o clique, a importação — sempre sobra um caminho.
   * Amarrar ao ESTADO ("tem descrição e não tem ficha → preenche") pega o
   * passado e o futuro pelo mesmo lugar: a peça cadastrada amanhã de manhã
   * entra na fila sozinha.
   *
   * Ritmo: 6 a cada 90s (240/hora) — as 655 fichas de hoje em umas três horas.
   * Vai devagar porque cada ficha é uma chamada paga; em ritmo de cron o custo
   * se dilui e ninguém precisa acompanhar.
   *
   * O botão da tela continua existindo pra quem quer o acervo AGORA.
   */
  @Interval(CICLO_MS)
  async varrer(): Promise<void> {
    if (!this.automatico || this.varrendo || !this.apiKey) return;
    this.varrendo = true;
    try {
      const r = await this.processarLote(POR_CICLO);
      if (r.olhadas) {
        this.logger.log(
          `[ficha-ia] varredura: ${r.enriquecidas} preenchida(s) · ${r.restantes} pendente(s)`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[ficha-ia] varredura falhou: ${e?.message || e}`);
    } finally {
      this.varrendo = false;
    }
  }

  /** Quanto falta — pra tela mostrar progresso em vez de pedir fé. */
  async status(): Promise<{
    ligado: boolean; automatico: boolean; pendentes: number; jaFeitas: number;
  }> {
    const [pendentes, jaFeitas] = await Promise.all([
      (this.prisma as any).produtoFicha.count({ where: { iaEm: null } }),
      (this.prisma as any).produtoFicha.count({ where: { iaEm: { not: null } } }),
    ]);
    return { ligado: !!this.apiKey, automatico: this.automatico, pendentes, jaFeitas };
  }

  /**
   * O LOTE. Roda por cima das fichas ainda não olhadas, das peças PUBLICADAS
   * primeiro — ficha vazia de peça que não está no site não custa venda.
   */
  async processarLote(limite = FichaIaService.LOTE_PADRAO): Promise<ResultadoLote> {
    if (!this.apiKey) {
      throw new BadRequestException('IA desabilitada — configure ANTHROPIC_API_KEY.');
    }
    const teto = Math.max(1, Math.min(200, limite));

    const publicadas: Array<{ ref: string }> = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true }, select: { ref: true },
    });
    const refsPub = publicadas.map((p) => String(p.ref).toUpperCase());

    // Publicadas primeiro; se acabarem, o resto do acervo.
    const fichas: any[] = await (this.prisma as any).produtoFicha.findMany({
      where: { iaEm: null, ...(refsPub.length ? { ref: { in: refsPub } } : {}) },
      take: teto,
      orderBy: { updatedAt: 'desc' },
    });
    if (fichas.length < teto) {
      const resto: any[] = await (this.prisma as any).produtoFicha.findMany({
        where: { iaEm: null, ...(refsPub.length ? { NOT: { ref: { in: refsPub } } } : {}) },
        take: teto - fichas.length,
        orderBy: { updatedAt: 'desc' },
      });
      fichas.push(...resto);
    }

    const [tecidos, modelagens] = await Promise.all([
      this.atributos('tecido'),
      this.atributos('modelagem'),
    ]);

    let enriquecidas = 0, semTexto = 0, falharam = 0;
    const foraDoCadastro = new Set<string>();
    const exemplosFalha: string[] = [];

    for (const ficha of fichas) {
      try {
        const texto = await this.textoDaPeca(ficha);
        if (!texto) {
          semTexto++;
          // Marca mesmo assim: sem texto, nenhuma releitura vai mudar nada —
          // e sem marcar ela seguraria a fila pra sempre.
          await this.marcar(ficha.id);
          continue;
        }

        const lida = await this.ler(texto, [...tecidos.keys()], [...modelagens.keys()]);
        const dados: any = { iaEm: new Date() };

        // Só preenche o que está VAZIO — o que gente escreveu fica.
        if (!String(ficha.resumo || '').trim() && lida.resumo) dados.resumo = lida.resumo.trim();

        if (!ficha.tecidoId && lida.tecido) {
          const achado = tecidos.get(this.chave(lida.tecido));
          if (achado) {
            dados.tecidoId = achado.id;
            dados.tecidoNome = achado.nome;
          } else {
            foraDoCadastro.add(`tecido: ${lida.tecido}`);
          }
        }

        if (!String(ficha.modelagens || '').trim() && lida.modelagens?.length) {
          const casadas = lida.modelagens
            .map((m) => {
              const achado = modelagens.get(this.chave(m));
              if (!achado) foraDoCadastro.add(`modelagem: ${m}`);
              return achado;
            })
            .filter(Boolean)
            .map((a: any) => ({ id: a.id, nome: a.nome }));
          if (casadas.length) dados.modelagens = JSON.stringify(casadas);
        }

        if (!ficha.elasticidade && ['nao', 'pouco', 'muito'].includes(String(lida.elasticidade))) {
          dados.elasticidade = lida.elasticidade;
        }

        const itens = (lida.fichaTecnica ?? [])
          .filter((i) => String(i?.rotulo || '').trim() && String(i?.valor || '').trim())
          .map((i) => ({ rotulo: String(i.rotulo).trim(), valor: String(i.valor).trim() }))
          .slice(0, 10);
        if (!String(ficha.fichaTecnica || '').trim() && itens.length) {
          dados.fichaTecnica = JSON.stringify(itens);
        }

        await (this.prisma as any).produtoFicha.update({ where: { id: ficha.id }, data: dados });
        // "Enriquecida" = ganhou conteúdo de verdade. Marcar `iaEm` sozinho é
        // só cursor, e contá-lo como sucesso inflaria o número da tela.
        if (Object.keys(dados).length > 1) enriquecidas++;
      } catch (e: any) {
        falharam++;
        if (exemplosFalha.length < 10) {
          exemplosFalha.push(`${ficha.ref}/${ficha.marca || '—'}: ${e?.message || e}`);
        }
        /**
         * Falha de rede merece nova tentativa — mas não PARA SEMPRE. Sem esta
         * contagem, uma ficha que a IA nunca consegue ler (texto quebrado,
         * resposta fora do formato) seguraria o topo da fila e a varredura
         * gastaria as 6 chamadas do ciclo nela, a cada 90 segundos, sem nunca
         * alcançar o resto do acervo. Foi o que travou a bolinha de cor.
         */
        const n = (this.falhas.get(ficha.id) ?? 0) + 1;
        this.falhas.set(ficha.id, n);
        if (n >= MAX_TENTATIVAS) {
          await this.marcar(ficha.id).catch(() => undefined);
          this.logger.warn(
            `[ficha-ia] ${ficha.ref}/${ficha.marca || '—'}: desisti depois de ${n} tentativas`,
          );
        }
      }
    }

    const restantes = await (this.prisma as any).produtoFicha.count({ where: { iaEm: null } });
    this.logger.log(
      `[ficha-ia] lote: ${enriquecidas} enriquecida(s), ${semTexto} sem texto, ` +
        `${falharam} falha(s), ${restantes} pendente(s)`,
    );
    return {
      olhadas: fichas.length, enriquecidas, semTexto, falharam, restantes,
      foraDoCadastro: [...foraDoCadastro].slice(0, 20),
      exemplosFalha,
    };
  }

  /** Atributos ativos de um tipo, indexados pela chave de comparação. */
  private async atributos(tipo: string): Promise<Map<string, { id: string; nome: string }>> {
    const linhas: any[] = await (this.prisma as any).atributoPeca.findMany({
      where: { tipo, ativo: true }, select: { id: true, nome: true },
    });
    const m = new Map<string, { id: string; nome: string }>();
    for (const l of linhas) m.set(this.chave(l.nome), { id: l.id, nome: l.nome });
    return m;
  }

  /** Comparação sem acento e sem caixa: "Viscose" e "viscose" são o mesmo. */
  private chave(v: string): string {
    return String(v || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toLowerCase();
  }

  /**
   * O texto disponível sobre a peça, do mais curado pro mais cru.
   *
   * A descrição do catálogo entra por último e é etiqueta ("BLUSA FEM MC
   * VISCOSE") — mas é justamente onde o tecido costuma aparecer escrito.
   */
  private async textoDaPeca(ficha: any): Promise<string> {
    const pedacos: string[] = [];
    const junta = (v?: string | null) => {
      const t = String(v || '').trim();
      if (t && !pedacos.includes(t)) pedacos.push(t);
    };

    junta(ficha.descricao);

    const site = await (this.prisma as any).siteProduto
      .findUnique({ where: { ref: String(ficha.ref).toUpperCase() } })
      .catch(() => null);
    junta(site?.nome);
    junta(site?.descricaoCurta);
    junta(site?.descricaoCompleta);

    const [doCatalogo] = await this.prisma.$queryRawUnsafe<Array<{ descricao: string }>>(
      `SELECT NULLIF(TRIM(p."descricaoCompleta"), '') AS descricao
         FROM wincred_produtos p
        WHERE UPPER(TRIM(p.ref)) = $1 AND p."descricaoCompleta" IS NOT NULL
        LIMIT 1`,
      String(ficha.ref).toUpperCase(),
    ).catch(() => [] as any);
    junta(doCatalogo?.descricao);

    return pedacos.join('\n\n').slice(0, FichaIaService.MAX_TEXTO);
  }

  private prompt(tecidos: string[], modelagens: string[]): string {
    return `Você organiza o cadastro de uma loja de moda feminina PLUS SIZE (tamanhos 44 ao 60).

Recebe o texto que a loja já tem sobre UMA peça — descrição de venda, título e a descrição do catálogo interno — e devolve esse mesmo conteúdo ORGANIZADO.

REGRAS:
- NÃO INVENTE. Se a informação não está no texto, deixe o campo vazio (null ou lista vazia). É melhor campo vazio do que dado errado: a cliente decide a compra por isso e devolve a peça quando não confere.
- "resumo": 2 a 3 frases, no máximo 400 caracteres, dizendo O QUE É a peça e o que ela tem de diferente. Sem "charme atemporal", "must have", "peça coringa" e afins — a cliente quer saber a peça, não o adjetivo. Não repita a marca, a referência nem a cor.
- "tecido": escolha UM da lista de tecidos cadastrados, ou null. Não escreva tecido fora da lista.
- "modelagens": zero ou mais da lista de modelagens cadastradas.
- "elasticidade": "nao", "pouco", "muito" ou null — só se o texto disser algo sobre esticar, elastano ou malha que cede.
- "fichaTecnica": até 6 pares curtos com o que a cliente pergunta e o texto responde. Rótulos possíveis: Composição, Forro, Transparência, Decote, Manga, Comprimento, Fechamento, Bolsos, Detalhes. Valor curto (até 40 caracteres). Só inclua o que o texto disser.

TECIDOS CADASTRADOS: ${tecidos.length ? tecidos.join(' | ') : '(nenhum)'}
MODELAGENS CADASTRADAS: ${modelagens.length ? modelagens.join(' | ') : '(nenhuma)'}

Responda SOMENTE com JSON válido, sem texto em volta:
{"resumo":"...","tecido":null,"modelagens":[],"elasticidade":null,"fichaTecnica":[{"rotulo":"Composição","valor":"..."}]}`;
  }

  private async ler(texto: string, tecidos: string[], modelagens: string[]): Promise<LeituraIa> {
    const body = {
      model: this.modelo,
      max_tokens: 700,
      messages: [
        {
          role: 'user',
          content: `${this.prompt(tecidos, modelagens)}\n\n--- TEXTO DA PEÇA ---\n${texto}`,
        },
      ],
    };
    let resposta: string;
    try {
      const res = await firstValueFrom(
        this.http.post('https://api.anthropic.com/v1/messages', body, {
          headers: {
            'x-api-key': this.apiKey as string,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 45000,
        }),
      );
      resposta = ((res.data?.content as any[]) || [])
        .filter((b) => b?.type === 'text')
        .map((b) => String(b?.text || ''))
        .join('\n');
    } catch (e: any) {
      // O motivo REAL sobe: "IA falhou" genérico custou uma tarde na leitura
      // de cor, porque modelo inválido e chave errada davam a mesma mensagem.
      const status = e?.response?.status;
      const detalhe =
        e?.response?.data?.error?.message || e?.response?.data?.message || e?.message || 'erro';
      throw new Error(`IA falhou (${status ?? 'sem status'}): ${detalhe}`);
    }

    const bruto = resposta.replace(/```json|```/g, '').trim();
    const inicio = bruto.indexOf('{');
    const fim = bruto.lastIndexOf('}');
    if (inicio < 0 || fim <= inicio) throw new Error('a IA respondeu num formato que não entendi');
    const dados = JSON.parse(bruto.slice(inicio, fim + 1));

    return {
      resumo: typeof dados?.resumo === 'string' ? dados.resumo.slice(0, 400) : undefined,
      tecido: typeof dados?.tecido === 'string' ? dados.tecido : null,
      modelagens: Array.isArray(dados?.modelagens)
        ? dados.modelagens.filter((m: any) => typeof m === 'string').slice(0, 4)
        : [],
      elasticidade: typeof dados?.elasticidade === 'string' ? dados.elasticidade : null,
      fichaTecnica: Array.isArray(dados?.fichaTecnica) ? dados.fichaTecnica.slice(0, 10) : [],
    };
  }

  private marcar(id: string) {
    return (this.prisma as any).produtoFicha.update({ where: { id }, data: { iaEm: new Date() } });
  }
}
