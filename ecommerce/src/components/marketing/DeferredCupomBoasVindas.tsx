'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BLOCKED_COUPON_ROUTES,
  COUPON_DELAY_MS,
  hasResolvedCoupon,
  minimumCouponScroll,
} from '@/components/marketing/cupomBoasVindasRules';

const CupomBoasVindas = dynamic(
  () => import('@/components/marketing/CupomBoasVindas').then((module) => module.CupomBoasVindas),
);

export function DeferredCupomBoasVindas() {
  const pathname = usePathname();
  const [shouldLoad, setShouldLoad] = useState(false);
  const blocked = BLOCKED_COUPON_ROUTES.some((route) => pathname?.startsWith(route));

  useEffect(() => {
    if (blocked || hasResolvedCoupon(window.localStorage)) return;

    let timeMet = false;
    let scrollMet = window.scrollY >= minimumCouponScroll(window.innerHeight);
    const tryLoad = () => {
      if (timeMet && scrollMet) setShouldLoad(true);
    };
    const onScroll = () => {
      if (window.scrollY < minimumCouponScroll(window.innerHeight)) return;
      scrollMet = true;
      window.removeEventListener('scroll', onScroll);
      tryLoad();
    };
    const timer = window.setTimeout(() => {
      timeMet = true;
      tryLoad();
    }, COUPON_DELAY_MS);

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [blocked]);

  if (blocked || !shouldLoad) return null;
  return <CupomBoasVindas initiallyOpen />;
}
