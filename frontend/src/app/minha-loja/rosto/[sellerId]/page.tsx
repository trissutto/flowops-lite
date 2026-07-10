'use client';

/** /minha-loja/rosto/[sellerId] — a GERENTE cadastra o rosto da funcionária
 *  da loja dela (backend valida que a funcionária é da loja). Ver FaceEnrollFlow. */
import FaceEnrollFlow from '@/components/rh/FaceEnrollFlow';

export default function RostoEnrollLojaPage() {
  return <FaceEnrollFlow backHref="/minha-loja/rosto" doneHref="/minha-loja/rosto" />;
}
