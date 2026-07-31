/**
 * appPrompt — substituto do window.prompt que funciona no APP DESKTOP.
 *
 * O Electron NÃO implementa window.prompt (não abre nada e retorna undefined),
 * então todo fluxo que pedia senha/justificativa via prompt funcionava na web
 * e morria em silêncio no LURDS ORDER ONE — ex.: descontos do PDV.
 *
 * Modal em DOM puro (sem React) pra servir de drop-in em qualquer tela:
 *   const v = await appPrompt('Senha do GERENTE:', { password: true });
 *   // v = string no OK/Enter · null no Cancelar/Esc/clique fora
 *
 * opts.password renderiza input type=password — bônus: a senha não fica mais
 * visível na tela como ficava no window.prompt.
 */
export function appPrompt(
  message: string,
  opts: { password?: boolean; defaultValue?: string; okLabel?: string } = {},
): Promise<string | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;padding:16px;';

    const box = document.createElement('div');
    box.style.cssText =
      'background:#fff;border-radius:12px;max-width:440px;width:100%;padding:20px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit;';

    const msg = document.createElement('div');
    msg.style.cssText =
      'font-size:14px;font-weight:600;color:#1e293b;white-space:pre-wrap;' +
      'margin-bottom:12px;line-height:1.45;';
    msg.textContent = message;

    const input = document.createElement('input');
    input.type = opts.password ? 'password' : 'text';
    input.value = opts.defaultValue ?? '';
    input.autocomplete = 'off';
    input.style.cssText =
      'width:100%;padding:10px 12px;border:2px solid #cbd5e1;border-radius:8px;' +
      'font-size:16px;outline:none;box-sizing:border-box;color:#1e293b;';
    input.addEventListener('focus', () => { input.style.borderColor = '#D4AF37'; });
    input.addEventListener('blur', () => { input.style.borderColor = '#cbd5e1'; });

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:14px;';

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.textContent = 'Cancelar';
    btnCancel.style.cssText =
      'flex:1;padding:10px;border:2px solid #cbd5e1;background:#fff;color:#334155;' +
      'font-weight:700;border-radius:8px;cursor:pointer;font-size:14px;';

    const btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.textContent = opts.okLabel || 'OK';
    btnOk.style.cssText =
      'flex:2;padding:10px;border:none;background:#B8912B;color:#fff;' +
      'font-weight:800;border-radius:8px;cursor:pointer;font-size:14px;';

    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(v);
    };

    btnOk.addEventListener('click', () => done(input.value));
    btnCancel.addEventListener('click', () => done(null));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(null);
    });
    // stopPropagation: não deixa o listener global de teclado do PDV (bipagem,
    // atalhos F-key) reagir ao que é digitado dentro do modal.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });

    row.appendChild(btnCancel);
    row.appendChild(btnOk);
    box.appendChild(msg);
    box.appendChild(input);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(() => {
      input.focus();
      if (input.value) input.select();
    }, 30);
  });
}
