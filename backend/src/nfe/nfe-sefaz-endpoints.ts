/**
 * Endpoints SEFAZ-SP NF-e modelo 55 (Layout 4.00).
 *
 * Diferente da NFC-e (nfce.fazenda.sp.gov.br): a NF-e usa nfe.fazenda.sp.gov.br.
 * O SOAPAction e o wsdl (NFeAutorizacao4 etc.) são os mesmos — só muda o host.
 */
export const SEFAZ_SP_NFE_ENDPOINTS = {
  '1': {
    // produção
    autorizacao: 'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
    retAutorizacao: 'https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
    consultaProtocolo: 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
    statusServico: 'https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
    eventos: 'https://nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
    inutilizacao: 'https://nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
  },
  '2': {
    // homologação
    autorizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
    retAutorizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
    consultaProtocolo:
      'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
    statusServico: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
    eventos: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
    inutilizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
  },
} as const;

/** Frase obrigatória de homologação (SEFAZ rejeita dest/xProd sem ela em tpAmb=2). */
export const HOMOLOG_FRASE =
  'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
