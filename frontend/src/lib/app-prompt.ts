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
/**
 * appConfirm — substituto do window.confirm nos caminhos críticos do PDV.
 *
 * Três problemas concretos do confirm() nativo, todos vistos na loja:
 *   1. BLOQUEIA A THREAD — enquanto a caixinha do Windows está aberta, o
 *      socket não processa, o polling não roda e o leitor de código de barras
 *      digita no vazio.
 *   2. Texto corrido de 5 linhas numa caixa cinza que ninguém lê até o fim.
 *   3. Enter dispara "OK" mesmo quando a ação é DESTRUTIVA.
 *
 * Aqui: título curto, o motivo real em destaque, botão perigoso em vermelho e
 * NUNCA focado por padrão (o foco começa no Cancelar). Enter não confirma.
 *
 *   const ok = await appConfirm({
 *     title: 'Cancelar essa venda?',
 *     message: 'Vai perder tudo que já foi bipado.',
 *     okLabel: 'Cancelar a venda',
 *     danger: true,
 *   });
 */
export function appConfirm(opts: {
  title: string;
  message?: string;
  /** Bloco em destaque — o motivo real, o valor, o erro que veio do backend. */
  highlight?: string;
  /** Linhas de conferência (uma por item), listadas com marcador. */
  bullets?: string[];
  okLabel?: string;
  cancelLabel?: string;
  /** true = ação destrutiva: botão vermelho e foco começa no Cancelar. */
  danger?: boolean;
}): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;padding:16px;';

    const box = document.createElement('div');
    box.style.cssText =
      'background:#fff;border-radius:12px;max-width:460px;width:100%;padding:20px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit;';

    const h = document.createElement('div');
    h.style.cssText =
      'font-size:17px;font-weight:800;color:#0f172a;line-height:1.3;margin-bottom:6px;';
    h.textContent = opts.title;
    box.appendChild(h);

    if (opts.message) {
      const m = document.createElement('div');
      m.style.cssText =
        'font-size:14px;color:#475569;white-space:pre-wrap;line-height:1.5;';
      m.textContent = opts.message;
      box.appendChild(m);
    }

    if (opts.highlight) {
      const hl = document.createElement('div');
      hl.style.cssText =
        'margin-top:12px;padding:10px 12px;border-radius:8px;font-size:14px;' +
        'font-weight:700;line-height:1.45;white-space:pre-wrap;' +
        (opts.danger
          ? 'background:#fff1f2;border:2px solid #fda4af;color:#9f1239;'
          : 'background:#FBF6E6;border:2px solid #E4C968;color:#8C7325;');
      hl.textContent = opts.highlight;
      box.appendChild(hl);
    }

    if (opts.bullets?.length) {
      const ul = document.createElement('ul');
      ul.style.cssText =
        'margin:12px 0 0;padding-left:18px;font-size:13px;color:#475569;line-height:1.6;';
      for (const b of opts.bullets) {
        const li = document.createElement('li');
        li.textContent = b;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:16px;';

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.textContent = opts.cancelLabel || 'Voltar';
    btnCancel.style.cssText =
      'flex:1;padding:12px;border:2px solid #cbd5e1;background:#fff;color:#334155;' +
      'font-weight:700;border-radius:8px;cursor:pointer;font-size:14px;';

    const btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.textContent = opts.okLabel || 'Confirmar';
    btnOk.style.cssText =
      'flex:2;padding:12px;border:none;color:#fff;font-weight:800;' +
      'border-radius:8px;cursor:pointer;font-size:14px;' +
      (opts.danger ? 'background:#e11d48;' : 'background:#2E7D46;');

    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    // Captura na fase de captura pra o listener global do PDV (bipagem/F-keys)
    // não reagir enquanto o modal está aberto.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      // Enter NÃO confirma: em ação destrutiva o hábito de "apertar Enter"
      // era exatamente o que cancelava venda montada por engano.
    };
    document.addEventListener('keydown', onKey, true);

    btnOk.addEventListener('click', () => done(true));
    btnCancel.addEventListener('click', () => done(false));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(false);
    });

    row.appendChild(btnCancel);
    row.appendChild(btnOk);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    // Foco no botão SEGURO quando a ação é destrutiva.
    setTimeout(() => (opts.danger ? btnCancel : btnOk).focus(), 30);
  });
}

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
