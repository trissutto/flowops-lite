/**
 * DADOS OBRIGATÓRIOS DA CLIENTE NA VENDA ONLINE (dono 18/08/2026).
 *
 * Venda online (WhatsApp/Instagram) não é balcão: a peça vai VIAJAR e o
 * pedido nasce no trilho do site. Sem cadastro completo o pedido nasce torto
 * e a falha aparece longe do caixa, quando ninguém mais lembra da venda:
 *   - sem NOME de verdade → etiqueta/push/NF-e saem "Cliente" (caso ON-000009)
 *   - sem CPF válido      → os Correios não postam e a NF-e não sai
 *   - sem TELEFONE        → a loja não avisa a cliente e o antifraude reprova
 *   - sem E-MAIL          → o aviso de pedido/pagamento não é enviado
 *   - sem ENDEREÇO        → o pedido não vira Order (cai no fluxo legado,
 *                           sem card e sem etiqueta) e a peça some no limbo
 *
 * ⚠️ RETIRADA EM LOJA NÃO PEDE ENDEREÇO (dono 18/08/2026). Todo motivo da
 * lista acima é sobre a peça VIAJANDO — e na retirada ela não viaja: a
 * cliente busca no balcão da loja que ela mesma escolheu. Cobrar CEP/rua de
 * quem vai buscar é pedir dado que a cliente não quer dar (e que ela dá
 * errado só pra passar da tela), então o endereço só é obrigatório em
 * SEDEX/PAC/MOTOBOY. O `pedido-online.service` já nasceu assim: em
 * `entrega.pickup` ele dispensa o CEP e cria o Order do mesmo jeito — quem
 * estava fora do combinado era esta régua.
 *
 * Fonte ÚNICA da regra no backend. O PDV tem o espelho em
 * `frontend/src/lib/dados-cliente-online.ts` — mexeu aqui, mexe lá (a régua
 * divergir entre a tela que valida e o servidor que cobra é como nasce o
 * "salvei e não deixou fechar").
 */

export type ClienteVendaOnline = {
  customerCpf?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerCep?: string | null;
  customerEndereco?: string | null;
  customerNumero?: string | null;
  customerBairro?: string | null;
  customerCidade?: string | null;
  customerUf?: string | null;
  /**
   * COMO A PEÇA SAI (`PdvSale.entregaTipo`): 'sedex' | 'pac' | 'motoboy' |
   * 'retirada'. É o que decide se o endereço é cobrado. Ausente/nulo =
   * a vendedora ainda não escolheu → cobra endereço (padrão SEGURO: quem
   * esquecer de passar o campo erra pro lado de pedir demais, não de deixar
   * uma peça viajar sem destino).
   */
  entregaTipo?: string | null;
};

/** CPF com dígitos verificadores — mesmo algoritmo do checkout e da live. */
export function cpfValido(raw?: string | null): boolean {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  let dv1 = (s * 10) % 11;
  if (dv1 === 10) dv1 = 0;
  if (dv1 !== Number(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * (11 - i);
  let dv2 = (s * 10) % 11;
  if (dv2 === 10) dv2 = 0;
  return dv2 === Number(d[10]);
}

const UFS = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB',
  'PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
];

/**
 * NOME DE VERDADE, não rótulo. "Cliente", "consumidor", "sem nome" e primeiro
 * nome solto passavam a régua antiga (que só olhava se o campo tinha texto) e
 * viravam etiqueta impossível de entregar.
 */
export function nomeCompletoOk(raw?: string | null): boolean {
  const nome = String(raw || '').trim().replace(/\s+/g, ' ');
  if (nome.length < 5) return false;
  const generico = /^(cliente|consumidor|consumidor final|sem nome|nao identificado|não identificado|teste|xxx+)$/i;
  if (generico.test(nome)) return false;
  const partes = nome.split(' ').filter((p) => /[a-zà-ÿ]{2,}/i.test(p));
  return partes.length >= 2;
}

export function emailOk(raw?: string | null): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || '').trim());
}

/** Fixo (10) ou celular (11). É o número que a loja usa pra falar com ela. */
export function telefoneOk(raw?: string | null): boolean {
  return [10, 11].includes(String(raw || '').replace(/\D/g, '').length);
}

/**
 * A peça VIAJA nesta venda? Só a retirada em loja fica de fora — em SEDEX,
 * PAC e MOTOBOY alguém tem que levar a peça até um endereço.
 *
 * Modalidade não escolhida cai no `true`: o endereço passa a ser cobrado no
 * momento em que a vendedora declara SEDEX/PAC/MOTOBOY, e até lá o portão de
 * entrada usa `faltandoDadosBasicosClienteOnline` (que não fala de endereço).
 */
export function pecaViaja(entregaTipo?: string | null): boolean {
  return String(entregaTipo || '').trim().toLowerCase() !== 'retirada';
}

/**
 * O QUE VALE PRA QUALQUER VENDA ONLINE — a peça viajando ou não.
 *
 * Nome, CPF, WhatsApp e e-mail não são sobre entrega: são a NF-e, o
 * antifraude e o único jeito de avisar a cliente que o pedido está pronto.
 * A retirada precisa deles igual.
 *
 * É esta a régua do portão de entrada (botão "V. Online"), onde a forma de
 * entrega ainda NÃO foi escolhida — a escolha mora no modal de pagamento.
 * Cobrar endereço lá na frente trancaria a vendedora do lado de fora da
 * única tela onde ela pode dizer que é retirada.
 */
export function faltandoDadosBasicosClienteOnline(c: ClienteVendaOnline): string[] {
  const falta: string[] = [];
  if (!nomeCompletoOk(c.customerName)) falta.push('nome completo (nome e sobrenome)');
  if (!cpfValido(c.customerCpf)) falta.push('CPF válido');
  if (!telefoneOk(c.customerPhone)) falta.push('WhatsApp com DDD');
  if (!emailOk(c.customerEmail)) falta.push('e-mail');
  return falta;
}

/**
 * O que ainda falta pra esta venda online poder andar. Lista vazia = completo.
 * Os rótulos são os MESMOS nomes dos campos do PDV — a vendedora lê o aviso e
 * sabe onde clicar, sem tradução ("Dados incompletos" sem dizer o campo foi o
 * que travou o checkout do site em 15/08).
 *
 * O endereço entra na conta só quando a peça VIAJA (`entregaTipo`): retirada
 * em loja fecha sem CEP, que é o caso da cliente que não quer passar dado
 * justamente porque vai buscar.
 *
 * `complemento` fica de fora de propósito: a maioria dos endereços não tem.
 */
export function faltandoDadosClienteOnline(c: ClienteVendaOnline): string[] {
  const falta = faltandoDadosBasicosClienteOnline(c);
  if (!pecaViaja(c.entregaTipo)) return falta;
  if (String(c.customerCep || '').replace(/\D/g, '').length !== 8) falta.push('CEP');
  if (String(c.customerEndereco || '').trim().length < 3) falta.push('rua');
  if (!String(c.customerNumero || '').trim()) falta.push('número');
  if (String(c.customerBairro || '').trim().length < 2) falta.push('bairro');
  if (String(c.customerCidade || '').trim().length < 2) falta.push('cidade');
  if (!UFS.includes(String(c.customerUf || '').trim().toUpperCase())) falta.push('UF');
  return falta;
}
