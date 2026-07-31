'use client';

/** /retaguarda/rh/face-enroll/[sellerId] — MATRIZ. Ver FaceEnrollFlow. */
import { useParams } from 'next/navigation';
import FaceEnrollFlow from '@/components/rh/FaceEnrollFlow';

export default function FaceEnrollPage() {
  const sellerId = useParams()?.sellerId as string;
  return (
    <FaceEnrollFlow
      backHref={`/retaguarda/vendedoras/${sellerId}`}
      doneHref={`/retaguarda/vendedoras/${sellerId}`}
    />
  );
}
