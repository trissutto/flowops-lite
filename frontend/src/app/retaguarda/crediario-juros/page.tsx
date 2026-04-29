'use client';

/**
 * REORG-F3 · página movida pra /loja/juros-crediario.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function CrediarioJurosRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/loja/juros-crediario'); }, [router]);
  return null;
}
