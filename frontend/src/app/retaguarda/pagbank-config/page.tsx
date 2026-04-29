'use client';

/**
 * REORG-F3 · página movida pra /config/pagbank.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function PagbankConfigRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/config/pagbank'); }, [router]);
  return null;
}
