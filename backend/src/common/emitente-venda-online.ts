/**
 * A NOTA SEGUE O DINHEIRO (regra do dono, 04/10/2026).
 *
 * "Sempre que for venda online, a nota fiscal tem que ser emitida pelo CNPJ
 * correspondente ao CNPJ que gerou o link de pagamento."
 *
 * Até aqui a NF-e do envio saía pelo CNPJ da loja que DESPACHAVA a peça, sem
 * olhar quem tinha cobrado. E a conta PagBank da rede é UMA SÓ — o token da
 * matriz e o das 8 lojas com config própria são o mesmo, e o recebedor que sai
 * no PIX de todas é a T.O. RISSUTTO LTDA (raiz 20.104.813). Resultado medido
 * em 30 dias de venda online do PDV paga no PagBank (141 pedidos, R$ 37,8
 * mil): de 68 notas, só 23 saíram pela T.O. — 23 saíram pela LURDS (Sorocaba,
 * Campinas, Limeira, Praia Grande) e 22 pela MDD Cerqueira (franquia que
 * despachou peça de venda da rede). Dinheiro num CNPJ, nota em outro.
 *
 * Este arquivo responde UMA pergunta — "de que empresa é a conta que recebeu
 * esta venda?" — e decide o emitente a partir dela. Quem ESCOLHE o
 * estabelecimento daquela empresa (o da própria loja, se ela tiver; senão a
 * matriz /0001) é o `loadStoreFiscal` da NF-e, com a mesma máquina que a
 * transferência já usa.
 *
 * ⚠️ O sistema NÃO guarda o CNPJ titular de cada conta PagBank (o
 * `conta_label` diz "Lurds Plus Size" numa conta que é da T.O.). Por isso o
 * titular mora aqui, com o valor que a produção tem hoje como PADRÃO — default
 * que concorda com a produção, pela mesma razão dos "defaults invertidos" do
 * CLAUDE.md: se a env sumir, a regra continua valendo.
 *
 *   PAGBANK_TITULAR_RAIZ            raiz (8 díg) do titular da conta. Padrão
 *                                   20104813 (T.O. RISSUTTO).
 *   PAGBANK_TITULAR_RAIZ_POR_LOJA   {"<loja>":"<raiz>"} — pro dia em que uma
 *                                   loja ganhar conta PagBank de outro CNPJ.
 *   NFE_SEGUE_CONTA_DO_LINK         `0` desliga a regra (a nota volta a sair
 *                                   pelo CNPJ de quem despacha).
 *
 * ESCOPO: venda online do PDV (`Order.source = 'pdv_online'`). Pedido do site
 * e da live passam pela mesma conta, mas a decisão do dono foi sobre a venda
 * online da loja — os dois seguem como estavam até ele decidir.
 */

/** T.O. RISSUTTO LTDA — titular da conta PagBank da rede (medido 04/10/2026 pelo recebedor do PIX). */
const TITULAR_PAGBANK_PADRAO = '20104813';

const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

/** Raiz (8 primeiros dígitos) de um CNPJ — '' se não tiver 8. */
export function raizDoCnpj(cnpj: unknown): string {
  const d = soDigitos(cnpj);
  return d.length >= 8 ? d.slice(0, 8) : '';
}

/** Kill-switch: `NFE_SEGUE_CONTA_DO_LINK=0` volta a nota pro CNPJ de quem despacha. */
export function notaSegueContaLigada(): boolean {
  return String(process.env.NFE_SEGUE_CONTA_DO_LINK ?? '1').trim() !== '0';
}

/**
 * Raiz do CNPJ TITULAR da conta PagBank que cobra pela loja `storeCode`.
 *
 * Valor torto na env (JSON inválido, raiz que não tem 8 dígitos) NÃO vira
 * "sem titular": cai no padrão. A alternativa seria a nota voltar calada pro
 * CNPJ errado por causa de um erro de digitação numa variável.
 */
export function raizTitularPagbank(storeCode?: string | null): string {
  const loja = String(storeCode ?? '').trim();
  if (loja) {
    try {
      const mapa = JSON.parse(process.env.PAGBANK_TITULAR_RAIZ_POR_LOJA || '{}');
      const daLoja = soDigitos(mapa?.[loja]);
      if (daLoja.length === 8) return daLoja;
    } catch {
      /* JSON inválido → segue pro titular geral */
    }
  }
  const geral = soDigitos(process.env.PAGBANK_TITULAR_RAIZ);
  return geral.length === 8 ? geral : TITULAR_PAGBANK_PADRAO;
}

/** `PdvSale.id` por trás de um pedido online do PDV — null em qualquer outro pedido. */
export function pdvSaleIdDoPedido(order: { source?: string | null; checkoutInfo?: string | null } | null | undefined): string | null {
  if (!order || order.source !== 'pdv_online') return null;
  try {
    const id = String(JSON.parse(String(order.checkoutInfo || '{}'))?.pdvSaleId || '').trim();
    return id || null;
  } catch {
    return null; /* snapshot cru → não dá pra saber a venda */
  }
}

export interface ContaQueCobrou {
  /** Raiz (8 díg) do CNPJ titular da conta que recebeu. */
  raiz: string;
  /** `storeCode` gravado na cobrança (é ele que escolhe a conta no PagBank). */
  lojaDaCobranca: string;
  saleId: string;
}

/**
 * A venda `saleId` foi paga numa conta PagBank? Devolve a raiz do titular.
 *
 * Só cobrança PAGA conta: link gerado e nunca pago não recebeu dinheiro
 * nenhum. Qualquer origem serve (PIX do painel, link `/pague`, PIX de balcão
 * que entrou como parte do pagamento) — o que importa é em que conta o
 * dinheiro caiu, não por qual botão.
 *
 * Erro de banco SOBE: quem chama está prestes a emitir documento fiscal, e
 * "não consegui ler" não pode virar "ninguém cobrou" (regra de ouro do
 * CLAUDE.md — miss vira erro honesto, nunca vazio).
 */
export async function contaQueCobrouAVenda(prisma: any, saleId: string | null | undefined): Promise<ContaQueCobrou | null> {
  const id = String(saleId ?? '').trim();
  if (!id || !notaSegueContaLigada()) return null;
  const pago = await prisma.pagbankPayment.findFirst({
    where: { saleId: id, status: 'paid' },
    orderBy: { createdAt: 'desc' },
    select: { storeCode: true },
  });
  if (!pago) return null;
  const lojaDaCobranca = String(pago.storeCode ?? '').trim();
  return { raiz: raizTitularPagbank(lojaDaCobranca), lojaDaCobranca, saleId: id };
}

/** Mesma pergunta, a partir do PEDIDO. Só responde pra venda online do PDV. */
export async function contaQueCobrouOPedido(
  prisma: any,
  order: { source?: string | null; checkoutInfo?: string | null } | null | undefined,
): Promise<ContaQueCobrou | null> {
  return contaQueCobrouAVenda(prisma, pdvSaleIdDoPedido(order));
}

export interface EmitenteDaNota {
  /** Loja cuja config fiscal é o ponto de partida da emissão. */
  storeCode: string;
  /** Raiz pela qual a nota TEM que sair (o `matchRaiz` do `loadStoreFiscal`); undefined = identidade da própria loja. */
  emitirPorRaiz?: string;
  /** Qual régua decidiu — vai pro log, pra ninguém ter que adivinhar depois. */
  regra: 'conta-que-cobrou' | 'empresa-do-site' | 'raiz-da-loja' | 'loja-que-despacha';
}

/**
 * QUEM EMITE a NF-e de um envio. Função pura — a ordem É a regra:
 *
 *  1. `raizDaConta` (04/10): a venda foi paga numa conta de gateway → a nota
 *     sai pela empresa titular dela. Ganha de tudo. O ponto de partida é a
 *     loja que DESPACHA: se ela tem estabelecimento dessa empresa, é ele que
 *     assina (Sorocaba e Praia Grande têm CNPJ T.O. próprio); se não tem
 *     (Campinas, Limeira, franquia), assina a matriz da raiz.
 *  2. Empresa do site (`NFE_SITE_EMITENTE_RAIZ`/`_STORE`, 28/07) — vale pra
 *     tudo que não é live. Nunca foi ligada em produção; preservada como era.
 *  3. Raiz por loja (`NFE_EMITENTE_RAIZ_POR_LOJA`, 28/07).
 *  4. Nada disso → a identidade de NFC-e da loja que despacha (o de sempre).
 */
export function decidirEmitente(input: {
  source?: string | null;
  lojaQueDespacha: string;
  raizDaConta?: string | null;
  siteRaiz?: string | null;
  siteStore?: string | null;
  lojaRaiz?: string | null;
}): EmitenteDaNota {
  const loja = String(input.lojaQueDespacha ?? '').trim();
  const raizConta = soDigitos(input.raizDaConta);
  if (raizConta.length === 8) {
    return { storeCode: loja, emitirPorRaiz: raizConta, regra: 'conta-que-cobrou' };
  }
  const isSite = input.source !== 'live';
  const siteRaiz = soDigitos(input.siteRaiz);
  const siteStore = String(input.siteStore ?? '').trim();
  if (isSite && siteRaiz.length === 8) {
    return { storeCode: siteStore || loja, emitirPorRaiz: siteRaiz, regra: 'empresa-do-site' };
  }
  const lojaRaiz = soDigitos(input.lojaRaiz);
  if (lojaRaiz.length === 8) {
    return { storeCode: loja, emitirPorRaiz: lojaRaiz, regra: 'raiz-da-loja' };
  }
  return { storeCode: loja, regra: 'loja-que-despacha' };
}

/**
 * A partir de quando a nota AUTOMÁTICA de retirada/motoboy vale. Venda fechada
 * antes disso não ganha nota sozinha — emitir documento fiscal retroativo em
 * lote é decisão do dono, não de um cron que acabou de subir.
 * `NFE_NOTA_SEM_ENVIO_DESDE` (ISO) move o corte.
 */
export function corteDaNotaSemEnvio(): Date {
  const env = String(process.env.NFE_NOTA_SEM_ENVIO_DESDE ?? '').trim();
  const d = env ? new Date(env) : null;
  // 04/10/2026 00:00 de Brasília
  return d && !isNaN(d.getTime()) ? d : new Date('2026-10-04T03:00:00.000Z');
}

/**
 * Erro que PASSA sozinho (rede, SEFAZ/ViaCEP fora, timeout) — a varredura
 * tenta de novo no próximo ciclo. Qualquer outro (cadastro incompleto, config
 * fiscal) fica registrado no pedido e espera alguém consertar: tentar de novo
 * daria o mesmo erro a cada 5 minutos.
 */
export function erroTransitorio(mensagem: unknown): boolean {
  return /timeout|timed out|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|\b50[234]\b|servi[cç]o (em )?paralisa|indispon[ií]vel/i.test(
    String(mensagem ?? ''),
  );
}
