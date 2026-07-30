'use client';

import { LuxuryCarousel } from '@/components/ui/LuxuryCarousel';
import { TestimonialCard } from '@/components/cards/TestimonialCard';
import type { Testimonial } from '@/types';

/** Carrossel de avaliações — 1 no mobile, 3 no desktop, com bullets. */
export function TestimonialCarousel({ testimonials }: { testimonials: Testimonial[] }) {
  return (
    <LuxuryCarousel
      ariaLabel="Avaliações de clientes"
      perView={{ base: 1.08, sm: 2, lg: 3, xl: 3 }}
      gap="md"
      arrows
      dots
    >
      {testimonials.map((testimonial, index) => (
        <TestimonialCard key={testimonial.id} testimonial={testimonial} index={index} className="h-full" />
      ))}
    </LuxuryCarousel>
  );
}
