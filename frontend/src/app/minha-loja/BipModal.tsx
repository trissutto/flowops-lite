'use client';
import { overlayClose } from '@/lib/overlayClose';
import { refCorTam, nomeSemVariacao } from '@/lib/peca-linha';

/**
 * BipModal — tela de bipagem por código de barras (EAN13) pra finalizar separação.
 *
 * O BIPE É A BAIXA DE ESTOQUE (18/08). Cada peça bipada vai pro servidor na
 * hora (`POST /pick-orders/:id/scan`), que grava o bipe e tira a peça do
 * estoque na MESMA transação. A peça só fica verde aqui depois do 200 — se o
 * estoque não baixou, ela NÃO está bipada, e a atendente bipa de novo.
 *
 * Por que mudou: no pedido 960000006 (São José, 17/08) a atendente bipou 5 das
 * 11 peças e separou. O bipe vivia só neste navegador e o único gatilho de
 * baixa era o "Finalizar separação", que EXIGE 100% bipado — ela não conseguia
 * finalizar, a baixa nunca rodava, e as 5 peças já separadas continuavam
 * vendendo no balcão e no site.
 *
 * FLUXO:
 *  1. Abre quando separadora clica "Iniciar Bipagem" no card do pedido.
 *  2. GET /pick-orders/:id/scan-data → itens + EAN de cada um + OS BIPES JÁ
 *     REGISTRADOS (a separação continua de qualquer PC, não só neste).
 *  3. Input fica auto-focado pro leitor USB (scanner emula teclado + Enter).
 *  4. Cada bip: POST /scan → verde e conta; erro → vermelho, NÃO conta, e a
 *     mensagem FICA na tela até o próximo bipe (erro que some sozinho em 2,5s
 *     vira peça separada que ninguém registrou).
 *  5. "Desfazer último bip" → POST /scan-undo, que DEVOLVE a peça pro estoque.
 *  6. 100% bipado → "Finalizar separação" (que segue exigindo tudo bipado).
 *
 * QUEM MANDA NA CONTAGEM É O SERVIDOR. Sempre que ele recusa um bipe, ou o
 * total dele não bate com o daqui, a tela recarrega o /scan-data em vez de
 * teimar: a lista local pode estar ATRÁS (resposta perdida, outro PC no mesmo
 * pedido), e teimar trava o progresso abaixo de 100% com o "Finalizar" cinza.
 *
 * PERSISTÊNCIA: no BANCO, não mais no localStorage. A chave antiga
 * `flowops_scan_<id>` é apagada na abertura — ela sobrevivia a
 * report-issue/cancelamento e virava lixo permanente no navegador da loja.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { X, Check, AlertTriangle, Barcode, Send } from 'lucide-react';

interface ScanItem {
  id: string;
  sku: string;
  productName: string | null;
  /** REF · COR · TAM — confere a peça na mão antes de bipar. */
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  quantity: number;
  ean: string | null; // null = não achou EAN no ERP
  eanVariants?: string[]; // variantes tolerando zeros à esquerda/padding
}

interface ResolveDebugRow {
  sku: string;
  columnsChecked?: string[];
  row?: Record<string, any> | null;
  error?: string;
}

interface ResolveResponse {
  found: boolean;
  sku?: string;
  ean: string;
  source?: string;
  erpHit?: string | null;
  debug?: ResolveDebugRow[];
}

/** Peça que a loja reportou ("não achei") — saiu do card e espera a matriz. */
interface ItemReport {
  id: string;
  sku: string;
  productName: string | null;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  qtyMissing: number;
  reason: string;
  reasonLabel: string;
  stockDecreased: boolean;
}

interface ScanData {
  pickOrderId: string;
  status: string;
  items: ScanItem[];
  /** Bipes já registrados NO SERVIDOR (peças que já saíram do estoque). */
  scans?: Scan[];
  /** Peças reportadas neste card (ficam visíveis, apagadas, com o motivo). */
  reports?: ItemReport[];
}

const REPORT_REASONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'out_of_stock', label: 'Não achei a peça', hint: 'Procurou e ela não está na loja — sai do estoque pro site parar de vender' },
  { value: 'defective', label: 'Peça com defeito', hint: 'Existe mas não dá pra enviar — registre depois no fluxo de Defeitos' },
  { value: 'divergence', label: 'Divergência (cor/tamanho)', hint: 'A peça física não bate com o que o pedido diz' },
  { value: 'other', label: 'Outro', hint: 'Explique na observação (obrigatória)' },
];

interface Scan {
  /** Identidade da PEÇA bipada, gerada aqui antes do POST. É o que faz o
   *  reenvio do mesmo bipe não baixar estoque duas vezes. */
  scanUid: string;
  sku: string;
  ean: string;
  timestamp: string;
}

interface ScanResponse {
  ok: boolean;
  duplicate: boolean;
  scanUid: string;
  sku: string;
  ean: string | null;
  debitSkippedReason: string | null;
  scanned: Array<{ sku: string; count: number }>;
  totalScanned: number;
}

/** Mensagem do SERVIDOR, não o "400: {json}" cru. A atendente precisa ler
 *  "Já bipou 2 de 2 dessa peça", não um status HTTP. */
function msgErro(e: any): string {
  const doCorpo = e?.body?.message;
  if (Array.isArray(doCorpo) && doCorpo.length) return String(doCorpo[0]);
  if (typeof doCorpo === 'string' && doCorpo.trim()) return doCorpo;
  const cru = String(e?.message ?? '').replace(/^\d{3}:\s*/, '').trim();
  // 502/504 do proxy do Railway (o backend reinicia ~30s a cada deploy) vêm
  // como PÁGINA HTML, não JSON. Despejar a página na faixa de aviso não diz
  // nada pra quem está com a peça na mão.
  if (!cru || /^</.test(cru)) return 'o servidor não respondeu';
  return cru.length > 160 ? `${cru.slice(0, 160)}…` : cru;
}

/** A resposta se PERDEU (não sabemos se a peça baixou) × o servidor RECUSOU
 *  (regra de negócio, a peça não baixou). Rede sem resposta não tem `status`;
 *  5xx tem — mas 502/504 do restart de deploy é a mesma incerteza, e cair no
 *  ramo de "recusa" fazia a tela pintar de amarelo um bipe que pode ter saído
 *  do estoque. */
function semResposta(e: any): boolean {
  const s = e?.status;
  return s === undefined || s === null || Number(s) >= 500;
}

/** Motivo técnico da baixa pulada → português de loja. 'shadow'/'killswitch'
 *  são nomes de env; a atendente não tem o que fazer com eles. */
function motivoSemBaixa(r: string | null | undefined): string {
  if (r === 'shadow') return 'o sistema está em modo de teste';
  if (r === 'killswitch') return 'a baixa no bipe está desligada';
  return r ? String(r) : 'motivo não informado';
}

/** UUID por peça. `crypto.randomUUID` não existe em contexto inseguro (o app
 *  da loja roda em http://IP:3000 na LAN), então tem fallback. */
function novoScanUid(): string {
  try {
    const c: any = typeof crypto !== 'undefined' ? crypto : null;
    if (c?.randomUUID) return c.randomUUID();
  } catch {}
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface BipModalProps {
  pickOrderId: string;
  wcOrderNumber: string | null;
  customerName: string | null;
  onClose: () => void;
  onFinished: () => void; // chamado após POST finalizar com sucesso
}

export default function BipModal({
  pickOrderId,
  wcOrderNumber,
  customerName,
  onClose,
  onFinished,
}: BipModalProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ScanData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scans, setScans] = useState<Scan[]>([]);
  const [bipInput, setBipInput] = useState('');
  const [feedback, setFeedback] = useState<{
    type: 'ok' | 'warn' | 'err';
    msg: string;
    ts: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  /** Erro do "Finalizar separação". Mora separado do `err` (falha de carga)
   *  porque é mostrado NO RODAPÉ, colado no botão: o corpo do modal rola, e um
   *  erro no topo depois de um clique lá embaixo é erro que ninguém lê. */
  const [erroFinal, setErroFinal] = useState<string | null>(null);
  /** Item sendo reportado ("não achei") — abre o mini-modal de motivo. */
  const [reportCtx, setReportCtx] = useState<ScanItem | null>(null);
  const [reportReason, setReportReason] = useState<string>('out_of_stock');
  const [reportNote, setReportNote] = useState('');
  const [reportSending, setReportSending] = useState(false);
  const [reportErr, setReportErr] = useState<string | null>(null);
  // Espelho pro interval de refocus (montado UMA vez, closure vazia): com o
  // mini-modal aberto o roubo de foco mandaria a observação digitada pro campo
  // de bipe — e um Enter reflexo viraria "bipe" de texto solto.
  const reportCtxRef = useRef<ScanItem | null>(null);
  useEffect(() => { reportCtxRef.current = reportCtx; }, [reportCtx]);
  /** Bipes esperando resposta do servidor. A tela não pode ficar muda enquanto
   *  a peça está no ar: antes o bipe era instantâneo (localStorage) e agora é
   *  uma ida à rede — sem este contador a atendente bipa, não vê nada mudar e
   *  conclui que o leitor falhou. */
  const [naFila, setNaFila] = useState(0);
  const [debug, setDebug] = useState<ResolveResponse | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Espelho dos bipes pra ler dentro da fila (o callback enfileirado roda
  // depois do render que o criou — ler `scans` ali daria lista velha).
  const scansRef = useRef<Scan[]>([]);
  useEffect(() => { scansRef.current = scans; }, [scans]);

  // Carrega scan-data + os bipes JÁ REGISTRADOS no servidor
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api<ScanData>(`/pick-orders/${pickOrderId}/scan-data`);
        if (!alive) return;
        setData(res);
        const doServidor = Array.isArray(res.scans) ? res.scans : [];
        scansRef.current = doServidor;
        setScans(doServidor);
        // Lixo da era do localStorage: a chave sobrevivia a report-issue,
        // remoção pela matriz e cancelamento do pedido, e ficava pra sempre.
        try { localStorage.removeItem(`flowops_scan_${pickOrderId}`); } catch {}
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message ?? 'Erro ao carregar itens');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [pickOrderId]);

  /**
   * PUXA A VERDADE DO SERVIDOR quando a lista daqui pode ter ficado pra trás.
   *
   * Acontece de verdade: o POST chega, o estoque baixa e a RESPOSTA se perde
   * (a rede da loja cai — é a premissa deste trabalho). A tela mostra "não
   * bipou", a atendente bipa de novo, e o teto por SKU do servidor recusa com
   * "Já bipou 1 de 1 dessa peça" — numa peça que a tela exibe zerada. Sem
   * ressincronizar, o progresso trava abaixo de 100%, o "Finalizar" nunca
   * habilita e a separação morre exatamente como morreu no pedido 960000006.
   * Também cobre o outro PC bipando o mesmo pedido.
   */
  const ressincronizar = useCallback(async (): Promise<ScanData | null> => {
    try {
      const res = await api<ScanData>(`/pick-orders/${pickOrderId}/scan-data`);
      setData(res);
      const doServidor = Array.isArray(res.scans) ? res.scans : [];
      scansRef.current = doServidor;
      setScans(doServidor);
      return res;
    } catch {
      // Ressincronizar é conserto, não operação: se a rede ainda está fora, a
      // mensagem de erro do bipe já está na tela e é ela que vale.
      return null;
    }
  }, [pickOrderId]);

  // Mantém o input focado (se operadora clicar fora, volta o foco)
  useEffect(() => {
    const refocus = () => {
      // Mini-modal de reporte aberto = ela está DIGITANDO no textarea.
      if (reportCtxRef.current) return;
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus();
      }
    };
    const timer = setInterval(refocus, 500);
    return () => clearInterval(timer);
  }, []);

  // Auto-limpa SÓ o "deu certo", depois de 2.5s. Erro e aviso ficam na tela
  // até o próximo bipe: a atendente olha pra peça e pra arara, não pro monitor,
  // e um "NÃO BIPOU" que some sozinho em 2,5s vira peça separada que ninguém
  // registrou — o buraco que este trabalho existe pra fechar.
  useEffect(() => {
    if (!feedback || feedback.type !== 'ok') return;
    const t = setTimeout(() => setFeedback(null), 2500);
    return () => clearTimeout(t);
  }, [feedback?.ts, feedback?.type]); // eslint-disable-line

  // Mapas derivados: cada EAN (e o próprio SKU) + TODAS suas variantes de padding
  // apontam pro mesmo SKU — tolera divergência entre scanner e cadastro do ERP,
  // e também aceita scanner que imprime o próprio código interno do ERP como barcode.
  const eanToSku = useMemo(() => {
    const m = new Map<string, string>();
    const addEntry = (value: string | null | undefined, sku: string) => {
      if (!value) return;
      const s = String(value).trim();
      if (!s) return;
      m.set(s, sku);
      if (/^\d+$/.test(s)) {
        const stripped = s.replace(/^0+/, '');
        if (stripped) m.set(stripped, sku);
        m.set(s.padStart(13, '0'), sku);
        m.set(s.padStart(14, '0'), sku);
      }
    };
    if (data) {
      for (const it of data.items) {
        const variants = it.eanVariants && it.eanVariants.length ? it.eanVariants : it.ean ? [it.ean] : [];
        for (const v of variants) addEntry(v, it.sku);
        addEntry(it.ean, it.sku);
        addEntry(it.sku, it.sku); // bipar o próprio SKU funciona
      }
    }
    return m;
  }, [data]);

  const expectedBySku = useMemo(() => {
    const m = new Map<string, number>();
    if (data) {
      for (const it of data.items) {
        m.set(it.sku, (m.get(it.sku) ?? 0) + it.quantity);
      }
    }
    return m;
  }, [data]);

  const scannedBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scans) {
      m.set(s.sku, (m.get(s.sku) ?? 0) + 1);
    }
    return m;
  }, [scans]);

  const totalExpected = useMemo(
    () => Array.from(expectedBySku.values()).reduce((a, b) => a + b, 0),
    [expectedBySku],
  );
  const totalScanned = scans.length;
  const allDone = totalExpected > 0 && totalScanned >= totalExpected;

  /**
   * FILA DE UMA VIA. Cada bip agora é uma ida ao servidor, e o leitor USB
   * dispara muito mais rápido que a rede. Sem enfileirar, dois bipes voam
   * juntos e a tela mostra contagem de antes. Desabilitar o input resolveria a
   * corrida e criaria outra: o scanner é um teclado, e o que ele digita com o
   * campo desabilitado se perde — peça separada que ninguém registrou.
   */
  const filaRef = useRef<Promise<unknown>>(Promise.resolve());
  const enfileirar = useCallback((fn: () => Promise<void>) => {
    setNaFila((n) => n + 1);
    // O `catch` aqui não é enfeite: sem ele um erro inesperado no meio da fila
    // sumia no console do PC da loja e a peça ficava sem registro NENHUM na
    // tela — o pior desfecho possível, porque parece que nada aconteceu.
    const rodar = async () => {
      try {
        await fn();
      } catch (e: any) {
        setFeedback({ type: 'err', msg: `NÃO BIPOU — ${msgErro(e)}. Bipe a peça de novo.`, ts: Date.now() });
      } finally {
        setNaFila((n) => Math.max(0, n - 1));
      }
    };
    filaRef.current = filaRef.current.then(rodar, rodar);
    return filaRef.current;
  }, []);

  const beep = useCallback((type: 'ok' | 'err') => {
    // Som curto via Web Audio — não depende de arquivo
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = type === 'ok' ? 880 : 220;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (type === 'ok' ? 0.08 : 0.25));
    } catch {}
  }, []);

  /**
   * REGISTRA A PEÇA NO SERVIDOR — e é o servidor que baixa o estoque.
   *
   * A peça só entra na lista (fica verde, conta no progresso) depois do 200.
   * O TETO por SKU ("já bipou 2 de 2") também é decisão do servidor: aqui a
   * contagem pode estar velha, lá ela está travada na linha do pedido.
   *
   * Rede caiu: tenta UMA vez mais com o MESMO scanUid. Se o primeiro POST
   * tinha chegado e só a resposta se perdeu, o servidor responde
   * `duplicate: true` e a peça é contada uma vez só.
   *
   * Se as DUAS tentativas se perderem, ou se o servidor recusar, a tela
   * RESSINCRONIZA antes de dar o veredito: o que ela tem na mão pode estar
   * atrás do que já está gravado lá, e teimar nisso trava a separação em 10/11
   * com o "Finalizar" cinza pra sempre.
   */
  const acceptScanForSku = useCallback(
    async (sku: string, ean: string) => {
      const expected = expectedBySku.get(sku) ?? 0;
      if (expected === 0) {
        setFeedback({ type: 'err', msg: `SKU ${sku} não está na lista do pedido`, ts: Date.now() });
        beep('err');
        return;
      }

      const scanUid = novoScanUid();
      const enviar = () =>
        api<ScanResponse>(`/pick-orders/${pickOrderId}/scan`, {
          method: 'POST',
          body: JSON.stringify({ scanUid, sku, ean }),
        });

      let res: ScanResponse;
      try {
        res = await enviar();
      } catch (e: any) {
        if (semResposta(e)) {
          try {
            res = await enviar();
          } catch (e2: any) {
            // As DUAS tentativas se perderam: pode ser que a primeira tenha
            // chegado e baixado a peça. Quem sabe é o servidor — pergunta pra
            // ele antes de mandar a atendente bipar de novo, senão ela cai no
            // teto por SKU com a tela zerada e a separação não fecha nunca.
            const doServidor = await ressincronizar();
            const jaEntrou = scansRef.current.some((s) => s.sku === sku && s.scanUid === scanUid);
            if (jaEntrou) {
              setFeedback({ type: 'ok', msg: `✓ ${sku} — registrado (a resposta demorou)`, ts: Date.now() });
              beep('ok');
              return;
            }
            setFeedback({
              type: 'err',
              msg:
                doServidor === null
                  ? `NÃO BIPOU — ${msgErro(e2)}. Sem conexão com o servidor: espere voltar e bipe de novo.`
                  : `NÃO BIPOU — ${msgErro(e2)}. Bipe a peça de novo.`,
              ts: Date.now(),
            });
            beep('err');
            return;
          }
        } else {
          // 4xx do servidor: teto do SKU estourado, card já baixado, pedido com
          // problema reportado. A recusa é definitiva — mas a contagem daqui
          // pode ser justamente o que está errado, então recarrega do servidor
          // antes de deixar a tela discutindo com ele.
          setFeedback({ type: 'warn', msg: msgErro(e), ts: Date.now() });
          beep('err');
          await ressincronizar();
          return;
        }
      }

      // Atualiza o ref JUNTO com o state: o próximo item da fila lê o ref, e o
      // state só chega no render seguinte. Sem isso, dois "desfazer" seguidos
      // olhariam pro mesmo último bipe.
      const jaTem = scansRef.current.some((s) => s.scanUid === res.scanUid);
      if (!jaTem) {
        const next = [...scansRef.current, { scanUid: res.scanUid, sku, ean, timestamp: new Date().toISOString() }];
        scansRef.current = next;
        setScans(next);
      }
      const got = res.scanned?.find((s) => s.sku === sku)?.count ?? 0;
      setFeedback({
        type: res.debitSkippedReason ? 'warn' : 'ok',
        msg: res.debitSkippedReason
          ? `✓ ${sku} (${got}/${expected}) — peça contada, mas o estoque NÃO saiu agora: ${motivoSemBaixa(res.debitSkippedReason)}. Avise a matriz.`
          : `✓ ${sku} (${got}/${expected})`,
        ts: Date.now(),
      });
      beep('ok');

      // O servidor devolve o total DELE. Se não bate com o que a tela tem, a
      // tela está errada — e é ela que decide se o "Finalizar" habilita.
      if (typeof res.totalScanned === 'number' && res.totalScanned !== scansRef.current.length) {
        await ressincronizar();
      }
    },
    [expectedBySku, pickOrderId, beep, ressincronizar],
  );

  const handleBip = useCallback(
    async (rawEan: string) => {
      const ean = rawEan.trim();
      if (!ean || !data) return;

      // 1) Match direto no mapa local (inclui variantes de zeros à esquerda)
      let sku = eanToSku.get(ean);

      // 2) Match normalizado: sem zeros à esquerda e com padding 13/14
      if (!sku) {
        const stripped = ean.replace(/^0+/, '');
        sku = eanToSku.get(stripped);
        if (!sku && /^\d+$/.test(ean)) {
          sku = eanToSku.get(ean.padStart(13, '0')) || eanToSku.get(ean.padStart(14, '0'));
        }
      }

      if (sku) {
        await acceptScanForSku(sku, ean);
        return;
      }

      // 3) Fallback: pergunta pro backend se esse EAN bate com algum SKU do pedido
      //    no ERP (busca em TODAS as colunas + variantes). Se não bater, mostra debug.
      setResolving(true);
      try {
        const res = await api<ResolveResponse>(`/pick-orders/${pickOrderId}/scan-resolve`, {
          method: 'POST',
          body: JSON.stringify({ ean }),
        });
        if (res.found && res.sku) {
          await acceptScanForSku(res.sku, ean);
        } else {
          setFeedback({ type: 'err', msg: `EAN ${ean} não pertence a esse pedido`, ts: Date.now() });
          beep('err');
          setDebug(res);
        }
      } catch (e: any) {
        setFeedback({ type: 'err', msg: `Erro ao validar: ${e?.message ?? 'rede'}`, ts: Date.now() });
        beep('err');
      } finally {
        setResolving(false);
      }
    },
    [data, eanToSku, pickOrderId, acceptScanForSku, beep],
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const valor = bipInput.trim();
      if (valor) {
        // Entra na fila em vez de disparar solto: o campo continua livre pro
        // próximo bipe e nenhum se perde.
        enfileirar(() => handleBip(valor));
        setBipInput('');
      }
    }
  };

  /**
   * DESFAZ o último bipe — e o servidor DEVOLVE a peça pro estoque. Some da
   * lista só depois do 200: sumir aqui com a peça ainda baixada lá é
   * exatamente o descasamento que este trabalho existe pra matar.
   */
  const removeLast = () => {
    enfileirar(async () => {
      const ultimo = scansRef.current[scansRef.current.length - 1];
      if (!ultimo) return;
      setUndoing(true);
      try {
        await api(`/pick-orders/${pickOrderId}/scan-undo`, {
          method: 'POST',
          body: JSON.stringify({ scanUid: ultimo.scanUid }),
        });
        const next = scansRef.current.filter((s) => s.scanUid !== ultimo.scanUid);
        scansRef.current = next;
        setScans(next);
        setFeedback({ type: 'warn', msg: `Bipe desfeito — ${ultimo.sku} voltou pro estoque`, ts: Date.now() });
      } catch (e: any) {
        setFeedback({
          type: 'err',
          msg: `NÃO desfez — ${msgErro(e)}. A peça continua baixada do estoque.`,
          ts: Date.now(),
        });
        beep('err');
        // Pode ter desfeito e só a resposta ter se perdido: quem sabe é o
        // servidor. Sem isso a peça some da lista OU sobra nela, e nos dois
        // casos a tela mente sobre o estoque.
        await ressincronizar();
      } finally {
        setUndoing(false);
      }
    });
  };

  /**
   * REPORTA uma peça que não dá pra bipar ("não achei" / defeito): ela SAI
   * deste card (a matriz decide se manda de outra loja ou reembolsa) e, no
   * "não achei", a quantidade fantasma SAI do estoque — é ela que faz o site
   * continuar vendendo peça que não existe. Depois do 200 a tela
   * ressincroniza: o esperado encolhe e o "Finalizar" destrava com o resto.
   */
  const submitReport = async () => {
    if (!reportCtx || reportSending) return;
    if (reportReason === 'other' && reportNote.trim().length < 5) {
      setReportErr('Explique o motivo na observação (mínimo 5 letras).');
      return;
    }
    setReportSending(true);
    setReportErr(null);
    try {
      const res = await api<any>(`/pick-orders/${pickOrderId}/report-item`, {
        method: 'POST',
        body: JSON.stringify({
          orderItemId: reportCtx.id,
          reason: reportReason,
          note: reportNote.trim() || undefined,
        }),
      });
      setReportCtx(null);
      setReportNote('');
      setReportReason('out_of_stock');
      setFeedback({
        type: 'warn',
        msg: res?.stockDecreased
          ? 'Peça reportada — saiu do pedido E do estoque da loja. A matriz foi avisada.'
          : 'Peça reportada — saiu do pedido. A matriz foi avisada.',
        ts: Date.now(),
      });
      await ressincronizar();
    } catch (e: any) {
      // A recusa pode ser a tela estando atrás (peça bipada em outro PC), OU o
      // reporte pode ter ENTRADO e só a resposta se perdido (502 do deploy) —
      // recarrega e olha: se o item saiu da lista, o reporte valeu.
      const fresh = await ressincronizar();
      if (fresh && reportCtx && !fresh.items.some((i) => i.id === reportCtx.id)) {
        setReportCtx(null);
        setReportNote('');
        setReportReason('out_of_stock');
        setFeedback({
          type: 'warn',
          msg: 'Peça reportada (a resposta demorou) — saiu do pedido. A matriz foi avisada.',
          ts: Date.now(),
        });
      } else {
        setReportErr(msgErro(e));
      }
    } finally {
      setReportSending(false);
    }
  };

  const submit = async () => {
    if (!allDone || submitting || naFila > 0) return;
    setSubmitting(true);
    setErroFinal(null);
    try {
      // BIPE TARDIO (29/08): card que já passou do finish (separated/ready/
      // shipped) só precisava dos bipes — cada um já baixou o estoque no 200.
      // Chamar o finish aqui daria 400 ("essa separação já foi finalizada").
      if (data && data.status !== 'new' && data.status !== 'separating') {
        onFinished();
        return;
      }
      // O servidor conta pelos bipes que ele mesmo gravou; `scans` vai junto
      // só como fallback pros cards abertos antes deste deploy.
      await api(`/pick-orders/${pickOrderId}/finish-separation`, {
        method: 'POST',
        body: JSON.stringify({ scans }),
      });
      onFinished();
    } catch (e: any) {
      setErroFinal(`Não finalizou: ${msgErro(e)}`);
      // O finish é quem carimba a baixa que faltou e passa o card pra matriz.
      // Se ele recusou, a contagem daqui é suspeita — recarrega antes de ela
      // clicar de novo no mesmo botão.
      await ressincronizar();
    } finally {
      setSubmitting(false);
    }
  };

  // Render
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-2">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[95vh] flex flex-col">
        {/* Header */}
        <header className="p-4 border-b flex items-center justify-between bg-slate-50">
          <div>
            <div className="flex items-center gap-2">
              <Barcode className="w-6 h-6 text-brand" />
              <h2 className="text-xl font-bold">Bipagem — Pedido #{wcOrderNumber ?? '—'}</h2>
            </div>
            {customerName && (
              <div className="text-sm text-slate-600 mt-1">Cliente: {customerName}</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded"
            title="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="text-center py-12 text-slate-500">Carregando itens…</div>}

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded mb-3 flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div>{err}</div>
            </div>
          )}

          {data && !loading && (
            <>
              {/* Input do scanner — focado automaticamente */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-slate-500 uppercase mb-1">
                  Bipe o código de barras
                </label>
                <div className="relative">
                  <input
                    ref={inputRef}
                    type="text"
                    value={bipInput}
                    onChange={(e) => setBipInput(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    placeholder="Foque aqui e bipe a peça…"
                    autoFocus
                    /* NUNCA desabilitar: o scanner é um teclado, e o que ele
                       digita num campo morto se perde — peça separada que
                       ninguém registrou. Ordem e corrida são resolvidas pela
                       fila, não por travar a digitação. */
                    className="w-full text-lg font-mono px-4 py-3 border-2 border-brand rounded focus:outline-none focus:ring-2 focus:ring-brand-light"
                  />
                  {(resolving || naFila > 0) && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 animate-pulse">
                      {resolving ? 'validando…' : `enviando ${naFila}…`}
                    </span>
                  )}
                </div>
              </div>

              {/* Feedback visual */}
              {feedback && (
                <div
                  className={`px-3 py-3 rounded text-center font-semibold mb-4 text-lg ${
                    feedback.type === 'ok'
                      ? 'bg-emerald-100 text-emerald-800 border-2 border-emerald-400'
                      : feedback.type === 'warn'
                      ? 'bg-amber-100 text-amber-800 border-2 border-amber-400'
                      : 'bg-red-100 text-red-800 border-2 border-red-400'
                  }`}
                >
                  {feedback.msg}
                </div>
              )}

              {/* Progress */}
              <div className="mb-4">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-medium text-slate-700">
                    Progresso: {totalScanned} / {totalExpected}
                    {naFila > 0 && (
                      <span className="ml-2 text-amber-700 font-normal animate-pulse">
                        · {naFila} no ar (baixando estoque)
                      </span>
                    )}
                  </span>
                  <button
                    onClick={removeLast}
                    disabled={!scans.length || undoing}
                    title="Devolve a peça pro estoque da loja"
                    className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-30"
                  >
                    {undoing ? 'devolvendo…' : '← Desfazer último bip'}
                  </button>
                </div>
                <div className="w-full h-3 bg-slate-200 rounded overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      allDone ? 'bg-emerald-500' : 'bg-brand'
                    }`}
                    style={{
                      width: totalExpected
                        ? `${Math.min(100, (totalScanned / totalExpected) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
              </div>

              {/* Lista de itens */}
              <div className="space-y-2">
                {data.items.map((it) => {
                  const expected = it.quantity;
                  const got = scannedBySku.get(it.sku) ?? 0;
                  const done = got >= expected;
                  return (
                    <div
                      key={it.id}
                      className={`border rounded p-3 flex items-center justify-between ${
                        done ? 'bg-emerald-50 border-emerald-300' : 'bg-white'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs text-slate-500">{it.sku}</div>
                        {/* REF · COR TAM em cima, descrição embaixo — mesmo
                            formato do card da LIVE e da fila da /minha-loja. */}
                        {it.ref && <div className="font-medium text-slate-900">{refCorTam(it)}</div>}
                        <div className={`truncate ${it.ref ? 'text-xs text-slate-500' : 'font-medium text-slate-900'}`}>
                          {nomeSemVariacao(it.productName, it.cor, it.tamanho) || '(sem descrição)'}
                        </div>
                        {/* Só avisa se NEM EAN NEM SKU funcionam como barcode —
                            na prática quase nunca acontece (SKU sempre é variante). */}
                        {!it.ean && (!it.eanVariants || it.eanVariants.length === 0) && (
                          <div className="text-xs text-red-600 mt-1">
                            ⚠ Sem código cadastrado — avisa o admin
                          </div>
                        )}
                        {/* Válvula de escape POR PEÇA: sem ela, uma peça que
                            não existe fisicamente travava o pedido inteiro
                            (o Finalizar exige 100% bipado) e a única saída
                            era devolver o card TODO pra matriz. */}
                        {!done && (
                          <button
                            onClick={() => {
                              setReportCtx(it);
                              setReportReason('out_of_stock');
                              setReportNote('');
                              setReportErr(null);
                            }}
                            className="mt-1 text-xs text-red-600 hover:text-red-800 underline underline-offset-2"
                          >
                            Não achei essa peça — reportar
                          </button>
                        )}
                      </div>
                      <div className="ml-3 text-right flex-shrink-0">
                        <div className={`text-2xl font-bold ${done ? 'text-emerald-600' : 'text-slate-700'}`}>
                          {got}/{expected}
                        </div>
                        {done && (
                          <div className="text-xs text-emerald-600 flex items-center gap-1 justify-end">
                            <Check className="w-3 h-3" /> pronto
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Peças reportadas: ficam visíveis e apagadas em vez de sumir —
                  peça que some sem explicação vira "o sistema comeu". */}
              {(data.reports ?? []).length > 0 && (
                <div className="mt-4">
                  <div className="text-xs font-medium uppercase text-slate-400 mb-1">
                    Peças reportadas — fora deste pedido, com a matriz
                  </div>
                  <div className="space-y-2">
                    {(data.reports ?? []).map((r) => (
                      <div
                        key={r.id}
                        className="border border-dashed border-slate-300 rounded p-3 flex items-center justify-between bg-slate-50"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-xs text-slate-400">{r.sku}</div>
                          {r.ref && (
                            <div className="font-medium text-slate-500 line-through">{refCorTam(r)}</div>
                          )}
                          <div className="text-xs text-slate-500">
                            {r.reasonLabel} — matriz avisada
                            {r.stockDecreased ? ' · já saiu do estoque' : ''}
                          </div>
                        </div>
                        <div className="ml-3 text-right flex-shrink-0 text-sm font-semibold text-red-500">
                          {r.qtyMissing} un
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="p-4 border-t bg-slate-50">
          {/* Erro do finalizar fica AQUI, colado no botão que falhou: o corpo
              do modal rola, e um pedido de 11 peças empurra qualquer aviso do
              topo pra fora da vista de quem acabou de clicar embaixo. */}
          {erroFinal && (
            <div className="mb-2 bg-red-50 border border-red-300 text-red-800 px-3 py-2 rounded flex items-start gap-2 text-sm">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div>{erroFinal}</div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="flex-1 py-3 bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium rounded disabled:opacity-50"
            >
              Pausar (bips já registrados)
            </button>
            <button
              onClick={submit}
              /* Trava enquanto tem bipe no ar: o estoque da última peça ainda
                 está saindo, e finalizar em cima disso é a matriz recebendo um
                 card que o servidor ainda não terminou de fechar. */
              disabled={!allDone || submitting || naFila > 0}
              className={`flex-1 py-3 font-semibold rounded flex items-center justify-center gap-2 ${
                allDone && naFila === 0
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  : 'bg-slate-300 text-slate-500 cursor-not-allowed'
              }`}
            >
              <Send className="w-5 h-5" />
              {submitting ? 'Enviando...' : naFila > 0 ? 'aguarde o bipe…' : 'Finalizar separação'}
            </button>
          </div>
        </footer>
      </div>

      {/* Mini-modal do reporte por peça */}
      {reportCtx && (
        <div
          className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-3"
          {...overlayClose(() => { if (!reportSending) setReportCtx(null); })}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="p-4 border-b bg-red-50 flex items-center justify-between">
              <div className="flex items-center gap-2 text-red-700">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-bold">Reportar peça</h3>
              </div>
              <button
                onClick={() => { if (!reportSending) setReportCtx(null); }}
                className="p-2 hover:bg-red-100 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-3">
                <div className="font-mono text-xs text-slate-500">{reportCtx.sku}</div>
                <div className="font-semibold text-slate-900">
                  {reportCtx.ref ? refCorTam(reportCtx) : nomeSemVariacao(reportCtx.productName, reportCtx.cor, reportCtx.tamanho) || reportCtx.sku}
                </div>
              </div>
              <div className="space-y-2 mb-3">
                {REPORT_REASONS.map((r) => (
                  <label
                    key={r.value}
                    className={`block border rounded p-2 cursor-pointer ${
                      reportReason === r.value ? 'border-red-400 bg-red-50' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="report-reason"
                      className="sr-only"
                      checked={reportReason === r.value}
                      onChange={() => setReportReason(r.value)}
                    />
                    <div className="font-medium text-sm text-slate-800">{r.label}</div>
                    <div className="text-xs text-slate-500">{r.hint}</div>
                  </label>
                ))}
              </div>
              <textarea
                value={reportNote}
                onChange={(e) => setReportNote(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder={reportReason === 'other' ? 'Explique o que aconteceu (obrigatório)' : 'Observação (opcional)'}
                className="w-full border rounded p-2 text-sm mb-3"
              />
              <div className="text-xs text-slate-600 bg-amber-50 border border-amber-200 rounded p-2">
                A peça <strong>sai deste pedido</strong> e a matriz decide: mandar de outra
                loja ou devolver o dinheiro da cliente. Em <strong>“Não achei a peça”</strong>,
                ela também sai do estoque da loja — o site para de vender uma peça que não
                existe. O resto do pedido continua normal e o Finalizar destrava.
              </div>
              {reportErr && (
                <div role="alert" className="mt-3 bg-red-50 border border-red-300 text-red-800 px-3 py-2 rounded text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>{reportErr}</div>
                </div>
              )}
            </div>
            <footer className="p-3 border-t bg-slate-50 flex gap-2">
              <button
                onClick={() => setReportCtx(null)}
                disabled={reportSending}
                className="flex-1 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium rounded disabled:opacity-50"
              >
                Voltar
              </button>
              {/* Sempre clicável (menos durante o envio): botão morto sem
                  explicação é pior que o clique mostrar "explique o motivo". */}
              <button
                onClick={submitReport}
                disabled={reportSending}
                className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded disabled:opacity-50"
              >
                {reportSending ? 'Reportando…' : 'Reportar peça'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Modal de debug — só aparece quando o EAN bipado não bateu em nada */}
      {debug && !debug.found && (
        <div
          className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-3"
          {...overlayClose(() => setDebug(null))}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="p-4 border-b flex items-center justify-between bg-red-50">
              <div>
                <div className="flex items-center gap-2 text-red-700">
                  <AlertTriangle className="w-5 h-5" />
                  <h3 className="font-bold">EAN {debug.ean} não casa com o pedido</h3>
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  {debug.erpHit ? (
                    <>Esse EAN existe no Gigasistemas (SKU <strong>{debug.erpHit}</strong>) mas esse SKU NÃO está nesse pedido.</>
                  ) : (
                    <>Esse EAN não foi encontrado em nenhuma coluna da tabela produtos do Gigasistemas.</>
                  )}
                </div>
              </div>
              <button
                onClick={() => setDebug(null)}
                className="p-2 hover:bg-red-100 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto p-4 text-sm">
              <div className="text-xs font-medium uppercase text-slate-500 mb-2">
                Cadastro dos SKUs desse pedido no ERP
              </div>
              <div className="space-y-3">
                {(debug.debug ?? []).map((d, idx) => (
                  <div key={idx} className="border rounded p-2 bg-slate-50">
                    <div className="font-mono text-xs text-slate-700 mb-1">SKU: {d.sku}</div>
                    {d.row ? (
                      <table className="w-full text-xs">
                        <tbody>
                          {Object.entries(d.row).map(([k, v]) => (
                            <tr key={k} className="border-t border-slate-200">
                              <td className="py-1 pr-2 text-slate-500 font-medium">{k}</td>
                              <td className="py-1 font-mono">{v === null || v === '' ? <em className="text-slate-400">(vazio)</em> : String(v)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-xs text-red-600">SKU não encontrado na tabela produtos do Gigasistemas</div>
                    )}
                  </div>
                ))}
                {(!debug.debug || debug.debug.length === 0) && (
                  <div className="text-slate-500 text-xs">Sem SKUs pra comparar.</div>
                )}
              </div>
              <div className="mt-4 text-xs text-slate-600 bg-amber-50 border border-amber-200 rounded p-2">
                <strong>O que fazer:</strong> conferir se o EAN impresso na etiqueta é o mesmo
                que o Gigasistemas tem cadastrado pro SKU dessa peça. Se o cadastro estiver
                errado, corrigir no ERP. Se a etiqueta está com EAN de outro produto, separar
                a peça certa.
              </div>
            </div>
            <footer className="p-3 border-t bg-slate-50">
              <button
                onClick={() => setDebug(null)}
                className="w-full py-2 bg-slate-700 hover:bg-slate-800 text-white font-medium rounded"
              >
                Fechar e continuar
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
