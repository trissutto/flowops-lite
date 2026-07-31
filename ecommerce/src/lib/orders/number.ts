import 'server-only';

/**
 * NÚMERO DO PEDIDO — LP-000123-XX.
 *
 * O número que a cliente vê e fala no WhatsApp. Curto, legível, com prefixo
 * da marca — nunca o UUID interno.
 *
 * ⚠️ LIMITAÇÃO HONESTA: o sequencial vive em memória. Cada instância
 * serverless começa do 1 de novo, então "LP-000001" pode nascer duas vezes em
 * instâncias diferentes. O sufixo aleatório de 2 caracteres é o que evita a
 * colisão de exibição (LP-000001-K4 ≠ LP-000001-9Z) — não é criptografia, é
 * desempate. Quando o Postgres entrar, isto vira uma sequence do banco (mesmo
 * padrão da EanSequence do FlowOps) e o sufixo pode até ficar, por charme.
 */

const SUFIXO_ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I/L — evita leitura ambígua ao telefone

function sufixoAleatorio(tamanho = 2): string {
  let out = '';
  for (let i = 0; i < tamanho; i++) {
    out += SUFIXO_ALFABETO[Math.floor(Math.random() * SUFIXO_ALFABETO.length)];
  }
  return out;
}

// globalThis preserva a sequência entre hot-reloads em dev (mesmo padrão do
// order store) — em produção cada instância tem o seu contador mesmo.
const globalRef = globalThis as unknown as { __lurdsOrderSeq?: { value: number } };
const seq = globalRef.__lurdsOrderSeq ?? { value: 0 };
globalRef.__lurdsOrderSeq = seq;

/** Próximo número exibível: LP-000042-K4. */
export function nextOrderNumber(): string {
  seq.value += 1;
  return `LP-${String(seq.value).padStart(6, '0')}-${sufixoAleatorio()}`;
}
