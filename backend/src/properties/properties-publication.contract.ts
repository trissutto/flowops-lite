import { createHash } from 'crypto';

export const PUBLIC_PROPERTY_SCHEMA_VERSION = 1;

export const PRIVATE_PROPERTY_FIELDS = [
  'proprietário',
  'comissão e negociação interna',
  'contas de água e energia',
  'matrícula e cartório',
  'escritura',
  'anexos patrimoniais e de IPTU',
  'observações internas',
  'usuários e histórico de auditoria',
];

export type ChecklistItem = {
  key: string;
  label: string;
  ok: boolean;
};

export type PublicationChecklist = {
  ready: boolean;
  items: ChecklistItem[];
};

export type PublicMediaSource = {
  id: string;
  kind: string;
  fileName: string;
  sourceUrl: string;
  mimeType: string | null;
  fileSize: number | null;
  caption: string | null;
  sortOrder: number;
  isCover: boolean;
};

export type PublicPropertySnapshot = {
  schemaVersion: number;
  publicId: string;
  version: number;
  name: string;
  campaignTitle: string | null;
  municipalRegistration: string;
  propertyType: string;
  commercialStatus: string;
  address: {
    cep: string | null;
    endereco: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    estado: string | null;
    mapUrl: string | null;
    locationNote: string | null;
    fullAddressPublished: boolean;
  };
  areas: {
    landM2: number | null;
    landNotApplicable: boolean;
    builtM2: number | null;
    builtNotApplicable: boolean;
    usefulM2: number | null;
  };
  characteristics: {
    bedrooms: number | null;
    suites: number | null;
    bathrooms: number | null;
    parkingSpaces: number | null;
    floor: number | null;
    elevator: boolean | null;
    furnished: boolean | null;
    constructionYear: number | null;
    features: string[];
  };
  financial: {
    salePrice: number;
    condominiumMonthly: number | null;
    iptuAnnual: number | null;
    acceptsFinancing: boolean | null;
    acceptsExchange: boolean | null;
    negotiable: boolean | null;
    negotiationText: string | null;
  };
  description: string;
  whatsappSummary: string;
  lastReviewedAt: string | null;
  publishedAt: string;
  media: Array<Omit<PublicMediaSource, 'sourceUrl' | 'fileSize'>>;
};

export type PreparedPublication = {
  checklist: PublicationChecklist;
  snapshot: PublicPropertySnapshot;
  mediaSources: PublicMediaSource[];
  privateFields: string[];
};

const textOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const positiveNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const integerOrNull = (value: unknown): number | null => {
  const number = positiveNumberOrNull(value);
  return number === null ? null : Math.trunc(number);
};

const booleanOrNull = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const compactFeatures = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map(textOrNull).filter((item): item is string => !!item)),
  ).slice(0, 50);
};

export function buildPublicationChecklist(property: any): PublicationChecklist {
  const profile = property?.commercialProfile;
  const activeMedia = Array.isArray(property?.commercialMedia)
    ? property.commercialMedia.filter((media: any) => media?.active !== false)
    : [];
  const positiveAreas = [
    profile?.landAreaM2,
    profile?.builtAreaM2,
    profile?.usefulAreaM2,
  ].some((value) => Number(value) > 0);

  const items: ChecklistItem[] = [
    { key: 'name', label: 'Nome comercial', ok: !!textOrNull(property?.name) },
    {
      key: 'municipalRegistration',
      label: 'Inscrição municipal',
      ok: !!textOrNull(profile?.municipalRegistration),
    },
    {
      key: 'propertyType',
      label: 'Tipo do imóvel',
      ok: !!textOrNull(profile?.propertyType),
    },
    {
      key: 'commercialStatus',
      label: 'Situação comercial',
      ok: !!textOrNull(profile?.commercialStatus),
    },
    {
      key: 'address',
      label: 'Endereço completo',
      ok: [property?.cep, property?.endereco, property?.numero, property?.bairro, property?.cidade, property?.estado]
        .every((value) => !!textOrNull(value)),
    },
    {
      key: 'salePrice',
      label: 'Valor de venda',
      ok: Number(profile?.salePrice) > 0,
    },
    {
      key: 'landArea',
      label: 'Área do terreno ou “não se aplica”',
      ok: Number(profile?.landAreaM2) > 0 || profile?.landAreaNotApplicable === true,
    },
    {
      key: 'builtArea',
      label: 'Área construída ou “não se aplica”',
      ok: Number(profile?.builtAreaM2) > 0 || profile?.builtAreaNotApplicable === true,
    },
    {
      key: 'someArea',
      label: 'Ao menos uma metragem informada',
      ok: positiveAreas,
    },
    {
      key: 'description',
      label: 'Descrição comercial',
      ok: !!textOrNull(profile?.description),
    },
    {
      key: 'cover',
      label: 'Foto de capa',
      ok: activeMedia.some((media: any) => media?.kind === 'photo' && media?.isCover),
    },
  ];

  return { ready: items.every((item) => item.ok), items };
}

export function defaultWhatsappSummary(property: any): string {
  const profile = property?.commercialProfile || {};
  const location = [property?.bairro, property?.cidade, property?.estado]
    .map(textOrNull)
    .filter(Boolean)
    .join(' · ');
  const areas = [
    Number(profile?.landAreaM2) > 0 ? `${Number(profile.landAreaM2)} m² de terreno` : null,
    Number(profile?.builtAreaM2) > 0 ? `${Number(profile.builtAreaM2)} m² construídos` : null,
    Number(profile?.usefulAreaM2) > 0 ? `${Number(profile.usefulAreaM2)} m² úteis` : null,
  ].filter(Boolean);
  const price = Number(profile?.salePrice);
  const formattedPrice = Number.isFinite(price) && price > 0
    ? price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'valor sob consulta';
  const features = compactFeatures(profile?.features).slice(0, 3);

  return [
    `*${textOrNull(property?.name) || 'Imóvel'}*`,
    textOrNull(profile?.propertyType),
    location || null,
    areas.length ? areas.join(' · ') : null,
    `Valor: ${formattedPrice}`,
    features.length ? `Diferenciais: ${features.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

export function preparePublicProperty(
  property: any,
  publicId: string,
  version: number,
  publishedAt = new Date(),
): PreparedPublication {
  const profile = property?.commercialProfile || {};
  const checklist = buildPublicationChecklist(property);
  const publishFullAddress = profile?.publishFullAddress !== false;
  const mediaSources: PublicMediaSource[] = (Array.isArray(property?.commercialMedia)
    ? property.commercialMedia
    : [])
    .filter((media: any) => media?.active !== false)
    .sort((a: any, b: any) => Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0))
    .map((media: any) => ({
      id: publicMediaId(publicId, String(media.id)),
      kind: textOrNull(media.kind) || 'photo',
      fileName: textOrNull(media.fileName) || 'arquivo',
      sourceUrl: String(media.sourceUrl || ''),
      mimeType: textOrNull(media.mimeType),
      fileSize: integerOrNull(media.fileSize),
      caption: textOrNull(media.caption),
      sortOrder: integerOrNull(media.sortOrder) || 0,
      isCover: media.isCover === true,
    }));

  const snapshot: PublicPropertySnapshot = {
    schemaVersion: PUBLIC_PROPERTY_SCHEMA_VERSION,
    publicId,
    version,
    name: textOrNull(property?.name) || '',
    campaignTitle: textOrNull(profile?.campaignTitle),
    municipalRegistration: textOrNull(profile?.municipalRegistration) || '',
    propertyType: textOrNull(profile?.propertyType) || '',
    commercialStatus: textOrNull(profile?.commercialStatus) || 'disponivel',
    address: {
      cep: publishFullAddress ? textOrNull(property?.cep) : null,
      endereco: publishFullAddress ? textOrNull(property?.endereco) : null,
      numero: publishFullAddress ? textOrNull(property?.numero) : null,
      complemento: publishFullAddress ? textOrNull(property?.complemento) : null,
      bairro: textOrNull(property?.bairro),
      cidade: textOrNull(property?.cidade),
      estado: textOrNull(property?.estado),
      mapUrl: textOrNull(profile?.mapUrl),
      locationNote: textOrNull(profile?.publicLocationNote),
      fullAddressPublished: publishFullAddress,
    },
    areas: {
      landM2: positiveNumberOrNull(profile?.landAreaM2),
      landNotApplicable: profile?.landAreaNotApplicable === true,
      builtM2: positiveNumberOrNull(profile?.builtAreaM2),
      builtNotApplicable: profile?.builtAreaNotApplicable === true,
      usefulM2: positiveNumberOrNull(profile?.usefulAreaM2),
    },
    characteristics: {
      bedrooms: integerOrNull(profile?.bedrooms),
      suites: integerOrNull(profile?.suites),
      bathrooms: integerOrNull(profile?.bathrooms),
      parkingSpaces: integerOrNull(profile?.parkingSpaces),
      floor: integerOrNull(profile?.floor),
      elevator: booleanOrNull(profile?.elevator),
      furnished: booleanOrNull(profile?.furnished),
      constructionYear: integerOrNull(profile?.constructionYear),
      features: compactFeatures(profile?.features),
    },
    financial: {
      salePrice: positiveNumberOrNull(profile?.salePrice) || 0,
      condominiumMonthly: positiveNumberOrNull(profile?.condominiumMonthly),
      iptuAnnual: positiveNumberOrNull(profile?.iptuAnnual),
      acceptsFinancing: booleanOrNull(profile?.acceptsFinancing),
      acceptsExchange: booleanOrNull(profile?.acceptsExchange),
      negotiable: booleanOrNull(profile?.negotiable),
      negotiationText: textOrNull(profile?.negotiationText),
    },
    description: textOrNull(profile?.description) || '',
    whatsappSummary: textOrNull(profile?.whatsappSummary) || defaultWhatsappSummary(property),
    lastReviewedAt: profile?.lastReviewedAt
      ? new Date(profile.lastReviewedAt).toISOString()
      : null,
    publishedAt: publishedAt.toISOString(),
    media: mediaSources.map(({ sourceUrl: _sourceUrl, fileSize: _fileSize, ...media }) => media),
  };

  return {
    checklist,
    snapshot,
    mediaSources,
    privateFields: [...PRIVATE_PROPERTY_FIELDS],
  };
}

function publicMediaId(publicId: string, internalMediaId: string) {
  return createHash('sha256')
    .update(`${publicId}:${internalMediaId}`)
    .digest('base64url')
    .slice(0, 24);
}
