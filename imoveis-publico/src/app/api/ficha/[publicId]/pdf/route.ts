import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/security';
import { getObjectBytes } from '@/lib/storage';
import { PublicPropertySnapshot } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const PAGE = { width: 595.28, height: 841.89, margin: 44 };
const COLORS = {
  ink: rgb(0.09, 0.09, 0.075),
  muted: rgb(0.40, 0.39, 0.35),
  gold: rgb(0.65, 0.50, 0.15),
  green: rgb(0.18, 0.44, 0.28),
  paper: rgb(0.98, 0.975, 0.95),
  line: rgb(0.90, 0.88, 0.83),
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const { publicId } = await params;
    await enforceRateLimit(request, `pdf:${publicId}`, 10);
    const property = await prisma.publicProperty.findFirst({
      where: { publicId, active: true },
      include: { media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!property) return new NextResponse('Ficha indisponível.', { status: 404, headers: noStoreHeaders() });
    const snapshot = property.snapshot as unknown as PublicPropertySnapshot;
    const pdf = await buildPdf(snapshot, property.media);
    const pdfBuffer = Buffer.from(pdf);
    const responseBody = pdfBuffer.buffer.slice(
      pdfBuffer.byteOffset,
      pdfBuffer.byteOffset + pdfBuffer.byteLength,
    ) as ArrayBuffer;
    return new NextResponse(responseBody, {
      headers: {
        ...noStoreHeaders(),
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="ficha-${safeFileName(snapshot.name)}.pdf"`,
      },
    });
  } catch (error: any) {
    const message = /Muitas solicitações/i.test(String(error?.message || '')) ? 'Muitas solicitações.' : 'Não foi possível gerar o PDF.';
    return new NextResponse(message, { status: message.startsWith('Muitas') ? 429 : 500, headers: noStoreHeaders() });
  }
}

async function buildPdf(snapshot: PublicPropertySnapshot, media: Array<any>) {
  const document = await PDFDocument.create();
  document.setTitle(`Ficha — ${snapshot.name}`);
  document.setAuthor("Lurd's Imóveis");
  document.setSubject('Ficha comercial de imóvel');
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const photos = media.filter((item) => item.kind === 'photo' && item.storageKey);
  const cover = photos.find((item) => item.isCover) || photos[0];

  let page = document.addPage([PAGE.width, PAGE.height]);
  fillPage(page);
  page.drawText("LURD'S IMÓVEIS", { x: PAGE.margin, y: 798, size: 14, font: bold, color: COLORS.gold });
  page.drawText('FICHA COMERCIAL', { x: 415, y: 799, size: 9, font: bold, color: COLORS.muted });

  if (cover) {
    const image = await embedImage(document, cover.storageKey, cover.mimeType);
    if (image) drawCover(page, image, PAGE.margin, 470, PAGE.width - PAGE.margin * 2, 292);
  }
  page.drawRectangle({ x: PAGE.margin, y: 443, width: 86, height: 20, color: COLORS.green });
  page.drawText(clean(statusText(snapshot.commercialStatus).toUpperCase()), { x: PAGE.margin + 9, y: 449, size: 8, font: bold, color: rgb(1, 1, 1) });
  page.drawText(clean(typeText(snapshot.propertyType).toUpperCase()), { x: 140, y: 449, size: 9, font: bold, color: COLORS.gold });

  let y = 413;
  const title = clean(snapshot.campaignTitle || snapshot.name);
  y = drawWrapped(page, title, PAGE.margin, y, PAGE.width - PAGE.margin * 2, 26, bold, COLORS.ink, 30) - 8;
  const address = clean([snapshot.address.endereco, snapshot.address.numero, snapshot.address.complemento, snapshot.address.bairro, snapshot.address.cidade, snapshot.address.estado].filter(Boolean).join(', '));
  y = drawWrapped(page, address, PAGE.margin, y, PAGE.width - PAGE.margin * 2, 10, regular, COLORS.muted, 14) - 18;
  page.drawText(formatCurrency(snapshot.financial.salePrice), { x: PAGE.margin, y, size: 24, font: bold, color: COLORS.green });
  y -= 42;
  drawMetricRow(page, snapshot, y, bold, regular);
  y -= 74;
  page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 1, color: COLORS.line });
  y -= 25;
  page.drawText('SOBRE O IMÓVEL', { x: PAGE.margin, y, size: 10, font: bold, color: COLORS.gold });
  y -= 20;
  y = drawWrapped(page, clean(snapshot.description), PAGE.margin, y, PAGE.width - PAGE.margin * 2, 10, regular, COLORS.ink, 15, 10);

  page = document.addPage([PAGE.width, PAGE.height]);
  fillPage(page);
  let secondY = 792;
  secondY = drawSectionTitle(page, 'DETALHES E CONDIÇÕES', secondY, bold);
  const details = detailLines(snapshot);
  for (const [label, value] of details) {
    if (!value) continue;
    page.drawText(clean(label), { x: PAGE.margin, y: secondY, size: 9, font: regular, color: COLORS.muted });
    const valueBottom = drawWrapped(page, clean(value), 250, secondY, PAGE.width - PAGE.margin - 250, 9, bold, COLORS.ink, 12, 4);
    secondY = Math.min(secondY - 22, valueBottom - 8);
  }
  secondY -= 8;
  if (snapshot.characteristics.features.length) {
    secondY = drawSectionTitle(page, 'DIFERENCIAIS', secondY, bold);
    for (const feature of snapshot.characteristics.features.slice(0, 16)) {
      page.drawCircle({ x: PAGE.margin + 3, y: secondY + 3, size: 2.5, color: COLORS.green });
      secondY = drawWrapped(page, clean(feature), PAGE.margin + 14, secondY + 6, PAGE.width - PAGE.margin * 2 - 14, 9, regular, COLORS.ink, 13) - 5;
    }
  }
  secondY -= 6;
  secondY = drawSectionTitle(page, 'REGISTRO', secondY, bold);
  page.drawText('Inscrição municipal', { x: PAGE.margin, y: secondY, size: 9, font: regular, color: COLORS.muted });
  page.drawText(clean(snapshot.municipalRegistration), { x: 250, y: secondY, size: 9, font: bold, color: COLORS.ink });
  secondY -= 28;
  page.drawText('Última atualização', { x: PAGE.margin, y: secondY, size: 9, font: regular, color: COLORS.muted });
  page.drawText(formatDate(snapshot.lastReviewedAt || snapshot.publishedAt), { x: 250, y: secondY, size: 9, font: bold, color: COLORS.ink });

  const publicUrl = `${(process.env.PUBLIC_SITE_URL || 'https://imoveis.lurds.com.br').replace(/\/$/, '')}/i/${snapshot.publicId}`;
  const qrDataUrl = await QRCode.toDataURL(publicUrl, { margin: 0, width: 180, errorCorrectionLevel: 'M' });
  const qr = await document.embedPng(Buffer.from(qrDataUrl.split(',')[1], 'base64'));
  page.drawImage(qr, { x: PAGE.width - PAGE.margin - 96, y: 66, width: 96, height: 96 });
  page.drawText('Acesse a ficha atualizada', { x: PAGE.width - PAGE.margin - 106, y: 50, size: 8, font: regular, color: COLORS.muted });
  page.drawText('Preço e disponibilidade sujeitos à confirmação.', { x: PAGE.margin, y: 54, size: 8, font: regular, color: COLORS.muted });

  const remainingPhotos = photos.filter((item) => item.id !== cover?.id).slice(0, 8);
  if (remainingPhotos.length) {
    for (let index = 0; index < remainingPhotos.length; index += 4) {
      const galleryPage = document.addPage([PAGE.width, PAGE.height]);
      fillPage(galleryPage);
      galleryPage.drawText('GALERIA DO IMÓVEL', { x: PAGE.margin, y: 798, size: 12, font: bold, color: COLORS.gold });
      const batch = remainingPhotos.slice(index, index + 4);
      for (let photoIndex = 0; photoIndex < batch.length; photoIndex++) {
        const image = await embedImage(document, batch[photoIndex].storageKey, batch[photoIndex].mimeType);
        if (!image) continue;
        const column = photoIndex % 2;
        const row = Math.floor(photoIndex / 2);
        const width = 245;
        const height = 320;
        drawCover(galleryPage, image, PAGE.margin + column * 260, 440 - row * 350, width, height);
      }
    }
  }
  return document.save();
}

function fillPage(page: PDFPage) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: COLORS.paper });
}

async function embedImage(document: PDFDocument, storageKey: string, mimeType?: string | null) {
  try {
    const bytes = await getObjectBytes(storageKey);
    return mimeType === 'image/png' ? document.embedPng(bytes) : document.embedJpg(bytes);
  } catch {
    return null;
  }
}

function drawCover(page: PDFPage, image: any, x: number, y: number, width: number, height: number) {
  page.drawRectangle({ x, y, width, height, color: rgb(0.92, 0.91, 0.87) });
  const scale = Math.min(width / image.width, height / image.height);
  const drawnWidth = image.width * scale;
  const drawnHeight = image.height * scale;
  page.drawImage(image, { x: x + (width - drawnWidth) / 2, y: y + (height - drawnHeight) / 2, width: drawnWidth, height: drawnHeight });
  page.drawRectangle({ x, y, width, height, borderWidth: 1, borderColor: COLORS.line, opacity: 0, borderOpacity: 1 });
}

function drawWrapped(page: PDFPage, text: string, x: number, y: number, width: number, size: number, font: PDFFont, color: any, lineHeight: number, maxLines = 99) {
  const words = text.split(/\s+/).filter(Boolean);
  let line = '';
  let lines = 0;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > width && line) {
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
      lines++;
      if (lines >= maxLines) return y;
      line = word;
    } else line = candidate;
  }
  if (line && lines < maxLines) {
    page.drawText(line, { x, y, size, font, color });
    y -= lineHeight;
  }
  return y;
}

function drawMetricRow(page: PDFPage, snapshot: PublicPropertySnapshot, y: number, bold: PDFFont, regular: PDFFont) {
  const metrics = [
    [snapshot.areas.landM2, 'm² terreno'],
    [snapshot.areas.builtM2, 'm² construídos'],
    [snapshot.areas.usefulM2, 'm² úteis'],
    [snapshot.characteristics.bedrooms, 'quartos'],
    [snapshot.characteristics.parkingSpaces, 'vagas'],
  ].filter(([value]) => value !== null).slice(0, 5) as Array<[number, string]>;
  const width = (PAGE.width - PAGE.margin * 2) / Math.max(metrics.length, 1);
  metrics.forEach(([value, label], index) => {
    const x = PAGE.margin + index * width;
    page.drawText(String(value), { x, y, size: 15, font: bold, color: COLORS.ink });
    page.drawText(clean(label), { x, y: y - 14, size: 7.5, font: regular, color: COLORS.muted });
  });
}

function drawSectionTitle(page: PDFPage, title: string, y: number, bold: PDFFont) {
  page.drawText(title, { x: PAGE.margin, y, size: 10, font: bold, color: COLORS.gold });
  page.drawLine({ start: { x: PAGE.margin, y: y - 8 }, end: { x: PAGE.width - PAGE.margin, y: y - 8 }, thickness: 1, color: COLORS.line });
  return y - 30;
}

function detailLines(snapshot: PublicPropertySnapshot): Array<[string, string | null]> {
  const yesNo = (value: boolean | null) => value === null ? null : value ? 'Sim' : 'Não';
  return [
    ['Condomínio mensal', snapshot.financial.condominiumMonthly === null ? null : formatCurrency(snapshot.financial.condominiumMonthly)],
    ['IPTU anual', snapshot.financial.iptuAnnual === null ? null : formatCurrency(snapshot.financial.iptuAnnual)],
    ['Aceita financiamento', yesNo(snapshot.financial.acceptsFinancing)],
    ['Aceita permuta', yesNo(snapshot.financial.acceptsExchange)],
    ['Valor negociável', yesNo(snapshot.financial.negotiable)],
    ['Elevador', yesNo(snapshot.characteristics.elevator)],
    ['Mobiliado', yesNo(snapshot.characteristics.furnished)],
    ['Ano de construção', snapshot.characteristics.constructionYear ? String(snapshot.characteristics.constructionYear) : null],
    ['Condições', snapshot.financial.negotiationText ? clean(snapshot.financial.negotiationText) : null],
  ];
}

function clean(value: string) {
  return String(value || '').replace(/[•–—]/g, '-').replace(/[^\x20-\x7EÀ-ÿ]/g, '').trim();
}

function formatCurrency(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatDate(value: string) { return new Date(value).toLocaleDateString('pt-BR'); }
function safeFileName(value: string) { return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').toLowerCase(); }
function typeText(value: string) { return ({ casa: 'Casa', apartamento: 'Apartamento', terreno: 'Terreno', sala_comercial: 'Sala comercial', galpao: 'Galpão', loja: 'Loja', outro: 'Imóvel' } as Record<string, string>)[value] || value; }
function statusText(value: string) { return ({ disponivel: 'Disponível', reservado: 'Reservado', em_negociacao: 'Em negociação', vendido: 'Vendido' } as Record<string, string>)[value] || value; }
function noStoreHeaders() { return { 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow, noarchive' }; }
