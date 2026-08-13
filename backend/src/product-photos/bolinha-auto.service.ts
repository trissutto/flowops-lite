import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WcFotosImportService } from './wc-fotos-import.service';

/**
 * BOLINHA AUTOMÁTICA — a cor do seletor do site se pinta sozinha.
 *
 * A leitura de cor por IA já existia em dois lugares: no botão da tela e
 * dentro da importação do site antigo. Faltava o caso mais comum de todos —
 * a foto que chegou por QUALQUER outro caminho (upload à mão, importação
 * anterior a este código, foto que já estava no acervo). Essas ficavam com
 * foto boa e bolinha cinza, esperando alguém abrir a peça e clicar.
 *
 * Aqui a regra é simples e não depende de ninguém clicar: **tem foto e não tem
 * cor → pinta**. Uma varredura contínua, que pega o passado e o futuro pelo
 * mesmo caminho.
 *
 * DECISÕES:
 *
 * 1. Vai DEVAGAR (poucas por ciclo). Cada leitura é uma chamada paga de visão;
 *    varrer o acervo de uma vez seria uma conta feia numa tarde só. Em ritmo de
 *    cron o acervo se pinta sozinho em algumas horas e o custo se dilui.
 *
 * 2. NUNCA sobrescreve bolinha existente. Se a IA já leu, ou se alguém ajustou
 *    no conta-gotas, aquilo está decidido — a escolha humana ganha do palpite.
 *
 * 3. Peça que falha três vezes sai da fila (memória do processo). Sem isso, uma
 *    foto corrompida viraria uma chamada paga a cada 90 segundos, pra sempre.
 *
 * Kill-switch: `BOLINHA_AUTO=0` desliga a varredura sem deploy. O botão
 * "Pegar cor da foto (IA)" da tela continua funcionando de qualquer jeito.
 */

const CICLO_MS = 90_000;     // uma rodada a cada 1min30
const POR_CICLO = 4;         // leituras de cor por rodada
const MAX_TENTATIVAS = 3;    // depois disso, a peça sai da fila
/**
 * Quantas pendentes o ciclo OLHA antes de escolher as 4 que vai pintar.
 *
 * Tem que ser MUITO maior que `POR_CICLO`: a consulta ordena por REF e corta
 * no limite, então uma janela apertada devolve sempre as mesmas primeiras do
 * alfabeto — e quando elas desistem, a varredura para de andar sem dizer nada
 * (ver o comentário em `varrer`).
 */
const JANELA = 500;

@Injectable()
export class BolinhaAutoService {
  private readonly logger = new Logger(BolinhaAutoService.name);
  private ocupado = false;
  /** chave "REF|COR" → quantas vezes já falhou neste processo. */
  private readonly falhas = new Map<string, number>();
  private pintadas = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly importador: WcFotosImportService,
  ) {}

  private get ligado(): boolean {
    return String(this.config.get<string>('BOLINHA_AUTO') ?? '1') !== '0';
  }

  /**
   * Cores que têm foto e não têm bolinha.
   *
   * O `NOT EXISTS` olha `cor_hex`, não a existência da linha: a cor pode já ter
   * ficha (título, status de publicação) e mesmo assim estar sem cor definida —
   * era o caso da tela que motivou isto.
   *
   * `product_photos.ref` e `produto_ficha.ref` são ambos REF-BASE desde a
   * unificação das famílias, então o casamento é direto.
   */
  private async pendentes(limite: number): Promise<Array<{ ref: string; cor: string }>> {
    return this.prisma.$queryRawUnsafe<Array<{ ref: string; cor: string }>>(
      `SELECT DISTINCT p.ref, p.cor
         FROM product_photos p
        WHERE p.cor IS NOT NULL AND TRIM(p.cor) <> ''
          AND NOT EXISTS (
            SELECT 1 FROM produto_ficha f
              JOIN produto_ficha_cor c ON c.ficha_id = f.id
             WHERE f.ref = p.ref AND c.cor = p.cor AND c.cor_hex IS NOT NULL
          )
        ORDER BY p.ref
        LIMIT $1`,
      limite,
    );
  }

  @Interval(CICLO_MS)
  async varrer(): Promise<void> {
    if (!this.ligado || this.ocupado) return;
    this.ocupado = true;
    try {
      /**
       * ⚠️ A JANELA PRECISA SER MAIOR QUE O TANTO QUE DESISTE (achado 12/08).
       *
       * Aqui se pedia `POR_CICLO * 4` = 16. Como `pendentes()` ordena por REF e
       * corta no limite, isso traz SEMPRE as 16 primeiras do alfabeto. Quando
       * essas 16 esgotam as três tentativas — o que aconteceu enquanto o acervo
       * era AVIF e a IA recusava tudo ([[avif-quebra-leitura-ia]]) — a fila
       * filtrada fica vazia, o método retorna **sem logar nada**, e a varredura
       * nunca chega na 17ª cor. Morreu em silêncio: 128 cores pendentes e ZERO
       * linha de `[bolinha-auto]` no log, já com as fotos convertidas e a IA de
       * pé. Sem log, "parou" e "não tem o que fazer" são indistinguíveis.
       *
       * Agora a janela cobre o passivo inteiro, então sempre há candidata nova
       * atrás das desistentes — e se um dia a janela inteira desistir, o log
       * DIZ isso em vez de calar.
       */
      const candidatas = await this.pendentes(JANELA);
      const fila = candidatas
        .filter((c) => (this.falhas.get(`${c.ref}|${c.cor}`) ?? 0) < MAX_TENTATIVAS)
        .slice(0, POR_CICLO);
      if (!fila.length) {
        if (candidatas.length) {
          this.logger.warn(
            `[bolinha-auto] ${candidatas.length} cor(es) pendente(s) e TODAS já ` +
              `desistidas (${MAX_TENTATIVAS} tentativas). Só volta a tentar no ` +
              `próximo restart ou pelo botão "Pintar todas", que zera as desistências.`,
          );
        }
        return;
      }

      for (const { ref, cor } of fila) {
        const chave = `${ref}|${cor}`;
        const antes = await this.temBolinha(ref, cor);
        await this.importador.pintarBolinha(ref, cor);
        const depois = await this.temBolinha(ref, cor);
        if (depois && !antes) {
          this.pintadas++;
          this.falhas.delete(chave);
        } else if (!depois) {
          // pintarBolinha é best-effort e engole o erro (a foto, que é o caro,
          // já está salva). Aqui só contamos, pra não insistir pra sempre.
          const n = (this.falhas.get(chave) ?? 0) + 1;
          this.falhas.set(chave, n);
          if (n >= MAX_TENTATIVAS) {
            this.logger.warn(`[bolinha-auto] ${chave}: desisti depois de ${n} tentativas`);
          }
        }
      }
      this.logger.log(`[bolinha-auto] ciclo: ${fila.length} peça(s) · ${this.pintadas} pintada(s) no total`);
    } catch (e: any) {
      this.logger.warn(`[bolinha-auto] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.ocupado = false;
    }
  }

  private async temBolinha(ref: string, cor: string): Promise<boolean> {
    const achou = await (this.prisma as any).produtoFichaCor.findFirst({
      where: { cor, corHex: { not: null }, ficha: { ref } },
      select: { id: true },
    });
    return !!achou;
  }

  /**
   * PINTAR TODAS AGORA — pedido do dono (07/08): "pode pintar todas".
   *
   * A varredura de fundo faz 4 cores a cada 90s (160/hora): ela é rede de
   * segurança pro que pinga, não mutirão. Com centenas paradas depois da
   * importação em massa, alcançar levaria a noite inteira.
   *
   * Aqui o ritmo é outro (`LOTE_PARALELO` por vez) e o gatilho é humano — a
   * pintura chama IA por foto, e disparar isso sozinho num deploy seria custo
   * que ninguém pediu.
   *
   * Também **zera as desistências**: `falhas` é memória do processo, e uma cor
   * que falhou 3× por instabilidade ficava fora da fila até o próximo deploy.
   * Quem clica no botão está justamente pedindo pra tentar de novo.
   */
  async pintarTodas(): Promise<{ pendentesAntes: number; pintadas: number; falharam: number }> {
    this.falhas.clear();
    const LOTE_PARALELO = 4;
    const TETO = 5000; // trava de segurança: nunca é um loop infinito
    let pintadas = 0, falharam = 0;

    const { pendentes: pendentesAntes } = await this.status();

    while (pintadas + falharam < TETO) {
      const fila = await this.pendentes(LOTE_PARALELO);
      if (!fila.length) break;

      const desfechos = await Promise.all(
        fila.map(async ({ ref, cor }) => {
          const antes = await this.temBolinha(ref, cor);
          await this.importador.pintarBolinha(ref, cor);
          return { chave: `${ref}|${cor}`, ok: !antes && (await this.temBolinha(ref, cor)) };
        }),
      );

      const acertou = desfechos.filter((d) => d.ok).length;
      pintadas += acertou;
      falharam += desfechos.length - acertou;
      this.pintadas += acertou;

      /**
       * ⚠️ SAÍDA OBRIGATÓRIA: se o lote inteiro falhou, `pendentes()` devolve
       * exatamente as mesmas cores no próximo giro — e o laço rodaria até o
       * teto queimando chamada de IA à toa. Falhou tudo, para.
       */
      if (acertou === 0) {
        this.logger.warn('[bolinha-auto] mutirão parou: um lote inteiro falhou');
        break;
      }
    }

    this.logger.log(`[bolinha-auto] mutirão: ${pintadas} pintada(s), ${falharam} falha(s)`);
    return { pendentesAntes, pintadas, falharam };
  }

  /** Quanto falta — pra tela mostrar progresso em vez de "confia". */
  async status() {
    const [linha] = await this.prisma.$queryRawUnsafe<Array<{ total: number }>>(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT DISTINCT p.ref, p.cor
           FROM product_photos p
          WHERE p.cor IS NOT NULL AND TRIM(p.cor) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM produto_ficha f
                JOIN produto_ficha_cor c ON c.ficha_id = f.id
               WHERE f.ref = p.ref AND c.cor = p.cor AND c.cor_hex IS NOT NULL
            )
       ) q`,
    );
    return {
      ligado: this.ligado,
      pendentes: Number(linha?.total ?? 0),
      pintadasNesteProcesso: this.pintadas,
      desistencias: [...this.falhas.entries()].filter(([, n]) => n >= MAX_TENTATIVAS).map(([k]) => k),
    };
  }
}
