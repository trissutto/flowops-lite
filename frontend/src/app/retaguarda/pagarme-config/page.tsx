'use client';

/**
 * REORG-F3 · página movida pra /config/pagarme.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function PagarmeConfigRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/config/pagarme'); }, [router]);
  return null;
}
