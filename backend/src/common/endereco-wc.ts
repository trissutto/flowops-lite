/**
 * ENDEREÇO NO SHAPE DO WOOCOMMERCE — um campo, uma informação.
 *
 * O pedido guarda o endereço de entrega como JSON no formato do WooCommerce
 * (`order.shippingAddress`), porque é o shape que a separação, os cards da loja
 * e a impressão de etiqueta já sabem ler. O problema não era o formato: era o
 * COMPLEMENTO e o BAIRRO viajarem juntos no mesmo campo.
 *
 *   grava: address_2 = [complemento, bairro].join(' - ')     ← duas coisas
 *   lê:    complemento = address_2                            ← "Apto 42 - Centro"
 *          bairro      = neighborhood                         ← vazio, ninguém gravava
 *
 * Na etiqueta dos Correios isso vira complemento errado e bairro em branco. O
 * bairro vazio ficava escondido porque o ViaCEP repunha logo depois — até o dia
 * em que o CEP é genérico ou o ViaCEP está fora.
 *
 * Aqui ficam as duas pontas, juntas de propósito: quem grava e quem lê no mesmo
 * arquivo é o que impede as duas de divergirem de novo.
 */

/** Campos de endereço do shape WC que este sistema grava e lê. */
export interface EnderecoWc {
  address_1?: string;
  address_2?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  postcode?: string;
  [k: string]: any;
}

/**
 * Monta os dois campos separados: `address_2` é SÓ o complemento (que é o que
 * ele significa no WooCommerce) e o bairro ganha campo próprio.
 */
export function montarComplementoBairroWc(
  complemento?: string | null,
  bairro?: string | null,
): { address_2: string; neighborhood: string } {
  return {
    address_2: String(complemento || '').trim(),
    neighborhood: String(bairro || '').trim(),
  };
}

/**
 * NÚMERO em campo próprio — o mesmo defeito do complemento, um andar acima.
 *
 * `address_1` guarda "rua, número" grudado, e quem lê desfaz por regex
 * (`/^(.*?),?\s*(\d+[A-Za-z]?)\s*$/`). Funciona no caso comum e falha no resto:
 * "Av. Brasil, 1500 A" (espaço antes da letra) e "Rua X, s/n" não casam, e o
 * número vira "S/N" na etiqueta mesmo tendo sido digitado.
 *
 * O leitor JÁ prefere `addr.number` quando existe — então basta gravar. O
 * `address_1` continua sendo montado igual, porque os cards da loja e a
 * impressão mostram aquele texto pronto.
 */
export function montarNumeroWc(numero?: string | null): { number: string } {
  return { number: String(numero || '').trim() };
}

/**
 * Lê rua e número SEM repetir o número — o efeito colateral do `montarNumeroWc`.
 *
 * Gravar `number` em campo próprio resolveu a etiqueta, mas o `address_1`
 * continuou sendo "rua, número". Quem lê os dois e junta escreve o número duas
 * vezes: **"Rua Salomão Filho, 577 , 577"** na tela do pedido (13/08), e o
 * mesmo na etiqueta dos Correios e na NF-e, que montam endereço + número em
 * campos separados.
 *
 * Regra: com `number` preenchido, tira do fim do `address_1` o que for ele;
 * sem `number`, desfaz por regex como sempre foi (pedido do WooCommerce nunca
 * teve campo separado).
 */
export function lerRuaNumeroWc(addr: EnderecoWc | null | undefined): { rua: string; numero: string } {
  const a: any = addr || {};
  const bruto = String(a.address_1 ?? a.street ?? a.logradouro ?? '').trim();
  const numero = String(a.number ?? a.numero ?? '').trim();

  if (numero) {
    // Escapa o número: "1500-A" tem hífen, "s/n" tem barra.
    const alvo = numero.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const semNumero = bruto.replace(new RegExp(`[,\\s]*${alvo}\\s*$`, 'i'), '').trim();
    // `semNumero` vazio = o address_1 era SÓ o número; melhor devolver o bruto.
    return { rua: semNumero || bruto, numero };
  }

  const m = bruto.match(/^(.*?),?\s*(\d+[A-Za-z]?)\s*$/);
  if (m) return { rua: m[1].trim(), numero: m[2] };
  return { rua: bruto, numero: '' };
}

/**
 * Lê complemento e bairro de um endereço WC, **inclusive dos pedidos antigos**.
 *
 * Pedido gravado antes desta correção tem "Apto 42 - Centro" no `address_2` e
 * nada em `neighborhood`. Ignorar isso consertaria só os pedidos novos e
 * deixaria a etiqueta dos antigos errada do mesmo jeito — e são justamente os
 * que estão na fila pra postar hoje.
 *
 * Regra do desempacote, só quando NÃO existe `neighborhood`:
 *   "Apto 42 - Centro" → complemento "Apto 42", bairro "Centro"
 *   "Centro"           → sem separador, fica como complemento (é o que o dado
 *                        diz; inventar bairro daí seria adivinhar)
 * O ViaCEP, que roda logo depois no chamador, corrige bairro faltante pelo CEP.
 */
export function lerComplementoBairroWc(addr: EnderecoWc | null | undefined): {
  complemento: string;
  bairro: string;
} {
  const a: any = addr || {};
  const bairroProprio = String(a.neighborhood ?? a.bairro ?? '').trim();
  const bruto = String(a.address_2 ?? a.complemento ?? a.complement ?? '').trim();

  if (bairroProprio) return { complemento: bruto, bairro: bairroProprio };

  const partes = bruto.split(' - ');
  if (partes.length >= 2) {
    const bairro = partes.pop()!.trim();
    return { complemento: partes.join(' - ').trim(), bairro };
  }
  return { complemento: bruto, bairro: '' };
}
