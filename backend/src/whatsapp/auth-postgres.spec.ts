import { chaveDoArquivo } from './auth-postgres';

/**
 * A CONVERSÃO QUE, SE ERRAR, DERRUBA O WHATSAPP DEPOIS.
 *
 * O Baileys escreve cada chave num arquivo cujo nome é a própria chave com
 * `/` → `__` e `:` → `-`. Desfazer isso com dois `replace` no nome inteiro
 * parece funcionar e está errado: `pre-key-123.json` viraria `pre:key:123`.
 *
 * O estrago não aparece na migração — ela loga "importado com sucesso". Ele
 * aparece horas depois, quando o Baileys procura `pre-key-123`, não acha, e a
 * sessão cai. Por isso este teste existe: é a única barreira entre o erro e um
 * QR pra reescanear no meio do expediente.
 */
describe('chaveDoArquivo', () => {
  it('mantém o hífen do TIPO e converte só o id', () => {
    expect(chaveDoArquivo('pre-key-123.json')).toBe('pre-key-123');
    expect(chaveDoArquivo('sender-key-memory-abc.json')).toBe('sender-key-memory-abc');
    expect(chaveDoArquivo('app-state-sync-version-regular.json')).toBe(
      'app-state-sync-version-regular',
    );
  });

  it('desfaz a troca de ":" no id, sem tocar no tipo', () => {
    // Sessão real do Baileys: o id traz device separado por ':'
    expect(chaveDoArquivo('session-5513999998888.0-1.json')).toBe(
      'session-5513999998888.0:1',
    );
  });

  it('desfaz a troca de "/" no id', () => {
    expect(chaveDoArquivo('app-state-sync-key-AAAA__BBBB.json')).toBe(
      'app-state-sync-key-AAAA/BBBB',
    );
  });

  it('casa o tipo MAIS LONGO primeiro — os dois prefixos convivem', () => {
    // 'sender-key' é prefixo de 'sender-key-memory'. Numa lista mal ordenada o
    // curto casaria antes e o id viraria 'memory-abc'; como o `:` do id é
    // desfeito depois, o estrago só apareceria em ids com ':' — ou seja, em
    // produção e não aqui. Estes dois casos travam a ordem da lista.
    expect(chaveDoArquivo('sender-key-memory-abc.json')).toBe('sender-key-memory-abc');
    expect(chaveDoArquivo('sender-key-xyz.json')).toBe('sender-key-xyz');
    // O mesmo par no outro grupo: 'app-state-sync-key' × 'app-state-sync-version'.
    expect(chaveDoArquivo('app-state-sync-key-AAA.json')).toBe('app-state-sync-key-AAA');
    expect(chaveDoArquivo('app-state-sync-version-regular.json')).toBe(
      'app-state-sync-version-regular',
    );
  });

  it('ignora arquivo que não é chave de sessão', () => {
    expect(chaveDoArquivo('creds.json')).toBeNull();
    expect(chaveDoArquivo('qualquer-coisa.json')).toBeNull();
  });
});
