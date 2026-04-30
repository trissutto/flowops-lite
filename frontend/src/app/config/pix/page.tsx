'use client';

/**
 * /config/pix → redireciona pra /config/pagarme.
 * O PIX da Lurd's roda via Stone/Pagar.me; configuração fica lá.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function PixConfigRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/config/pagarme');
  }, [router]);
  return null;
}
