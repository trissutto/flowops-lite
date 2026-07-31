'use client';

/**
 * PdvIpHeartbeat — reporta o IP público de saída da loja pro backend.
 *
 * Por que existe: a batida de ponto pelo CELULAR DA LOJA (source pwa_selfie)
 * só vale se vier do mesmo WiFi da loja. Navegador não enxerga SSID, então a
 * regra é por IP: o PDV Electron (que fica ligado o dia todo na loja) manda
 * POST /ponto/pdv-heartbeat e o backend grava o IP visto. O celular no mesmo
 * WiFi sai pra internet com esse mesmo IP → batida liberada.
 *
 * Gates:
 *  - SÓ roda dentro do app desktop (isElectron()). Impersonação de admin
 *    ("entrar como loja") roda no navegador comum → nunca manda heartbeat
 *    (senão o IP da MATRIZ viraria "WiFi da loja").
 *  - Fetch cru (não usa api()) de propósito: um 401 em background aqui NÃO
 *    pode disparar o alert/redirect de sessão expirada do api.ts.
 *
 * Backend descarta chamadas sem role=store, então mesmo um token errado
 * não polui a lista de IPs.
 */

import { useEffect } from 'react';
import { API_URL, getAuthToken } from '@/lib/api';
import { isElectron } from '@/lib/printer-router';

const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 min

async function sendHeartbeat() {
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch(`${API_URL}/ponto/pdv-heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
  } catch {
    // silencioso — heartbeat é best-effort, a próxima tentativa cobre
  }
}

export default function PdvIpHeartbeat() {
  useEffect(() => {
    if (!isElectron()) return;
    sendHeartbeat(); // imediato ao abrir o app
    const id = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
