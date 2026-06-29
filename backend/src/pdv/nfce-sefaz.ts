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
 * URL de consulta do consumidor (campo <urlChave> do infNFeSupl).
 *
 * ATENÇÃO: o schema da NFe limita <urlChave> a 85 caracteres (maxLength=85).
 * A URL completa do ConsultaPublica.aspx tem ~95 chars e estoura o limite →
 * rejeição cStat 225 ("Falha no Schema XML do lote de NFe"). A SEFAZ-SP usa
 * a URL CURTA ".../consulta" pra esse campo (a página .aspx é só o site).
 */
export function buildUrlConsultaNfce(ambiente: '1' | '2'): string {
  return ambiente === '1'
    ? 'https://www.nfce.fazenda.sp.gov.br/consulta'
    : 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta';
}

// ═══════════════════════════════════════════════════════════════════════
// 3. TRANSMISSÃO SEFAZ-SP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Códigos de erro de rede TRANSIENTE — vale a pena dar retry.
 * SEFAZ-SP cai com frequência: ECONNRESET (TCP drop), ETIMEDOUT (lento),
 * ECONNREFUSED/EHOSTUNREACH (servidor fora), EAI_AGAIN/ENOTFOUND (DNS).
 */
const SEFAZ_TRANSIENT_ERRORS = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ERR_SOCKET_TIMEOUT',
]);

function isTransientNetworkError(err: any): boolean {
  if (!err) return false;
  const code = String(err?.code || '').toUpperCase();
  if (SEFAZ_TRANSIENT_ERRORS.has(code)) return true;
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('econnreset')) return true;
  if (msg.includes('timeout') && !msg.includes('timeout of')) return true;
  // axios marca erro de rede como sem response e com isAxiosError=true
  if (err?.isAxiosError && !err?.response) return true;
  return false;
}

/**
 * POST SOAP pra SEFAZ com retry automático em erros transientes de rede.
 * Backoff: 1s → 3s → 7s. Max 3 tentativas.
 */
async function postSefazWithRetry(
  endpoint: string,
  soap: string,
  config: any,
  maxAttempts = 3,
): Promise<{ data: string; status: number; statusText?: string; headers?: any; lastError?: any }> {
  let lastError: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.post(endpoint, soap, config);
      // Se HTTP 5xx, também é transiente — retry
      if (resp.status >= 500 && resp.status < 600 && attempt < maxAttempts) {
        lastError = new Error(`HTTP ${resp.status}`);
        const delay = attempt === 1 ? 1000 : attempt === 2 ? 3000 : 7000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return {
        data: String(resp.data || ''),
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      };
    } catch (e: any) {
      lastError = e;
      const transient = isTransientNetworkError(e);
      if (!transient || attempt >= maxAttempts) {
        // Erro definitivo (ou estouramos retries) — propaga
        throw e;
      }
      // Backoff progressivo: 1s, 3s, 7s
      const delay = attempt === 1 ? 1000 : attempt === 2 ? 3000 : 7000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Não deveria chegar aqui, mas por segurança
  throw lastError || new Error('Falha após retries');
}

/**
 * Traduz erro de rede em mensagem amigável pro usuário.
 */
function friendlySefazError(err: any): string {
  const code = String(err?.code || '').toUpperCase();
  const raw = err?.message || '';
  if (code === 'ECONNRESET' || raw.toLowerCase().includes('econnreset') || raw.toLowerCase().includes('socket hang up')) {
    return 'SEFAZ instável (conexão reiniciada). Tente novamente em 30s.';
  }
  if (code === 'ETIMEDOUT' || raw.toLowerCase().includes('timeout')) {
    return 'SEFAZ não respondeu no tempo (lentidão). Tente novamente em 1min.';
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return 'SEFAZ fora do ar. Tente novamente em alguns minutos.';
  }
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
    return 'Falha de DNS pra SEFAZ. Verifique conexão de internet.';
  }
  return raw || 'Erro de comunicação com SEFAZ';
}

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
    // Eventos (cancelamento, carta de correção)
    eventos:
      'https://nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx',
  },
  '2': {
    autorizacao:
      'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
    consultaProtocolo:
      'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
    consultaRecibo:
      'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
    eventos:
      'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx',
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

  // ═══════════════════════════════════════════════════════════════════
  // CRÍTICO: SEFAZ-SP NFC-e exige XML totalmente minificado.
  // - Remover declaração <?xml ...?> (não pode estar dentro do enviNFe)
  // - Remover BOM e whitespace inicial
  // - NÃO podemos minificar entre tags AQUI (quebraria a assinatura),
  //   mas o XML já foi minificado antes da assinatura no buildXml.
  //   Aqui só removemos as junções/declarações.
  // ═══════════════════════════════════════════════════════════════════
  const xmlAssinadoLimpo = input.xmlAssinado
    .replace(/^﻿/, '') // BOM
    .replace(/<\?xml[^?]*\?>\s*/g, '') // qualquer XML declaration
    .trim();

  // Monta lote (indSinc=1 = síncrono) — SEM quebras de linha extras,
  // SEFAZ é sensível a whitespace entre tags do enviNFe
  const enviNFe = `<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>${idLote}</idLote><indSinc>1</indSinc>${xmlAssinadoLimpo}</enviNFe>`;

  // SOAP envelope — única declaração XML no topo do documento
  const soap = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">${enviNFe}</nfeDadosMsg></soap:Body></soap:Envelope>`;

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
    // SEM ciphers customizados — Node 20+ default funciona em SEFAZ
  });

  // SP NFC-e — SOAP 1.2 com action embutido no Content-Type (asmx exige)
  const SOAP_ACTION =
    'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote';

  let xmlResposta = '';
  try {
    const resp = await postSefazWithRetry(endpoint, soap, {
      headers: {
        // SOAP 1.2 — SEM SOAPAction header separado (action vai no Content-Type)
        'Content-Type': `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"`,
        Accept: 'application/soap+xml, text/xml, */*',
        // ASP.NET asmx às vezes recusa requests sem User-Agent
        'User-Agent': 'LurdsOrderOne-NFCe/1.0',
      },
      httpsAgent: agent,
      timeout: 90000, // SEFAZ-SP às vezes leva 30-60s — 90s dá margem
      maxBodyLength: 10 * 1024 * 1024,
      // Não rejeitar erros 4xx — capturamos pra mostrar resposta da SEFAZ
      validateStatus: () => true,
    });

    xmlResposta = resp.data;

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
      xMotivo: friendlySefazError(e),
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

// ═══════════════════════════════════════════════════════════════════════
// 4. CANCELAMENTO NFC-e (evento 110111)
// ═══════════════════════════════════════════════════════════════════════

export interface CancelResult {
  success: boolean;
  cStat: string;
  xMotivo: string;
  nProtCancelamento?: string;
  dhRegEvento?: string;
  xmlEnviado: string;
  xmlResposta: string;
  error?: string;
}

/**
 * Assina XML de evento (infEvento). Diferente da NFe normal:
 * Reference URI aponta pra #ID do <infEvento>.
 */
function signXmlEvento(input: {
  xml: string;
  pfxBase64: string;
  pfxPassword: string;
}): string {
  const { privateKeyPem, certPem } = extractA1FromPfx(
    input.pfxBase64,
    input.pfxPassword,
  );

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
    xpath: "//*[local-name(.)='infEvento']",
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
  });

  sig.computeSignature(input.xml, {
    location: { reference: "//*[local-name(.)='evento']", action: 'append' },
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

/**
 * Cancela NFC-e via evento 110111. Funciona até 30min após autorização (NFC-e).
 *
 * @param input.chave - chave de 44 dígitos da NFC-e a cancelar
 * @param input.protocolo - protocolo de autorização original (nProt)
 * @param input.justificativa - texto 15-255 chars (obrigatório SEFAZ)
 */
export async function cancelNfceSefazSp(input: {
  chave: string;
  protocolo: string;
  justificativa: string;
  cnpj: string; // 14 dígitos
  ambiente: '1' | '2';
  pfxBase64: string;
  pfxPassword: string;
}): Promise<CancelResult> {
  // Validações de input
  const just = (input.justificativa || '').trim();
  if (just.length < 15 || just.length > 255) {
    return {
      success: false,
      cStat: '999',
      xMotivo: 'Justificativa precisa ter entre 15 e 255 caracteres',
      xmlEnviado: '',
      xmlResposta: '',
      error: 'Justificativa inválida',
    };
  }
  if (!input.chave || input.chave.length !== 44) {
    return {
      success: false,
      cStat: '999',
      xMotivo: 'Chave da NFC-e inválida (precisa ter 44 dígitos)',
      xmlEnviado: '',
      xmlResposta: '',
      error: 'Chave inválida',
    };
  }
  if (!input.protocolo) {
    return {
      success: false,
      cStat: '999',
      xMotivo: 'Protocolo de autorização original não informado',
      xmlEnviado: '',
      xmlResposta: '',
      error: 'Protocolo ausente',
    };
  }

  const cnpj = input.cnpj.replace(/\D/g, '').padStart(14, '0').slice(0, 14);
  const cOrgao = '35'; // SP
  const tpAmb = input.ambiente;
  const nSeqEvento = '1'; // primeira (e geralmente única) tentativa

  // dhEvento no mesmo formato do dhEmi (offset -03:00)
  const now = new Date();
  const local = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const dhEvento = local.toISOString().slice(0, 19) + '-03:00';

  // ID do evento: "ID" + tpEvento(6) + chNFe(44) + nSeqEvento(2 dígitos)
  const tpEvento = '110111';
  const idEvento = `ID${tpEvento}${input.chave}${nSeqEvento.padStart(2, '0')}`;

  // Escapa caracteres XML na justificativa
  const justEsc = just
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const eventoXml = `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><infEvento Id="${idEvento}"><cOrgao>${cOrgao}</cOrgao><tpAmb>${tpAmb}</tpAmb><CNPJ>${cnpj}</CNPJ><chNFe>${input.chave}</chNFe><dhEvento>${dhEvento}</dhEvento><tpEvento>${tpEvento}</tpEvento><nSeqEvento>${nSeqEvento}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${input.protocolo}</nProt><xJust>${justEsc}</xJust></detEvento></infEvento></evento>`;

  let eventoAssinado: string;
  try {
    eventoAssinado = signXmlEvento({
      xml: eventoXml,
      pfxBase64: input.pfxBase64,
      pfxPassword: input.pfxPassword,
    });
    eventoAssinado = eventoAssinado
      .replace(/^\u{FEFF}/u, '')
      .replace(/<\?xml[^?]*\?>\s*/g, '')
      .trim();
  } catch (e: any) {
    return {
      success: false,
      cStat: '999',
      xMotivo: `Erro ao assinar evento: ${e?.message}`,
      xmlEnviado: eventoXml,
      xmlResposta: '',
      error: e?.message,
    };
  }

  const idLote = String(Date.now()).slice(-15);
  const envEvento = `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>${idLote}</idLote>${eventoAssinado}</envEvento>`;

  const SOAP_ACTION =
    'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento';
  const soap = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">${envEvento}</nfeDadosMsg></soap:Body></soap:Envelope>`;

  const endpoint = (SEFAZ_SP_NFCE_ENDPOINTS[input.ambiente] as any).eventos
    || 'https://www.nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx';

  const { privateKeyPem, certPem } = extractA1FromPfx(
    input.pfxBase64,
    input.pfxPassword,
  );

  const https = require('https');
  const agent = new https.Agent({
    cert: certPem,
    key: privateKeyPem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  });

  let xmlResposta = '';
  try {
    const resp = await postSefazWithRetry(endpoint, soap, {
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"`,
        Accept: 'application/soap+xml, text/xml, */*',
        'User-Agent': 'LurdsOrderOne-NFCe/1.0',
      },
      httpsAgent: agent,
      timeout: 90000,
      validateStatus: () => true,
    });
    xmlResposta = resp.data;
    if (resp.status < 200 || resp.status >= 300) {
      return {
        success: false,
        cStat: '999',
        xMotivo: `SEFAZ retornou HTTP ${resp.status}`.trim(),
        xmlEnviado: envEvento,
        xmlResposta: xmlResposta || `(sem body)`,
        error: `HTTP ${resp.status}`,
      };
    }
  } catch (e: any) {
    return {
      success: false,
      cStat: '999',
      xMotivo: friendlySefazError(e),
      xmlEnviado: envEvento,
      xmlResposta: e?.response?.data ? String(e.response.data) : '',
      error: e?.message,
    };
  }

  // Parse retorno: cStat 135 = evento registrado e vinculado a NF-e (sucesso)
  // cStat 136 = evento registrado mas NAO vinculado (alguma divergencia, mas valido)
  // Outros = erro
  const retEvtMatch = xmlResposta.match(/<retEvento[\s\S]*?<\/retEvento>/);
  const retEvt = retEvtMatch?.[0] || xmlResposta;

  const cStat =
    (retEvt.match(/<cStat>([^<]+)<\/cStat>/) || [])[1] ||
    (xmlResposta.match(/<cStat>([^<]+)<\/cStat>/) || [])[1] ||
    '';
  const xMotivo =
    (retEvt.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] ||
    (xmlResposta.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] ||
    '';
  const nProtCancelamento =
    (retEvt.match(/<nProt>([^<]+)<\/nProt>/) || [])[1] || '';
  const dhRegEvento =
    (retEvt.match(/<dhRegEvento>([^<]+)<\/dhRegEvento>/) || [])[1] || '';

  return {
    success: cStat === '135' || cStat === '136',
    cStat,
    xMotivo,
    nProtCancelamento,
    dhRegEvento,
    xmlEnviado: envEvento,
    xmlResposta,
  };
}
