import { notFound } from 'next/navigation';
import { prisma } from './prisma';
import { PublicPropertySnapshot } from './types';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

export async function getActiveProperty(publicId: string) {
  if (!PUBLIC_ID_PATTERN.test(publicId)) notFound();
  const property = await prisma.publicProperty.findFirst({
    where: { publicId, active: true },
    include: { media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
  });
  if (!property) notFound();
  return { ...property, snapshot: property.snapshot as unknown as PublicPropertySnapshot };
}

export function mediaUrl(publicId: string, mediaId: string) {
  return `/api/media/${encodeURIComponent(publicId)}/${encodeURIComponent(mediaId)}`;
}
