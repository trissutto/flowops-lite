import {
  buildPublicationChecklist,
  defaultWhatsappSummary,
  preparePublicProperty,
} from './properties-publication.contract';

const completeProperty = () => ({
  id: 'internal-property-id',
  name: 'Casa Jardim Europa',
  cep: '01449000',
  endereco: 'Rua Segura',
  numero: '100',
  complemento: null,
  bairro: 'Jardim Europa',
  cidade: 'São Paulo',
  estado: 'SP',
  proprietario: 'SEGREDO-NUNCA-PUBLICAR',
  observacoes: 'OUTRO-SEGREDO',
  water: { codigoFornecimento: 'PRIVADO' },
  deed: { numero: 'MATRICULA-PRIVADA' },
  attachments: [{ fileUrl: 'https://interno/documento-privado.pdf' }],
  commercialProfile: {
    municipalRegistration: '123.456.789',
    propertyType: 'casa',
    commercialStatus: 'disponivel',
    mapUrl: 'https://maps.example/imovel',
    publicLocationNote: 'Próxima ao parque',
    publishFullAddress: true,
    landAreaM2: 420,
    landAreaNotApplicable: false,
    builtAreaM2: 280,
    builtAreaNotApplicable: false,
    usefulAreaM2: 250,
    bedrooms: 4,
    suites: 2,
    bathrooms: 4,
    parkingSpaces: 3,
    floor: null,
    elevator: false,
    furnished: true,
    constructionYear: 2018,
    features: ['Piscina', 'Jardim', 'Piscina'],
    salePrice: 2500000,
    condominiumMonthly: 0,
    iptuAnnual: 12500,
    acceptsFinancing: true,
    acceptsExchange: false,
    negotiable: true,
    negotiationText: 'Propostas serão analisadas.',
    description: 'Casa pronta para morar.',
    whatsappSummary: null,
    campaignTitle: 'Casa especial no Jardim Europa',
    lastReviewedAt: new Date('2026-08-08T12:00:00.000Z'),
    brokerCommissionNotes: '6% — PRIVADO',
    internalNegotiationNotes: 'Piso interno — PRIVADO',
  },
  commercialMedia: [
    {
      id: 'media-publica-1',
      kind: 'photo',
      fileName: 'fachada.jpg',
      sourceUrl: 'https://files.example/internal-source.jpg',
      mimeType: 'image/jpeg',
      fileSize: 120000,
      caption: 'Fachada',
      sortOrder: 0,
      isCover: true,
      active: true,
    },
  ],
});

describe('contrato público de imóveis', () => {
  it('publica somente a allowlist e mantém a URL de origem fora do snapshot', () => {
    const result = preparePublicProperty(
      completeProperty(),
      'abcdefghijklmnopqrstuvwx',
      3,
      new Date('2026-08-08T15:00:00.000Z'),
    );

    expect(result.checklist.ready).toBe(true);
    expect(result.snapshot.publicId).toBe('abcdefghijklmnopqrstuvwx');
    expect(result.snapshot.characteristics.features).toEqual(['Piscina', 'Jardim']);
    expect(result.mediaSources[0].sourceUrl).toBe('https://files.example/internal-source.jpg');
    expect(result.mediaSources[0].id).not.toBe('media-publica-1');

    const publicJson = JSON.stringify(result.snapshot);
    expect(publicJson).not.toContain('SEGREDO-NUNCA-PUBLICAR');
    expect(publicJson).not.toContain('OUTRO-SEGREDO');
    expect(publicJson).not.toContain('MATRICULA-PRIVADA');
    expect(publicJson).not.toContain('documento-privado.pdf');
    expect(publicJson).not.toContain('internal-source.jpg');
    expect(publicJson).not.toContain('brokerCommission');
    expect(publicJson).not.toContain('internalNegotiation');
    expect(publicJson).not.toContain('internal-property-id');
    expect(publicJson).not.toContain('media-publica-1');
  });

  it('bloqueia publicação quando os campos essenciais estão ausentes', () => {
    const property = completeProperty();
    property.commercialProfile.municipalRegistration = '';
    property.commercialProfile.salePrice = 0;
    property.commercialMedia[0].isCover = false;

    const checklist = buildPublicationChecklist(property);
    expect(checklist.ready).toBe(false);
    expect(checklist.items.filter((item) => !item.ok).map((item) => item.key))
      .toEqual(expect.arrayContaining(['municipalRegistration', 'salePrice', 'cover']));
  });

  it('gera resumo de WhatsApp sem dados internos', () => {
    const summary = defaultWhatsappSummary(completeProperty());
    expect(summary).toContain('Casa Jardim Europa');
    expect(summary).toContain('Jardim Europa');
    expect(summary).toContain('R$');
    expect(summary).not.toContain('SEGREDO');
    expect(summary).not.toContain('6%');
  });
});
