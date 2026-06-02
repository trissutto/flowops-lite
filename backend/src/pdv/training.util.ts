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

/**
 * Valida senha de treinamento. Aceita várias env vars equivalentes pra
 * facilitar configuração:
 *   - TREINAMENTO_PASSWORD (nome padrão usado no doc)
 *   - SENHA_DE_TREINAMENTO (PT-BR completo — alternativa intuitiva)
 *   - SENHA_TREINAMENTO    (PT-BR curto)
 *   - TRAINING_PASSWORD    (EN)
 * A primeira que estiver setada é a que vale.
 */
export function isValidTrainingPassword(password: string): boolean {
  const candidates = [
    process.env.TREINAMENTO_PASSWORD,
    process.env.SENHA_DE_TREINAMENTO,
    process.env.SENHA_TREINAMENTO,
    process.env.TRAINING_PASSWORD,
  ];
  const expected = candidates.find((v) => v && String(v).trim() !== '');
  if (!expected) return false; // nenhuma configurada → modo treino desligado
  return String(password || '').trim() === String(expected).trim();
}
