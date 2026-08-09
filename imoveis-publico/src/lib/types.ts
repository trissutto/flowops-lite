export type PublicMediaDescriptor = {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string | null;
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
  media: PublicMediaDescriptor[];
};

export type MediaSource = PublicMediaDescriptor & {
  sourceUrl: string;
  fileSize: number | null;
};

export type SyncPayload = {
  action: 'upsert' | 'rotate' | 'revoke';
  publicId: string;
  oldPublicId?: string | null;
  version: number;
  payloadHash?: string;
  publicUrl?: string;
  snapshot?: PublicPropertySnapshot;
  mediaSources?: MediaSource[];
};
