'use client';

/**
 * REORG-F3 · página movida pra /config/nfce.
 * Mantida só como redirect pra não quebrar bookmarks/links internos antigos.
 * Pode ser deletada na F6 (limpeza).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function NfceConfigRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/config/nfce');
  }, [router]);
  return null;
}
