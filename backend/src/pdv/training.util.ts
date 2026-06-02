/**
 * Training Mode — detecção de modo treinamento por request.
 *
 * Vendedora entra no PDV com senha TREINAMENTO_PASSWORD (env). O frontend
 * salva flag no sessionStorage e envia header `x-training-mode: 1` em TODAS
 * as chamadas API enquanto a sessão estiver em treino.
 *
 * Este util centraliza a detecção: passe o request (req) e ele retorna boolean.
 * Use em todos os services que precisam decidir "deve mexer em estoque/Giga?"
 *
 * Regra ouro: se isTrainingRequest(req), as integrações externas (estoque,
 * Giga, NFC-e, cashback, WC) DEVEM ser puladas. As entidades criadas DEVEM
 * receber isTraining=true pra não contar em relatórios financeiros.
 */
export function isTrainingRequest(req: any): boolean {
  if (!req) return false;
  const h = (req.headers || {}) as Record<string, any>;
  const v = h['x-training-mode'] ?? h['X-Training-Mode'];
  if (!v) return false;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Valida senha de treinamento. Senha vem do env TREINAMENTO_PASSWORD. */
export function isValidTrainingPassword(password: string): boolean {
  const expected = (process.env.TREINAMENTO_PASSWORD || '').trim();
  if (!expected) return false; // se não configurada, modo treino fica desligado
  return String(password || '').trim() === expected;
}
