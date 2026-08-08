import type { Metadata } from 'next';
import {
  Bath,
  BedDouble,
  Building2,
  CalendarDays,
  Car,
  CheckCircle2,
  ExternalLink,
  FileText,
  MapPin,
  Maximize2,
  Ruler,
  ShieldCheck,
} from 'lucide-react';
import { PropertyGallery } from '@/components/PropertyGallery';
import { ShareActions } from '@/components/ShareActions';
import { getActiveProperty, mediaUrl } from '@/lib/public-property';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function generateMetadata(): Promise<Metadata> {
  return { robots: { index: false, follow: false, nocache: true } };
}

export default async function PropertyPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const property = await getActiveProperty(publicId);
  const item = property.snapshot;
  const photos = property.media
    .filter((media) => media.kind === 'photo' && media.storageKey)
    .map((media) => ({ id: media.id, url: mediaUrl(item.publicId, media.id), caption: media.caption || media.fileName }));
  const links = property.media.filter((media) => ['video', 'virtual_tour'].includes(media.kind) && media.externalUrl);
  const title = item.campaignTitle || item.name;
  const statusLabel = statusText(item.commercialStatus);
  const address = [item.address.endereco, item.address.numero, item.address.complemento, item.address.bairro, item.address.cidade, item.address.estado].filter(Boolean).join(', ');
  const characteristics = [
    metric(item.characteristics.bedrooms, 'Quartos', BedDouble),
    metric(item.characteristics.suites, 'Suítes', BedDouble),
    metric(item.characteristics.bathrooms, 'Banheiros', Bath),
    metric(item.characteristics.parkingSpaces, 'Vagas', Car),
    metric(item.areas.usefulM2, 'm² úteis', Maximize2),
    metric(item.areas.builtM2, 'm² construídos', Building2),
    metric(item.areas.landM2, 'm² de terreno', Ruler),
  ].filter(Boolean) as Array<{ value: string | number; label: string; Icon: any }>;

  return (
    <main>
      <header className="site-header">
        <div className="container header-inner">
          <div className="public-brand"><span className="brand-mark small"><Building2 /></span><div><b>Lurd&apos;s Imóveis</b><small>Ficha comercial</small></div></div>
          <div className="verified"><ShieldCheck size={17} /> Informações verificadas</div>
        </div>
      </header>

      <div className="container property-shell">
        <PropertyGallery photos={photos} title={title} />

        <div className="property-grid">
          <article className="property-main">
            <div className="eyebrow-row"><span>{typeText(item.propertyType)}</span><span className={`availability ${item.commercialStatus}`}>{statusLabel}</span></div>
            <h1>{title}</h1>
            <div className="address"><MapPin size={18} />{address || [item.address.bairro, item.address.cidade, item.address.estado].filter(Boolean).join(', ')}</div>
            {item.address.locationNote && <p className="location-note">{item.address.locationNote}</p>}

            <div className="metrics">
              {characteristics.map(({ value, label, Icon }) => <div className="metric" key={label}><Icon /><div><b>{value}</b><span>{label}</span></div></div>)}
            </div>

            <section className="content-section">
              <h2>Sobre o imóvel</h2>
              <p className="description">{item.description}</p>
            </section>

            {item.characteristics.features.length > 0 && (
              <section className="content-section">
                <h2>Diferenciais</h2>
                <div className="features">{item.characteristics.features.map((feature) => <div key={feature}><CheckCircle2 />{feature}</div>)}</div>
              </section>
            )}

            {(links.length > 0 || item.address.mapUrl) && (
              <section className="content-section">
                <h2>Links úteis</h2>
                <div className="useful-links">
                  {item.address.mapUrl && <a href={item.address.mapUrl} target="_blank" rel="noopener noreferrer"><MapPin />Abrir localização<ExternalLink /></a>}
                  {links.map((link) => <a key={link.id} href={link.externalUrl!} target="_blank" rel="noopener noreferrer"><ExternalLink />{link.caption || (link.kind === 'video' ? 'Assistir ao vídeo' : 'Abrir tour virtual')}</a>)}
                </div>
              </section>
            )}

            <section className="content-section registry">
              <div><FileText /><span>Inscrição municipal</span><b>{item.municipalRegistration}</b></div>
              <div><CalendarDays /><span>Atualizado em</span><b>{formatDate(item.lastReviewedAt || item.publishedAt)}</b></div>
            </section>
          </article>

          <aside className="price-card">
            <div className="price-label">Valor de venda</div>
            <div className="price">{formatCurrency(item.financial.salePrice)}</div>
            {item.financial.negotiable === true && <div className="negotiable">Valor negociável</div>}
            <div className="costs">
              {item.financial.condominiumMonthly !== null && <div><span>Condomínio</span><b>{formatCurrency(item.financial.condominiumMonthly)}/mês</b></div>}
              {item.financial.iptuAnnual !== null && <div><span>IPTU</span><b>{formatCurrency(item.financial.iptuAnnual)}/ano</b></div>}
            </div>
            <div className="conditions">
              {item.financial.acceptsFinancing !== null && <span>{item.financial.acceptsFinancing ? '✓' : '×'} Financiamento</span>}
              {item.financial.acceptsExchange !== null && <span>{item.financial.acceptsExchange ? '✓' : '×'} Permuta</span>}
            </div>
            {item.financial.negotiationText && <p className="negotiation-text">{item.financial.negotiationText}</p>}
            <ShareActions publicId={item.publicId} summary={item.whatsappSummary} />
            <p className="disclaimer">Preço e disponibilidade sujeitos à confirmação.</p>
          </aside>
        </div>
      </div>

      <footer><div className="container"><ShieldCheck />Esta ficha contém somente informações autorizadas para divulgação.</div></footer>
    </main>
  );
}

function metric(value: number | null, label: string, Icon: any) {
  return value === null ? null : { value, label, Icon };
}

function formatCurrency(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('pt-BR');
}

function typeText(value: string) {
  const map: Record<string, string> = { casa: 'Casa', apartamento: 'Apartamento', terreno: 'Terreno', sala_comercial: 'Sala comercial', galpao: 'Galpão', loja: 'Loja', outro: 'Imóvel' };
  return map[value] || value;
}

function statusText(value: string) {
  const map: Record<string, string> = { disponivel: 'Disponível', reservado: 'Reservado', em_negociacao: 'Em negociação', vendido: 'Vendido' };
  return map[value] || value;
}
