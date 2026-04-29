'use client';

/**
 * REORG-F3 · página movida pra /config/whatsapp.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function WhatsappConfigRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/config/whatsapp'); }, [router]);
  return null;
}
