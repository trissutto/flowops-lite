'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * O BEACON DE USO DAS TELAS — um POST silencioso a cada troca de rota.
 *
 * Existe porque a pergunta "que telas ninguém usa?" não tinha resposta
 * (11/08/2026): 223 rotas no CRM e zero registro de acesso em qualquer lugar.
 * Este componente vive no layout raiz e alimenta a tabela `page_access`, que
 * responde "última vez e quantas vezes" por rota.
 *
 * Regras de sobrevivência:
 * · NUNCA atrapalha a tela: sem await no fluxo de render, erro engolido,
 *   `keepalive` pra sobreviver à navegação.
 * · Sem token, não manda nada (tela pública/login não interessa aqui).
 * · Ids viram [id] ANTES de sair do navegador — o backend revalida, mas
 *   normalizar aqui evita mandar uuid de venda pela rede à toa.
 * · Dedup por rota na sessão da aba: F5 ou vai-e-volta no mesmo caminho não
 *   infla o contador — a pergunta é "usa?", não "quantos cliques".
 */
export function RegistroDeAcesso() {
  const pathname = usePathname();
  const enviados = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!pathname) return;
    const path = pathname
      .split('/')
      .map((seg) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d{2,}$/.test(seg)
          ? '[id]'
          : seg,
      )
      .join('/');
    if (enviados.current.has(path)) return;

    let token: string | null = null;
    try {
      token = window.sessionStorage.getItem('flowops_token') || window.localStorage.getItem('flowops_token');
    } catch {
      /* storage bloqueado — segue sem registrar */
    }
    if (!token) return;

    enviados.current.add(path);
    // O helper `api()` já resolve base (localhost × LAN × prod) e token —
    // reimplementar aqui foi o primeiro rascunho e divergiria na primeira
    // mudança de ambiente.
    api('/telemetria/pagina', { method: 'POST', body: JSON.stringify({ path }) }).catch(() => {
      /* telemetria nunca vira erro de tela */
    });
  }, [pathname]);

  return null;
}
