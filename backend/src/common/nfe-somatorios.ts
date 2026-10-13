/**
 * SOMATÓRIOS DA NF-e — a mesma conta que a SEFAZ faz (regras W03-10 e
 * vizinhas do MOC): cada total do <ICMSTot> tem que ser a soma do campo
 * correspondente nos <det>.
 *
 * Por que isso existe (13/10/2026): a NF-e 214 de Suzano (M. D. D. Cerqueira,
 * CRT 1, três itens CSOSN 102, vBC total 0,00) levou **531 "Total da BC ICMS
 * difere do somatório dos itens"** — e o XML era igual, campo a campo, a
 * dezenas de notas de 1 a 5 itens autorizadas no MESMO dia, antes e depois.
 * A diferença estava na resposta: a 214 foi validada por **SP_NFE_PL_008i2**,
 * um aplicativo mais velho no pool da SEFAZ-SP; todas as autorizadas passaram
 * pelo **SP_NFE_PL009_V4**. Rejeição não consome numeração, então a cura é
 * reenviar — mas o emissor parava na primeira rejeição e a matriz não tinha
 * porta pra reemitir (só a loja, clicando "Reimprimir etiqueta").
 *
 * Esta régua responde UMA pergunta: "a rejeição de somatório que a SEFAZ
 * devolveu é desmentida pelo próprio XML?". Se as somas batem, a culpa não é
 * do XML e vale UMA retentativa (mesmo número, cNF novo). Se não batem, a
 * rejeição é honesta e o erro tem que SUBIR como sempre — nunca mascarar.
 *
 * Pura: só regex sobre o XML. Sem Prisma, sem SEFAZ.
 */

export interface ConferenciaSomatorios {
  ok: boolean;
  /** `campo: itens=X total=Y` pra cada total que não bate. */
  divergencias: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Primeiro `<tag>` DIRETO dentro do bloco (regex exata — `vBC` não casa `vBCST`). */
function num(bloco: string, tag: string): number | null {
  const m = bloco.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function bloco(xml: string, tag: string): string {
  return (xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`)) || [''])[0];
}

/**
 * Rejeições da família "difere do somatório dos itens" (MOC, Anexo I). Só
 * elas entram na régua — 539 (duplicidade) e 225 (schema), por exemplo, NÃO
 * são de soma e nunca viram retentativa por aqui.
 */
export const REJEICOES_DE_SOMATORIO: ReadonlySet<string> = new Set([
  '531', // Total da BC ICMS
  '532', // Total do ICMS
  '533', // Total da BC ICMS-ST
  '534', // Total do ICMS-ST
  '535', // Total do Frete
  '536', // Total do Seguro
  '537', // Total do Desconto
  '538', // Total do IPI
  '601', // Total do II
  '602', // Total do PIS (itens sujeitos ao ICMS)
  '603', // Total do COFINS (itens sujeitos ao ICMS)
  '604', // Total do vOutro
  '610', // Total da NF difere do somatório dos vProd
]);

/**
 * Confere os totais do <ICMSTot> (e do <IBSCBSTot>, quando existe) contra a
 * soma dos itens. `ok=false` também quando o XML não tem <det>/<ICMSTot> —
 * XML que não dá pra conferir não ganha retentativa.
 */
export function conferirSomatoriosNfe(xml: string): ConferenciaSomatorios {
  const dets = xml.match(/<det nItem="\d+">[\s\S]*?<\/det>/g) || [];
  const tot = bloco(xml, 'ICMSTot');
  if (!dets.length || !tot) return { ok: false, divergencias: ['XML sem <det> ou sem <ICMSTot>'] };

  const soma = {
    vBC: 0, vICMS: 0, vBCST: 0, vST: 0, vProd: 0, vDesc: 0, vFrete: 0, vSeg: 0, vOutro: 0,
    vII: 0, vIPI: 0, vPIS: 0, vCOFINS: 0, vFCPUFDest: 0, vICMSUFDest: 0, vBCIBSCBS: 0,
  };
  for (const det of dets) {
    const prod = bloco(det, 'prod');
    const icms = bloco(det, 'ICMS');
    // indTot=0 é item que NÃO compõe o total da nota (regra W07-10).
    if (num(prod, 'indTot') !== 0) soma.vProd += num(prod, 'vProd') || 0;
    soma.vDesc += num(prod, 'vDesc') || 0;
    soma.vFrete += num(prod, 'vFrete') || 0;
    soma.vSeg += num(prod, 'vSeg') || 0;
    soma.vOutro += num(prod, 'vOutro') || 0;
    // Base e valor "normais" do ICMS: só os grupos que têm <vBC>/<vICMS>
    // (00/10/20/51/70/90, Part, SN900). CSOSN 102, CST 40/60… não têm — somam 0.
    soma.vBC += num(icms, 'vBC') || 0;
    soma.vICMS += num(icms, 'vICMS') || 0;
    soma.vBCST += num(icms, 'vBCST') || 0;
    soma.vST += num(icms, 'vICMSST') || 0;
    soma.vII += num(bloco(det, 'II'), 'vII') || 0;
    soma.vIPI += num(bloco(det, 'IPI'), 'vIPI') || 0;
    soma.vPIS += num(bloco(det, 'PIS'), 'vPIS') || 0;
    soma.vCOFINS += num(bloco(det, 'COFINS'), 'vCOFINS') || 0;
    const ufDest = bloco(det, 'ICMSUFDest');
    soma.vFCPUFDest += num(ufDest, 'vFCPUFDest') || 0;
    soma.vICMSUFDest += num(ufDest, 'vICMSUFDest') || 0;
    soma.vBCIBSCBS += num(bloco(det, 'gIBSCBS'), 'vBC') || 0;
  }

  const divergencias: string[] = [];
  const confere = (campo: keyof typeof soma, totalTag: string, blocoTotal = tot, obrigatorio = true) => {
    const total = num(blocoTotal, totalTag);
    if (total === null) {
      if (obrigatorio) divergencias.push(`${totalTag}: ausente no total`);
      return;
    }
    if (r2(soma[campo]) !== r2(total)) divergencias.push(`${totalTag}: itens=${r2(soma[campo]).toFixed(2)} total=${r2(total).toFixed(2)}`);
  };
  confere('vBC', 'vBC');
  confere('vICMS', 'vICMS');
  confere('vBCST', 'vBCST');
  confere('vST', 'vST');
  confere('vProd', 'vProd');
  confere('vDesc', 'vDesc');
  confere('vFrete', 'vFrete');
  confere('vSeg', 'vSeg');
  confere('vOutro', 'vOutro');
  confere('vII', 'vII');
  confere('vIPI', 'vIPI');
  confere('vPIS', 'vPIS');
  confere('vCOFINS', 'vCOFINS');
  // DIFAL só existe no total quando há partilha — opcionais.
  confere('vFCPUFDest', 'vFCPUFDest', tot, false);
  confere('vICMSUFDest', 'vICMSUFDest', tot, false);

  // vNF (regra W16-10): mercadoria − desconto − desonerado + ST + FCP-ST +
  // frete + seguro + outras + II + IPI + IPI devolvido.
  const t = (tag: string) => num(tot, tag) || 0;
  const vNFEsperado = r2(
    t('vProd') - t('vDesc') - t('vICMSDeson') + t('vST') + t('vFCPST') + t('vFrete') + t('vSeg') + t('vOutro') + t('vII') + t('vIPI') + t('vIPIDevol'),
  );
  const vNF = num(tot, 'vNF');
  if (vNF === null) divergencias.push('vNF: ausente no total');
  else if (r2(vNF) !== vNFEsperado) divergencias.push(`vNF: conta=${vNFEsperado.toFixed(2)} total=${r2(vNF).toFixed(2)}`);

  const ibTot = bloco(xml, 'IBSCBSTot');
  if (ibTot) confere('vBCIBSCBS', 'vBCIBSCBS', ibTot);

  return { ok: divergencias.length === 0, divergencias };
}

/**
 * A SEFAZ devolveu uma rejeição de somatório que o PRÓPRIO XML desmente?
 * Verdadeiro só quando o cStat é da família de soma E todas as somas batem.
 */
export function rejeicaoDeSomatorioContraditoria(cStat: unknown, xml: string): boolean {
  if (!REJEICOES_DE_SOMATORIO.has(String(cStat ?? '').trim())) return false;
  return conferirSomatoriosNfe(xml).ok;
}

/**
 * Os <verAplic> da resposta da SEFAZ, na ordem (lote, protocolo). É o que
 * diz QUAL aplicativo validou — foi assim que a 214 apareceu num PL_008i2.
 */
export function verAplicDaResposta(xmlResposta: unknown): string[] {
  return (String(xmlResposta ?? '').match(/<verAplic>([^<]*)<\/verAplic>/g) || [])
    .map((s) => s.replace(/<\/?verAplic>/g, '').trim())
    .filter(Boolean);
}
