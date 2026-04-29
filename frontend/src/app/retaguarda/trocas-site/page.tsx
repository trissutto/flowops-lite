'use client';

/**
 * REORG-F3 · página movida pra /site/trocas.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TrocasSiteRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/site/trocas'); }, [router]);
  return null;
}
