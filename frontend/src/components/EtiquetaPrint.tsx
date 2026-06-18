'use client';

/**
 * EtiquetaPrint — Componente compartilhado de etiquetas.
 *
 * Padrão único usado em:
 *   /loja/reposicao
 *   /loja/pedidos-compra/[id]/etiquetas
 *   /loja/etiquetas-avulsas
 *
 * Layout 48×30mm, grid 2 colunas (108mm — rolo Argox), barcode EAN13 com
 * fallback CODE128, descrição em 2 linhas, REF + tamanho em destaque,
 * cor com font-size adaptativa pela qty de caracteres, preço fixo.
 */

import { useEffect } from 'react';

export interface EtiquetaLabel {
  ref: string;
  cor: string;
  tamanho: string;
  codigo: string;
  preco: number;
  descricao: string;
  marca?: string | null;
}

interface Props {
  labels: EtiquetaLabel[];
}

/**
 * Calcula font-size adaptativo pra cor baseado em chars.
 * (Mantém proporção natural, não estica/encolhe glifos.)
 */
function corFontSize(cor: string): string {
  const len = (cor || '').length;
  if (len <= 6) return '11pt';
  if (len <= 10) return '9pt';
  if (len <= 13) return '7pt';
  if (len <= 18) return '6pt';
  if (len <= 24) return '5pt';
  return '4.5pt';
}

/**
 * Font-size adaptativo pra REF (et-tam) — REFs longas tipo "VLM-222ROY"
 * quebravam em 2 linhas e empurravam o barcode.
 */
function refFontSize(ref: string): string {
  const len = (ref || '').length;
  if (len <= 4) return '12pt';
  if (len <= 6) return '11pt';
  if (len <= 8) return '9.5pt';
  if (len <= 10) return '8pt';
  if (len <= 12) return '7pt';
  return '6pt';
}

export default function EtiquetaPrint({ labels }: Props) {
  // ── Carrega JsBarcode + renderiza códigos ─────────────────────────────
  useEffect(() => {
    if (!labels || labels.length === 0) return;

    const renderBarcodes = () => {
      // @ts-expect-error JsBarcode global injetado via CDN
      if (typeof window === 'undefined' || !window.JsBarcode) return;
      document.querySelectorAll<HTMLElement>('.barcode-target').forEach((el) => {
        const code = el.dataset.code || '';
        if (!code) return;
        // Força SVG a preencher container e permitir números fora do viewBox
        const stretchSvg = (svg: HTMLElement) => {
          svg.setAttribute('preserveAspectRatio', 'none');
          svg.removeAttribute('width');
          svg.removeAttribute('height');
          svg.style.overflow = 'visible';
        };
        try {
          // @ts-expect-error JsBarcode global
          window.JsBarcode(el, code, {
            format: 'EAN13',
            width: 1.8,
            height: 32,
            displayValue: true,
            fontSize: 18,
            fontOptions: 'bold',
            textMargin: 3,
            margin: 0,
            background: '#fff',
            lineColor: '#000',
          });
          stretchSvg(el);
        } catch {
          // Se não for EAN13 válido, CODE128 como fallback
          try {
            // @ts-expect-error
            window.JsBarcode(el, code, {
              format: 'CODE128',
              width: 1.8,
              height: 32,
              displayValue: true,
              fontSize: 18,
              fontOptions: 'bold',
              textMargin: 3,
              margin: 0,
            });
            stretchSvg(el);
          } catch { /* ignora */ }
        }
      });
    };

    // @ts-expect-error
    if (window.JsBarcode) {
      renderBarcodes();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
    script.onload = renderBarcodes;
    document.head.appendChild(script);
  }, [labels]);

  if (!labels || labels.length === 0) return null;

  return (
    <>
      <main>
        <div className="etiquetas-grid">
          {labels.map((l, i) => (
            <div key={`${l.codigo}-${i}`} className="etiqueta">
              {/* Descrição (sem REF/COR/TAM duplicados) */}
              <div className="et-descricao">
                {l.descricao
                  .replace(new RegExp(`\\b${l.ref}\\b`, 'g'), '')
                  .replace(new RegExp(`\\b${l.cor}\\b`, 'g'), '')
                  .replace(new RegExp(`\\b${l.tamanho}\\b`, 'g'), '')
                  .replace(/\s+/g, ' ')
                  .trim()}
              </div>
              {/* REF + TAMANHO em destaque */}
              <div className="et-destaque">
                <span className="et-tam" style={{ fontSize: refFontSize(l.ref), whiteSpace: 'nowrap' }}>{l.ref}</span>
                <span className="et-cor-destaque">{l.tamanho}</span>
              </div>
              {/* Código de barras */}
              <svg className="barcode-target" data-code={l.codigo} />
              {/* Cor + preço */}
              <div className="et-base">
                <span className="et-base-ref" style={{ fontSize: corFontSize(l.cor) }}>
                  {l.cor}
                </span>
                <span className="et-base-preco">R$ {l.preco.toFixed(2).replace('.', ',')}</span>
              </div>
            </div>
          ))}
        </div>
      </main>

      <style jsx global>{`
        /* Grid: 2 colunas de 48mm em rolo de 108mm (Argox padrão) */
        .etiquetas-grid {
          display: grid;
          grid-template-columns: 48mm 48mm;
          gap: 0 6mm;
          padding: 21mm 0 0 3mm; /* ajuste jun/2026: +3mm baixo + 3mm esquerda */
          width: 108mm;
          margin: 0 auto;
          background: #fff;
        }
        .etiqueta {
          width: 48mm;
          height: 30mm;
          box-sizing: border-box;
          padding: 1.2mm 1.5mm 0.8mm 1.5mm;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 0.3mm;
          border: 1px dashed #cbd5e1;
          background: #fff;
          font-family: -apple-system, system-ui, sans-serif;
          color: #000;
          overflow: hidden;
        }
        .et-descricao {
          font-size: 7pt;
          font-weight: 900;
          text-transform: uppercase;
          line-height: 1.05;
          letter-spacing: 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          max-height: 5.2mm;
          flex-shrink: 0;
        }
        .et-destaque {
          display: flex;
          align-items: center;
          gap: 1.5mm;
          line-height: 1;
          flex-shrink: 0;
        }
        .et-tam {
          font-size: 12pt;
          font-weight: 900;
          font-family: Arial Black, Arial, -apple-system, system-ui, sans-serif;
          border: 1.5px solid #000;
          padding: 0 1.2mm;
          line-height: 1.1;
          letter-spacing: 0.3px;
          white-space: nowrap;
          overflow: hidden;
          max-width: 28mm;
        }
        .et-cor-destaque {
          font-size: 15pt;
          font-weight: 900;
          font-family: 'Courier New', monospace;
          text-transform: uppercase;
          letter-spacing: 0;
          margin-left: auto;
          border: 1.5px solid #000;
          padding: 0.2mm 1.5mm;
          line-height: 1;
        }
        .barcode-target {
          width: 80%;
          height: 10mm;
          display: block;
          margin: 0 auto;
          overflow: visible;
          flex-shrink: 0;
        }
        .et-base {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          line-height: 1;
          border-top: 0.5px solid #cbd5e1;
          padding-top: 0.5mm;
          min-width: 0;
          gap: 2mm;
        }
        .et-base-ref {
          font-weight: 900;
          letter-spacing: 0.2px;
          text-transform: uppercase;
          flex: 1 1 auto;
          min-width: 0;
          max-width: 28mm;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          padding-right: 1mm;
          line-height: 1.1;
        }
        .et-base-preco {
          font-size: 11pt;
          font-weight: 900;
          flex-shrink: 0;
          white-space: nowrap;
        }
        @media print {
          body { background: white !important; margin: 0 !important; padding: 0 !important; }
          @page {
            size: 108mm auto;
            margin: 0;
          }
          .etiquetas-grid {
            padding: 21mm 0 0 3mm; /* ajuste jun/2026: +3mm baixo + 3mm esquerda */
            page-break-inside: auto;
          }
          .etiqueta {
            border: none !important;
            page-break-inside: avoid;
          }
        }
      `}</style>
    </>
  );
}
