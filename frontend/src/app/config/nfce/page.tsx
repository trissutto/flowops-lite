'use client';

/**
 * /retaguarda/nfce-config — admin
 *
 * MULTI-LOJA: cada loja tem seu CNPJ/IE/CSC/A1 próprios.
 * Tela mostra:
 *   - Grid de status de TODAS as lojas no topo (rosa=não config / verde=pronto)
 *   - Clica numa loja → abre formulário pra configurar AQUELA loja
 *   - Salva via POST /pdv/nfce/config { storeCode, ... }
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Save, Lock, Unlock, FileWarning, CheckCircle2, Upload,
  Eye, EyeOff, Store, Receipt, FlaskConical, ChevronDown, ChevronUp, XCircle, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';

type StatusItem = {
  storeCode: string;
  storeName: string;
  configured: boolean;
  ready: boolean;
  ambiente: string | null;
  cnpj: string | null;
  certificadoCarregado: boolean;
};

type ConfigState = {
  storeCode: string;
  storeName: string;
  ambiente: '1' | '2';
  uf: string;
  cnpj: string;
  razaoSocial: string;
  fantasia: string;
  ie: string;
  regime: '1' | '3';
  endereco: {
    logradouro: string;
    numero: string;
    bairro: string;
    cep: string;
    municipio: string;
    codMunicipio: string;
  };
  cscId: string;
  cscToken: string;
  serie: string;
  numeroAtual: number;
  certificadoCarregado: boolean;
  ready: boolean;
};

const EMPTY_CFG: ConfigState = {
  storeCode: '',
  storeName: '',
  ambiente: '2',
  uf: 'SP',
  cnpj: '',
  razaoSocial: '',
  fantasia: '',
  ie: '',
  regime: '1',
  endereco: {
    logradouro: '',
    numero: '',
    bairro: '',
    cep: '',
    municipio: '',
    codMunicipio: '',
  },
  cscId: '',
  cscToken: '',
  serie: '1',
  numeroAtual: 0,
  certificadoCarregado: false,
  ready: false,
};

export default function NfceConfigPage() {
  const [statusList, setStatusList] = useState<StatusItem[]>([]);
  const [selectedStore, setSelectedStore] = useState<string>('');
  const [cfg, setCfg] = useState<ConfigState>(EMPTY_CFG);
  const [loading, setLoading] = useState(true);
  const [loadingCfg, setLoadingCfg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Sensíveis: só envia se preenchido
  const [pfxBase64, setPfxBase64] = useState('');
  const [pfxPassword, setPfxPassword] = useState('');
  const [showPfxPwd, setShowPfxPwd] = useState(false);
  const [showCscToken, setShowCscToken] = useState(false);
  const [pfxFileName, setPfxFileName] = useState('');
  const [cscTokenChanged, setCscTokenChanged] = useState(false);

  // Teste de emissão
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [showXmlEnviado, setShowXmlEnviado] = useState(false);
  const [showXmlResposta, setShowXmlResposta] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api<StatusItem[]>('/pdv/nfce/status');
      setStatusList(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Falha ao listar lojas: ' + (e?.message || e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const loadCfg = useCallback(async (storeCode: string) => {
    setLoadingCfg(true);
    setMsg(null);
    setPfxBase64('');
    setPfxPassword('');
    setPfxFileName('');
    setCscTokenChanged(false);
    try {
      const data = await api<any>(`/pdv/nfce/config?storeCode=${storeCode}`);
      setCfg({
        ...EMPTY_CFG,
        ...data,
        endereco: data.endereco || EMPTY_CFG.endereco,
      });
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Falha ao ler config: ' + (e?.message || e) });
    } finally {
      setLoadingCfg(false);
    }
  }, []);

  function pickStore(storeCode: string) {
    setSelectedStore(storeCode);
    setTestResult(null);
    setShowXmlEnviado(false);
    setShowXmlResposta(false);
    loadCfg(storeCode);
  }

  async function testarEmissao() {
    if (!cfg.ready) return;
    setTesting(true);
    setTestResult(null);
    setMsg(null);
    try {
      const r = await api<any>(`/pdv/nfce/test/${cfg.storeCode}`, { method: 'POST' });
      setTestResult(r);
    } catch (e: any) {
      setTestResult({
        status: 'error',
        motivo: e?.message || String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const b64 = result.split(',')[1] || '';
      setPfxBase64(b64);
      setPfxFileName(file.name);
    };
    reader.readAsDataURL(file);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const body: any = {
        storeCode: cfg.storeCode,
        ambiente: cfg.ambiente,
        uf: cfg.uf,
        cnpj: cfg.cnpj,
        razaoSocial: cfg.razaoSocial,
        fantasia: cfg.fantasia,
        ie: cfg.ie,
        regime: cfg.regime,
        endereco: cfg.endereco,
        cscId: cfg.cscId,
        serie: cfg.serie,
      };
      if (cfg.numeroAtual > 0) body.numeroAtual = cfg.numeroAtual;
      if (cscTokenChanged && cfg.cscToken) body.cscToken = cfg.cscToken;
      if (pfxBase64) body.certPfxB64 = pfxBase64;
      if (pfxPassword) body.certPfxPass = pfxPassword;

      const updated = await api<any>('/pdv/nfce/config', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCfg({
        ...EMPTY_CFG,
        ...updated,
        endereco: updated.endereco || EMPTY_CFG.endereco,
      });
      setPfxBase64('');
      setPfxPassword('');
      setPfxFileName('');
      setCscTokenChanged(false);
      setMsg({ kind: 'ok', text: `Configuração da loja ${cfg.storeCode} salva ✓` });
      // Atualiza grid no topo
      loadStatus();
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Erro ao salvar: ' + (e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-rose-50 p-6 flex items-center justify-center">
        <div className="text-rose-700">Carregando lojas…</div>
      </div>
    );
  }

  const totalReady = statusList.filter((s) => s.ready).length;
  const totalConfigured = statusList.filter((s) => s.configured).length;

  return (
    <div className="min-h-screen bg-rose-50 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <Link
          href="/retaguarda"
          className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar
        </Link>

        <div className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold text-rose-900">
            NFC-e — Configuração por Loja
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Cada loja tem CNPJ/IE/CSC/A1 próprios. {totalReady} de {statusList.length} lojas
            prontas pra emitir · {totalConfigured} parcialmente configuradas.
          </p>
        </div>

        {/* GRID DE LOJAS */}
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-5">
          <h2 className="text-lg font-bold text-rose-900 mb-3">Selecione a loja</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {statusList.map((s) => (
              <button
                key={s.storeCode}
                onClick={() => pickStore(s.storeCode)}
                className={`p-3 rounded-xl border-2 text-left transition ${
                  selectedStore === s.storeCode
                    ? 'border-rose-600 bg-rose-100 shadow'
                    : s.ready
                    ? 'border-emerald-300 bg-emerald-50 hover:border-emerald-400'
                    : s.configured
                    ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
                    : 'border-gray-200 bg-white hover:border-gray-400'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <Store size={14} className="shrink-0 text-rose-700" />
                  <span className="text-xs font-mono font-bold">{s.storeCode}</span>
                  {s.ready ? (
                    <CheckCircle2 size={14} className="text-emerald-600 ml-auto" />
                  ) : s.configured ? (
                    <FileWarning size={14} className="text-amber-600 ml-auto" />
                  ) : (
                    <Lock size={14} className="text-gray-400 ml-auto" />
                  )}
                </div>
                <div className="text-xs font-semibold text-gray-800 truncate">
                  {s.storeName}
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {s.ready
                    ? `Pronto · ${s.ambiente === '1' ? 'PROD' : 'HOMOLOG'}`
                    : s.configured
                    ? 'Faltam dados'
                    : 'Não configurado'}
                </div>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-3">
            <span className="flex items-center gap-1">
              <CheckCircle2 size={12} className="text-emerald-600" /> Pronta
            </span>
            <span className="flex items-center gap-1">
              <FileWarning size={12} className="text-amber-600" /> Parcial
            </span>
            <span className="flex items-center gap-1">
              <Lock size={12} className="text-gray-400" /> Não configurada
            </span>
          </div>
        </div>

        {!selectedStore && (
          <div className="bg-white rounded-2xl shadow-sm p-12 text-center">
            <Receipt size={48} className="mx-auto mb-3 text-rose-300" />
            <p className="text-gray-600">Clique numa loja acima pra configurar.</p>
          </div>
        )}

        {selectedStore && loadingCfg && (
          <div className="bg-white rounded-2xl shadow-sm p-12 text-center">
            <p className="text-rose-700">Carregando config da loja {selectedStore}…</p>
          </div>
        )}

        {selectedStore && !loadingCfg && (
          <>
            <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
              <div>
                <h2 className="text-xl font-bold text-rose-900">
                  Loja {cfg.storeCode} · {cfg.storeName}
                </h2>
              </div>
              <StatusBadge ready={cfg.ready} ambiente={cfg.ambiente} />
            </div>

            {msg && (
              <div
                className={`mb-4 rounded-lg p-3 text-sm font-medium ${
                  msg.kind === 'ok'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                {msg.text}
              </div>
            )}

            <div className="space-y-5">
              <Card title="Ambiente" subtitle="Homologação = teste · Produção = emite com valor fiscal">
                <div className="grid grid-cols-2 gap-3">
                  <RadioBox
                    checked={cfg.ambiente === '2'}
                    onChange={() => setCfg({ ...cfg, ambiente: '2' })}
                    title="HOMOLOGAÇÃO"
                    sub="Testes — sem valor fiscal"
                    color="amber"
                  />
                  <RadioBox
                    checked={cfg.ambiente === '1'}
                    onChange={() => setCfg({ ...cfg, ambiente: '1' })}
                    title="PRODUÇÃO"
                    sub="Emissão real SEFAZ"
                    color="rose"
                  />
                </div>
              </Card>

              <Card title="Identificação da Empresa">
                <Field label="CNPJ" value={cfg.cnpj} onChange={(v) => setCfg({ ...cfg, cnpj: v })} placeholder="00.000.000/0001-00" />
                <Field label="Razão Social" value={cfg.razaoSocial} onChange={(v) => setCfg({ ...cfg, razaoSocial: v })} />
                <Field label="Nome Fantasia" value={cfg.fantasia} onChange={(v) => setCfg({ ...cfg, fantasia: v })} />
                <Field label="Inscrição Estadual" value={cfg.ie} onChange={(v) => setCfg({ ...cfg, ie: v })} />
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                    Regime Tributário
                  </label>
                  <select
                    value={cfg.regime}
                    onChange={(e) => setCfg({ ...cfg, regime: e.target.value as '1' | '3' })}
                    className="w-full p-2.5 border rounded-lg"
                  >
                    <option value="1">1 — Simples Nacional</option>
                    <option value="3">3 — Regime Normal</option>
                  </select>
                </div>
              </Card>

              <Card title="Endereço do Estabelecimento">
                <Field label="Logradouro" value={cfg.endereco.logradouro} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, logradouro: v } })} />
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <Field label="Número" value={cfg.endereco.numero} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, numero: v } })} />
                  <Field label="Bairro" value={cfg.endereco.bairro} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, bairro: v } })} />
                  <Field label="CEP" value={cfg.endereco.cep} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, cep: v } })} placeholder="00000-000" />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <Field label="Município" value={cfg.endereco.municipio} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, municipio: v } })} />
                  <Field label="UF" value={cfg.uf} onChange={(v) => setCfg({ ...cfg, uf: v })} placeholder="SP" />
                  <Field label="Cód. Município IBGE" value={cfg.endereco.codMunicipio} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, codMunicipio: v } })} placeholder="3550308" />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Códigos IBGE comuns: SP capital 3550308 · Itanhaém 3523107 · Santos 3548500 ·{' '}
                  <a
                    href="https://www.ibge.gov.br/explica/codigos-dos-municipios.php"
                    target="_blank"
                    rel="noopener"
                    className="text-rose-700 underline"
                  >
                    consultar IBGE
                  </a>
                </p>
              </Card>

              <Card
                title="CSC — Código de Segurança do Contribuinte"
                subtitle="Token + ID do CSC fornecidos pelo Posto Fiscal SEFAZ-SP. Cada CNPJ tem seu CSC próprio."
              >
                <Field label="ID do CSC" value={cfg.cscId} onChange={(v) => setCfg({ ...cfg, cscId: v })} placeholder="1, 2, ..." />
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                    Token CSC
                  </label>
                  <div className="relative">
                    <input
                      type={showCscToken ? 'text' : 'password'}
                      value={cfg.cscToken}
                      onChange={(e) => {
                        setCfg({ ...cfg, cscToken: e.target.value });
                        setCscTokenChanged(true);
                      }}
                      placeholder={cfg.cscToken === '••••••••' ? '(já cadastrado — preencha pra trocar)' : ''}
                      className="w-full p-2.5 pr-10 border rounded-lg font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCscToken((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
                    >
                      {showCscToken ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              </Card>

              <Card title="Numeração">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Série" value={cfg.serie} onChange={(v) => setCfg({ ...cfg, serie: v })} placeholder="1" />
                  <div>
                    <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                      Próximo número
                    </label>
                    <input
                      type="number"
                      value={cfg.numeroAtual}
                      onChange={(e) => setCfg({ ...cfg, numeroAtual: parseInt(e.target.value, 10) || 0 })}
                      className="w-full p-2.5 border rounded-lg font-mono"
                    />
                  </div>
                </div>
              </Card>

              <Card
                title="Certificado Digital A1 (.pfx)"
                subtitle="Cada CNPJ tem seu A1. Geralmente o A1 da matriz cobre as filiais (verifique com sua AC)."
              >
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 text-xs text-amber-900">
                  <FileWarning size={14} className="inline mr-1" />
                  <strong>Importante:</strong> .pfx criptografado no banco. Se trocar de servidor,
                  precisa fazer upload de novo.
                </div>

                <div className="mb-3">
                  <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                    Status atual
                  </label>
                  <div
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold ${
                      cfg.certificadoCarregado
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-gray-200 text-gray-700'
                    }`}
                  >
                    {cfg.certificadoCarregado ? (
                      <>
                        <CheckCircle2 size={14} /> Certificado carregado
                      </>
                    ) : (
                      <>
                        <Lock size={14} /> Nenhum certificado
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                    Carregar/Trocar arquivo .pfx
                  </label>
                  <label className="flex items-center gap-2 p-3 border-2 border-dashed border-rose-300 rounded-lg cursor-pointer hover:bg-rose-50 transition">
                    <Upload size={18} className="text-rose-600" />
                    <span className="text-sm">
                      {pfxFileName ? (
                        <span className="font-mono">{pfxFileName}</span>
                      ) : (
                        'Clique pra selecionar o .pfx'
                      )}
                    </span>
                    <input
                      type="file"
                      accept=".pfx,.p12,application/x-pkcs12"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFile(f);
                      }}
                    />
                  </label>
                </div>

                <div className="mt-3">
                  <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                    Senha do .pfx
                  </label>
                  <div className="relative">
                    <input
                      type={showPfxPwd ? 'text' : 'password'}
                      value={pfxPassword}
                      onChange={(e) => setPfxPassword(e.target.value)}
                      placeholder={cfg.certificadoCarregado ? '(preencha pra trocar)' : 'Senha A1'}
                      className="w-full p-2.5 pr-10 border rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPfxPwd((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
                    >
                      {showPfxPwd ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              </Card>

              {/* CARD DE TESTE DE EMISSÃO */}
              <Card
                title="🧪 Testar Emissão NFC-e"
                subtitle="Emite uma NFC-e fictícia (R$ 1,00) pra validar config + certificado + transmissão SEFAZ. Não afeta vendas reais."
              >
                {!cfg.ready && (
                  <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-900">
                    <FileWarning size={14} className="inline mr-1" />
                    Salve a configuração completa antes de testar (CNPJ, IE, CSC, certificado A1).
                  </div>
                )}

                <button
                  onClick={testarEmissao}
                  disabled={!cfg.ready || testing}
                  className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition"
                >
                  <FlaskConical size={18} />
                  {testing ? 'Transmitindo SEFAZ…' : 'Testar Emissão Agora'}
                </button>

                {testResult && (
                  <div className="mt-4 space-y-3">
                    {/* STATUS PRINCIPAL */}
                    <div
                      className={`rounded-xl p-4 border-2 ${
                        testResult.status === 'authorized'
                          ? 'bg-emerald-50 border-emerald-400'
                          : testResult.status === 'rejected'
                          ? 'bg-red-50 border-red-400'
                          : 'bg-amber-50 border-amber-400'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {testResult.status === 'authorized' ? (
                          <CheckCircle2 size={28} className="text-emerald-600 shrink-0" />
                        ) : testResult.status === 'rejected' ? (
                          <XCircle size={28} className="text-red-600 shrink-0" />
                        ) : (
                          <AlertTriangle size={28} className="text-amber-600 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div
                            className={`font-bold text-lg ${
                              testResult.status === 'authorized'
                                ? 'text-emerald-900'
                                : testResult.status === 'rejected'
                                ? 'text-red-900'
                                : 'text-amber-900'
                            }`}
                          >
                            {testResult.status === 'authorized'
                              ? '✓ NFC-e AUTORIZADA'
                              : testResult.status === 'rejected'
                              ? '✗ REJEITADA pela SEFAZ'
                              : '⚠ Erro técnico'}
                          </div>
                          {testResult.cStat && (
                            <div className="text-xs font-mono mt-1">
                              cStat: <strong>{testResult.cStat}</strong>
                            </div>
                          )}
                          {testResult.motivo && (
                            <div className="text-sm mt-1 text-gray-800 break-words">
                              {testResult.motivo}
                            </div>
                          )}
                          {testResult.protocolo && (
                            <div className="text-xs font-mono mt-1 text-gray-700">
                              Protocolo: <strong>{testResult.protocolo}</strong>
                            </div>
                          )}
                          {testResult.chave && (
                            <div className="text-xs font-mono mt-1 text-gray-700 break-all">
                              Chave: {testResult.chave}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* QR CODE */}
                    {testResult.qrUrl && (
                      <div className="bg-white border rounded-xl p-3">
                        <div className="text-xs font-bold text-gray-700 mb-2 uppercase">
                          QR Code da NFC-e
                        </div>
                        <div className="flex flex-col md:flex-row gap-3 items-start">
                          <img
                            src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(testResult.qrUrl)}`}
                            alt="QR NFC-e"
                            className="border rounded shrink-0"
                          />
                          <div className="text-xs text-gray-600 break-all flex-1 min-w-0">
                            <div className="font-mono">{testResult.qrUrl}</div>
                            {testResult.urlConsulta && (
                              <div className="mt-2">
                                <a
                                  href={testResult.urlConsulta}
                                  target="_blank"
                                  rel="noopener"
                                  className="text-rose-700 underline"
                                >
                                  Consultar na SEFAZ →
                                </a>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* XML ENVIADO */}
                    {testResult.xmlEnviado && (
                      <div className="bg-gray-50 border rounded-xl">
                        <button
                          onClick={() => setShowXmlEnviado((s) => !s)}
                          className="w-full p-3 flex items-center justify-between text-sm font-bold text-gray-700 hover:bg-gray-100"
                        >
                          <span>XML enviado</span>
                          {showXmlEnviado ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                        {showXmlEnviado && (
                          <pre className="text-[10px] font-mono p-3 border-t bg-white overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                            {testResult.xmlEnviado}
                          </pre>
                        )}
                      </div>
                    )}

                    {/* RESPOSTA SEFAZ */}
                    {testResult.xmlResposta && (
                      <div className="bg-gray-50 border rounded-xl">
                        <button
                          onClick={() => setShowXmlResposta((s) => !s)}
                          className="w-full p-3 flex items-center justify-between text-sm font-bold text-gray-700 hover:bg-gray-100"
                        >
                          <span>Resposta SEFAZ</span>
                          {showXmlResposta ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                        {showXmlResposta && (
                          <pre className="text-[10px] font-mono p-3 border-t bg-white overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                            {testResult.xmlResposta}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>

              <div className="sticky bottom-3 bg-white shadow-lg rounded-2xl p-4 flex items-center justify-between gap-4">
                <div className="text-xs text-gray-600">
                  {cfg.ready ? (
                    <span className="text-emerald-700 font-bold">
                      <CheckCircle2 size={14} className="inline mr-1" />
                      Pronto pra emitir
                    </span>
                  ) : (
                    <span className="text-amber-700 font-bold">
                      <FileWarning size={14} className="inline mr-1" />
                      Faltam: CNPJ, IE, CSC e/ou certificado
                    </span>
                  )}
                </div>
                <button
                  onClick={save}
                  disabled={saving}
                  className="bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2"
                >
                  <Save size={18} />
                  {saving ? 'Salvando…' : `Salvar ${cfg.storeCode}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Subcomponentes ────────────────────────────────────────────────────

function StatusBadge({ ready, ambiente }: { ready: boolean; ambiente: string }) {
  if (!ready) {
    return (
      <div className="flex items-center gap-2 bg-gray-200 text-gray-800 px-3 py-1.5 rounded-full font-bold text-sm">
        <Lock size={14} /> NÃO CONFIGURADO
      </div>
    );
  }
  if (ambiente === '1') {
    return (
      <div className="flex items-center gap-2 bg-emerald-100 text-emerald-800 px-3 py-1.5 rounded-full font-bold text-sm">
        <Unlock size={14} /> PRODUÇÃO
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-amber-100 text-amber-800 px-3 py-1.5 rounded-full font-bold text-sm">
      <Unlock size={14} /> HOMOLOGAÇÃO
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-lg font-bold text-rose-900 mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mb-3">{subtitle}</p>}
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">{label}</label>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full p-2.5 border rounded-lg"
      />
    </div>
  );
}

function RadioBox({ checked, onChange, title, sub, color }: { checked: boolean; onChange: () => void; title: string; sub: string; color: 'amber' | 'rose' }) {
  const activeClass =
    color === 'amber'
      ? 'bg-amber-100 border-amber-400 text-amber-900'
      : 'bg-rose-100 border-rose-400 text-rose-900';
  return (
    <button
      type="button"
      onClick={onChange}
      className={`p-3 rounded-xl border-2 text-left transition ${
        checked ? activeClass + ' shadow' : 'bg-white border-gray-200 text-gray-700 hover:border-gray-400'
      }`}
    >
      <div className="font-bold text-sm">{title}</div>
      <div className={`text-xs mt-1 ${checked ? '' : 'text-gray-500'}`}>{sub}</div>
    </button>
  );
}
