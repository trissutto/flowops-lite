/**
 * DC-e (Declaração de Conteúdo eletrônica, modelo 99) — assinatura e
 * transmissão ao ambiente autorizador nacional (SVD, hospedado no PR).
 *
 * Reaproveita o motor fiscal da NFC-e (extractA1FromPfx / mesmo padrão de
 * SignedXml, agent mTLS, retry) — só mudam: xpath da assinatura (infDCe/DCe),
 * namespace, envelope SOAP e endpoints.
 *
 * Webservices (portal SVRS → dfe-portal.svrs.rs.gov.br/Dce/Servicos, v1.00):
 *   prod:    https://dce.fazenda.pr.gov.br/dce/DCeAutorizacao
 *   homolog: https://homologacao.dce.fazenda.pr.gov.br/dce/DCeAutorizacao
 *
 * ATENÇÃO (homologação pendente): o nome exato da operação SOAP e se o envio
 * é com/sem lote serão confirmados no primeiro teste contra a homologação —
 * por isso são ajustáveis por env sem deploy:
 *   DCE_SOAP_ACTION, DCE_WSDL_NS, DCE_DADOS_TAG, DCE_ENDPOINT_OVERRIDE
 */

import * as crypto from 'crypto';
// @ts-ignore — instalado no deploy
import { SignedXml } from 'xml-crypto';
import axios from 'axios';
import { extractA1FromPfx } from '../pdv/nfce-sefaz';

export const DCE_NS = 'http://www.portalfiscal.inf.br/dce';
export const DCE_VERSAO = '1.00';

export const DCE_ENDPOINTS = {
  '1': {
    autorizacao: 'https://dce.fazenda.pr.gov.br/dce/DCeAutorizacao',
    consulta: 'https://dce.fazenda.pr.gov.br/dce/DCeConsulta',
    status: 'https://dce.fazenda.pr.gov.br/dce/DCeStatusServico',
    qrcode: 'https://www.fazenda.pr.gov.br/dce/qrcode',
  },
  '2': {
    autorizacao: 'https://homologacao.dce.fazenda.pr.gov.br/dce/DCeAutorizacao',
    consulta: 'https://homologacao.dce.fazenda.pr.gov.br/dce/DCeConsulta',
    status: 'https://homologacao.dce.fazenda.pr.gov.br/dce/DCeStatusServico',
    qrcode: 'https://www.fazenda.pr.gov.br/dce/qrcode',
  },
} as const;

/** Assina o nó <infDCe> dentro de <DCe> (mesmo xmldsig da NFC-e). */
export function signXmlDceWithA1(input: { xml: string; pfxBase64: string; pfxPassword: string }): string {
  const { privateKeyPem, certPem } = extractA1FromPfx(input.pfxBase64, input.pfxPassword);
  const certBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certPem,
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='infDCe']",
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
  });
  sig.computeSignature(input.xml, {
    location: { reference: "//*[local-name(.)='DCe']", action: 'append' },
  });
  let signed = sig.getSignedXml();
  if (!/<X509Certificate>/.test(signed)) {
    signed = signed.replace(
      /<KeyInfo>/,
      `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`,
    );
  }
  return signed;
}

// ── transmissão (mesmo padrão de agent/retry da NFC-e, local a este módulo
//    pra não acoplar nos internals privados de nfce-sefaz) ────────────────
const agentCache = new Map<string, any>();
function getAgent(pfxBase64: string, pfxPassword: string): any {
  const key = crypto.createHash('sha1').update(pfxBase64).digest('hex');
  const hit = agentCache.get(key);
  if (hit) return hit;
  const { privateKeyPem, certPem } = extractA1FromPfx(pfxBase64, pfxPassword);
  const https = require('https');
  const agent = new https.Agent({
    cert: certPem,
    key: privateKeyPem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 4,
  });
  agentCache.set(key, agent);
  return agent;
}

export interface DceTransmitResult {
  success: boolean;
  cStat: string;
  xMotivo: string;
  protocolo?: string;
  dhRecbto?: string;
  xmlAutorizado?: string;
  xmlEnviado: string;
  xmlResposta: string;
  error?: string;
}

/**
 * Transmite a DC-e assinada. Envio direto (sem lote), padrão dos DF-e mais
 * novos — se a homologação exigir lote, ligar DCE_LOTE=1.
 */
export async function transmitDceSvd(input: {
  xmlAssinado: string;
  ambiente: '1' | '2';
  pfxBase64: string;
  pfxPassword: string;
}): Promise<DceTransmitResult> {
  const endpoint = process.env.DCE_ENDPOINT_OVERRIDE || DCE_ENDPOINTS[input.ambiente].autorizacao;
  const wsdlNs = process.env.DCE_WSDL_NS || `${DCE_NS}/wsdl/DCeAutorizacao`;
  const dadosTag = process.env.DCE_DADOS_TAG || 'dceDadosMsg';
  const soapAction = process.env.DCE_SOAP_ACTION || `${wsdlNs}/dceAutorizacao`;

  const xmlLimpo = input.xmlAssinado
    .replace(/^﻿/, '')
    .replace(/<\?xml[^?]*\?>\s*/g, '')
    .trim();

  const payload = process.env.DCE_LOTE === '1'
    ? `<enviDCe xmlns="${DCE_NS}" versao="${DCE_VERSAO}"><idLote>${String(Date.now()).slice(-15)}</idLote>${xmlLimpo}</enviDCe>`
    : xmlLimpo;

  const soap = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><${dadosTag} xmlns="${wsdlNs}">${payload}</${dadosTag}></soap:Body></soap:Envelope>`;

  const agent = getAgent(input.pfxBase64, input.pfxPassword);
  const timeout = Math.max(10000, parseInt(process.env.DCE_TIMEOUT_MS || '60000', 10) || 60000);

  let xmlResposta = '';
  try {
    // retry simples em erro transiente (1s → 3s), padrão da NFC-e
    let resp: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        resp = await axios.post(endpoint, soap, {
          headers: {
            'Content-Type': `application/soap+xml; charset=utf-8; action="${soapAction}"`,
            Accept: 'application/soap+xml, text/xml, */*',
            'User-Agent': 'LurdsOrderOne-DCe/1.0',
          },
          httpsAgent: agent,
          timeout,
          validateStatus: () => true,
        });
        if (resp.status >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        break;
      } catch (e: any) {
        if (attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    xmlResposta = String(resp.data || '');
    if (resp.status < 200 || resp.status >= 300) {
      return {
        success: false, cStat: '999',
        xMotivo: `SVD retornou HTTP ${resp.status}`,
        xmlEnviado: payload, xmlResposta: xmlResposta || '(sem body)', error: `HTTP ${resp.status}`,
      };
    }
  } catch (e: any) {
    return {
      success: false, cStat: '999',
      xMotivo: e?.message || 'Erro de comunicação com o autorizador DC-e',
      xmlEnviado: payload, xmlResposta: e?.response?.data ? String(e.response.data) : '', error: e?.message,
    };
  }

  const parsed = parseDceResponse(xmlResposta);

  // Guard: resposta tem que referenciar a chave enviada (lição da NFC-e 07/07)
  const chaveEnviada = (input.xmlAssinado.match(/Id="DCe(\d{44})"/) || [])[1] || '';
  const chaveResposta = (parsed.protXml?.match(/<chDCe>(\d{44})<\/chDCe>/) || [])[1] || '';
  if (chaveEnviada && chaveResposta && chaveEnviada !== chaveResposta) {
    return {
      success: false, cStat: '999',
      xMotivo: 'Resposta do autorizador refere-se a OUTRA DC-e — nada gravado, tente de novo.',
      xmlEnviado: payload, xmlResposta, error: 'chDCe divergente',
    };
  }

  let xmlAutorizado: string | undefined;
  if (parsed.cStat === '100' && parsed.protXml) {
    const dceMatch = input.xmlAssinado.match(/<DCe[\s\S]*<\/DCe>/);
    xmlAutorizado = `<?xml version="1.0" encoding="UTF-8"?><procDCe xmlns="${DCE_NS}" versao="${DCE_VERSAO}">${dceMatch?.[0] || input.xmlAssinado}${parsed.protXml}</procDCe>`;
  }

  return {
    success: parsed.cStat === '100',
    cStat: parsed.cStat,
    xMotivo: parsed.xMotivo,
    protocolo: parsed.protocolo,
    dhRecbto: parsed.dhRecbto,
    xmlAutorizado,
    xmlEnviado: payload,
    xmlResposta,
  };
}

function parseDceResponse(xml: string): {
  cStat: string; xMotivo: string; protocolo?: string; protXml?: string; dhRecbto?: string;
} {
  const get = (tag: string) => {
    const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}>([^<]+)</`, 'i'));
    return m?.[1]?.trim() || '';
  };
  const protMatch = xml.match(/<protDCe[\s\S]*?<\/protDCe>/);
  const protXml = protMatch?.[0];
  if (protXml) {
    return {
      cStat: (protXml.match(/<cStat>([^<]+)<\/cStat>/) || [])[1] || '',
      xMotivo: (protXml.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] || '',
      protocolo: (protXml.match(/<nProt>([^<]+)<\/nProt>/) || [])[1] || '',
      dhRecbto: (protXml.match(/<dhRecbto>([^<]+)<\/dhRecbto>/) || [])[1] || '',
      protXml,
    };
  }
  return { cStat: get('cStat'), xMotivo: get('xMotivo') };
}

/** URL do QR da DACE (base oficial PR; formato ajustável por env na homolog). */
export function buildDceQrUrl(chave: string, ambiente: '1' | '2'): string {
  const base = process.env.DCE_QR_BASE || DCE_ENDPOINTS[ambiente].qrcode;
  const fmt = process.env.DCE_QR_FORMAT || 'p'; // 'p' → ?p=chave|versao|tpAmb ; 'ch' → ?chDCe=...&tpAmb=...
  if (fmt === 'ch') return `${base}?chDCe=${chave}&tpAmb=${ambiente}`;
  return `${base}?p=${chave}|${DCE_VERSAO.replace('.', '')}|${ambiente}`;
}
