/**
 * NFC-e SEFAZ-SP — assinatura digital, transmissão e QR Code.
 *
 * Implementa o fluxo essencial pra emitir NFC-e em SP:
 *  1. signXmlNfeWithA1   — assina <infNFe> com cert A1 (xmldsig)
 *  2. buildQrCodeUrlNfce — monta URL de consulta + hash CSC
 *  3. transmitNfeSefazSp — envia ao webservice SEFAZ-SP (síncrono)
 *
 * Layout NF-e 4.00. UF=SP.
 *
 * Observações importantes:
 *  - O certificado A1 deve estar em formato PFX (PKCS#12) com senha.
 *  - O CSC + idCSC vêm do portal SEFAZ-SP (Configurações → CSC NFC-e).
 *  - Em homologação, transmissão funciona com cert REAL e CSC fictício
 *    (fixado em "000001" / "00000000-0000-0000-0000-000000000000").
 *  - Em produção, usar CSC real obtido no portal SEFAZ.
 */

import * as crypto from 'crypto';
// @ts-ignore — módulos instalados no deploy via package.json
import * as forge from 'node-forge';
// @ts-ignore
import { SignedXml } from 'xml-crypto';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════════════
// 1. ASSINATURA XML
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extrai chave privada e certificado do PFX (base64 + senha).
 */
export function extractA1FromPfx(pfxBase64: string, password: string): {
  privateKeyPem: string;
  certPem: string;
} {
  const pfxDer = forge.util.decode64(pfxBase64);
  const pfxAsn1 = forge.asn1.fromDer(pfxDer);
  const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, password);

  // Pega bag com chave privada
  const keyBag = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
    forge.pki.oids.pkcs8ShroudedKeyBag
  ]?.[0]
    || pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];

  if (!keyBag?.key) {
    throw new Error('Chave privada não encontrada no PFX');
  }
  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);

  // Pega bag com certificado
  const certBag = pfx.getBags({ bagType: forge.pki.oids.certBag })[
    forge.pki.oids.certBag
  ]?.[0];
  if (!certBag?.cert) {
    throw new Error('Certificado não encontrado no PFX');
  }
  const certPem = forge.pki.certificateToPem(certBag.cert);

  return { privateKeyPem, certPem };
}

/**
 * Assina o nó <infNFe> dentro do XML <NFe> com xmldsig.
 * Retorna XML completo com <Signature> dentro de <NFe>.
 */
export function signXmlNfeWithA1(input: {
  xml: string;
  pfxBase64: string;
  pfxPassword: string;
}): string {
  const { privateKeyPem, certPem } = extractA1FromPfx(
    input.pfxBase64,
    input.pfxPassword,
  );

  // Pega só o conteúdo PEM (entre BEGIN/END), em base64 sem cabeçalho
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

  // Referência ao <infNFe Id="...">
  sig.addReference({
    xpath: "//*[local-name(.)='infNFe']",
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
  });

  sig.computeSignature(input.xml, {
    location: { reference: "//*[local-name(.)='NFe']", action: 'append' },
  });

  let signed = sig.getSignedXml();

  // SEFAZ exige X509Certificate dentro de KeyInfo (xml-crypto às vezes omite)
  if (!/<X509Certificate>/.test(signed)) {
    signed = signed.replace(
      /<KeyInfo>/,
      `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`,
    );
  }

  return signed;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. QR CODE NFC-e
// ═══════════════════════════════════════════════════════════════════════

/**
 * Constrói a URL do QR Code NFC-e conforme Manual de Orientação 6.0.
 *
 * Modelo NFC-e síncrono (autorizada antes da emissão do QR):
 *   URL = base?p=chave|versaoQR|tpAmb|idCSC|hash
 *   hash = SHA1(chave|versaoQR|tpAmb|idCSC|cscToken) em hex maiusculo
 *
 * SP base:
 *   - Homolog: https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode
 *   - Produc:  https://www.nfce.fazenda.sp.gov.br/qrcode
 */
export function buildQrCodeUrlNfce(input: {
  chave: string;
  ambiente: '1' | '2'; // 1=produção, 2=homologação
  idCSC: string;
  cscToken: string;
  versaoQR?: string; // default "2"
}): string {
  const versao = input.versaoQR || '2';
  const tpAmb = input.ambiente;
  const idCSC = String(parseInt(input.idCSC, 10)); // SEFAZ aceita sem zero-pad

  // Concatena pra hash
  const semHash = `${input.chave}|${versao}|${tpAmb}|${idCSC}`;
  const hash = crypto
    .createHash('sha1')
    .update(semHash + input.cscToken)
    .digest('hex')
    .toUpperCase();

  const baseUrl =
    tpAmb === '1'
      ? 'https://www.nfce.fazenda.sp.gov.br/qrcode'
      : 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode';

  return `${baseUrl}?p=${semHash}|${hash}`;
}

/**
 * URL de consulta do consumidor (impressa no DANFE).
 */
export function buildUrlConsultaNfce(ambiente: '1' | '2'): string {
  return ambiente === '1'
    ? 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx'
    : 'https://www.homologacao.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx';
}

// ═══════════════════════════════════════════════════════════════════════
// 3. TRANSMISSÃO SEFAZ-SP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Endpoints SEFAZ-SP NFC-e (Layout 4.00).
 *
 * NFC-e usa endpoints específicos (diferente de NF-e modelo 55).
 */
const SEFAZ_SP_NFCE_ENDPOINTS = {
  // Autorização síncrona (tpAmb=2 → homolog, tpAmb=1 → produção)
  '1': {
    autorizacao:
      'https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
    consultaProtocolo:
      'https://nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
    consultaRecibo:
      'https://nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
  },
  '2': {
    autorizacao:
      'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
    consultaProtocolo:
      'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
    consultaRecibo:
      'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
  },
} as const;

export interface TransmitResult {
  success: boolean;
  cStat: string; // código SEFAZ (100 = autorizada, 101 = cancelada, etc)
  xMotivo: string; // mensagem
  protocolo?: string;
  dhRecbto?: string;
  xmlAutorizado?: string; // XML completo + protocolo (procNFe)
  xmlEnviado: string;
  xmlResposta: string;
  error?: string;
}

/**
 * Transmite NFC-e assinada pra SEFAZ-SP via SOAP. Modo síncrono (lote 1).
 */
export async function transmitNfeSefazSp(input: {
  xmlAssinado: string;
  ambiente: '1' | '2';
  pfxBase64: string;
  pfxPassword: string;
  idLote?: string;
}): Promise<TransmitResult> {
  const idLote = input.idLote || String(Date.now()).slice(-15);
  const endpoint = SEFAZ_SP_NFCE_ENDPOINTS[input.ambiente].autorizacao;

  // Monta lote (indSinc=1 = síncrono)
  const enviNFe = `<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
<idLote>${idLote}</idLote>
<indSinc>1</indSinc>
${input.xmlAssinado}
</enviNFe>`;

  // SOAP envelope
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
<soap:Body>
<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">${enviNFe}</nfeDadosMsg>
</soap:Body>
</soap:Envelope>`;

  // Cria agent HTTPS com certificado cliente (mTLS)
  const { privateKeyPem, certPem } = extractA1FromPfx(
    input.pfxBase64,
    input.pfxPassword,
  );

  const https = require('https');
  const agent = new https.Agent({
    cert: certPem,
    key: privateKeyPem,
    rejectUnauthorized: false, // SEFAZ tem cert cadeia complicada
    minVersion: 'TLSv1.2',
    // Ciphers compatíveis com SEFAZ-SP (alguns endpoints rejeitam ciphers modernos default)
    ciphers: [
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'AES128-SHA',
      'AES256-SHA',
      'DES-CBC3-SHA',
    ].join(':'),
  });

  // SP NFC-e — SOAP 1.2 com action embutido no Content-Type (asmx exige)
  const SOAP_ACTION =
    'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote';

  let xmlResposta = '';
  try {
    const resp = await axios.post(endpoint, soap, {
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"`,
        Accept: 'application/soap+xml, text/xml, */*',
        SOAPAction: SOAP_ACTION,
      },
      httpsAgent: agent,
      timeout: 60000,
      maxBodyLength: 10 * 1024 * 1024,
      // Não rejeitar erros 4xx — capturamos pra mostrar resposta da SEFAZ
      validateStatus: () => true,
    });

    xmlResposta = String(resp.data || '');

    // Se HTTP não-2xx, tratamos como erro de comunicação mas com body capturado
    if (resp.status < 200 || resp.status >= 300) {
      return {
        success: false,
        cStat: '999',
        xMotivo: `SEFAZ retornou HTTP ${resp.status} ${resp.statusText || ''}`.trim(),
        xmlEnviado: enviNFe,
        xmlResposta:
          xmlResposta ||
          `(sem body) headers: ${JSON.stringify(resp.headers || {}, null, 2)}`,
        error: `HTTP ${resp.status}`,
      };
    }
  } catch (e: any) {
    const respData = e?.response?.data ? String(e.response.data) : '';
    const respStatus = e?.response?.status ? `HTTP ${e.response.status}` : '';
    const respHeaders = e?.response?.headers
      ? `\nHeaders: ${JSON.stringify(e.response.headers, null, 2)}`
      : '';
    return {
      success: false,
      cStat: '999',
      xMotivo: e?.message || 'Erro de comunicação com SEFAZ',
      xmlEnviado: enviNFe,
      xmlResposta: respData || `${respStatus}${respHeaders}`,
      error: e?.message,
    };
  }

  // Parse resposta (cStat, xMotivo, protocolo)
  const parsed = parseSefazResponse(xmlResposta);
  let xmlAutorizado: string | undefined;
  if (parsed.cStat === '100' && parsed.protocolo) {
    // NFC-e AUTORIZADA — monta procNFe (XML + protocolo, formato pro DANFE)
    xmlAutorizado = buildProcNFe(input.xmlAssinado, parsed.protXml || '');
  }

  return {
    success: parsed.cStat === '100',
    cStat: parsed.cStat,
    xMotivo: parsed.xMotivo,
    protocolo: parsed.protocolo,
    dhRecbto: parsed.dhRecbto,
    xmlAutorizado,
    xmlEnviado: enviNFe,
    xmlResposta,
  };
}

/** Parse simplificado do retorno SEFAZ pra pegar cStat/xMotivo/protocolo. */
function parseSefazResponse(xml: string): {
  cStat: string;
  xMotivo: string;
  protocolo?: string;
  protXml?: string;
  dhRecbto?: string;
} {
  const get = (tag: string) => {
    const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}>([^<]+)</`, 'i'));
    return m?.[1]?.trim() || '';
  };

  // Em modo síncrono, retorno tem <protNFe> direto dentro de <retEnviNFe>
  const cStatLote = get('cStat');
  const xMotivoLote = get('xMotivo');

  // Pega <protNFe> inteiro pra montar procNFe
  const protMatch = xml.match(/<protNFe[\s\S]*?<\/protNFe>/);
  const protXml = protMatch?.[0];

  if (protXml) {
    const cStatProt = (protXml.match(/<cStat>([^<]+)<\/cStat>/) || [])[1] || '';
    const xMotivoProt =
      (protXml.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] || '';
    const protocolo =
      (protXml.match(/<nProt>([^<]+)<\/nProt>/) || [])[1] || '';
    const dhRecbto =
      (protXml.match(/<dhRecbto>([^<]+)<\/dhRecbto>/) || [])[1] || '';
    return { cStat: cStatProt, xMotivo: xMotivoProt, protocolo, protXml, dhRecbto };
  }

  return { cStat: cStatLote, xMotivo: xMotivoLote };
}

/** Junta NFe assinada + protocolo num único XML procNFe (pra arquivo + DANFE). */
function buildProcNFe(nfeAssinada: string, protXml: string): string {
  // Extrai só o <NFe ...>...</NFe>
  const nfeMatch = nfeAssinada.match(/<NFe[\s\S]*<\/NFe>/);
  const nfe = nfeMatch?.[0] || nfeAssinada;
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
${nfe}
${protXml}
</nfeProc>`;
}
