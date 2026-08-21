/**
 * ROTA PRÓPRIA — lojas que trocam mercadoria de CARRO, entre si.
 *
 * Itanhaém, Praia Grande e Santos são vizinhas e a mercadoria vai no carro da
 * rede (dono, 04/08). Nasceu no envio de remessa (etiqueta dos Correios nesse
 * trecho é papel jogado fora) e desde 21/08 também alimenta o ROUTING de
 * pedido dividido: se o trio cobre o pedido inteiro, a separação já nasce
 * JUNTANDO as peças numa loja âncora — as outras mandam de carro.
 *
 * Configurável em `SystemSetting['realignment_rota_propria']` (códigos de
 * loja separados por vírgula) porque a rota do carro muda com o tempo e não
 * pode exigir deploy. Sem config, o padrão resolve pelo NOME das lojas.
 * Config com valor VAZIO desliga a regra.
 *
 * A ORDEM importa pro desempate da âncora da juntada (empate de peças →
 * quem vem primeiro ganha): na config, a ordem é a digitada; no padrão,
 * Itanhaém primeiro.
 */
const ROTA_PROPRIA_PADRAO = ['ITANHAEM', 'PRAIA GRANDE', 'SANTOS'];

const semAcento = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();

/** Códigos das lojas da rota própria, NA ORDEM de prioridade. */
export async function lojasDaRotaPropria(prisma: {
  systemSetting: { findUnique: (args: any) => Promise<any> };
  store: { findMany: (args: any) => Promise<any[]> };
}): Promise<string[]> {
  const cfg: any = await prisma.systemSetting
    .findUnique({ where: { key: 'realignment_rota_propria' } })
    .catch(() => null);

  if (cfg && cfg.value !== null && cfg.value !== undefined) {
    return String(cfg.value)
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
  }

  const lojas: any[] = await prisma.store.findMany({
    select: { code: true, name: true } as any,
  });
  const porNome = new Map(lojas.map((l) => [semAcento(l.name), String(l.code).toUpperCase()]));
  return ROTA_PROPRIA_PADRAO.map((nome) => porNome.get(nome)).filter(Boolean) as string[];
}
