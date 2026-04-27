'use client';

/**
 * /retaguarda/nfce-config — admin
 *
 * Configuração da emissão de NFC-e (modelo 65) pelo PDV próprio.
 *
 * Campos:
 *  - Ambiente (homologação / produção)
 *  - Identificação (CNPJ, IE, Razão Social, Fantasia, Regime Tributário)
 *  - Endereço (LGR, NRO, BAIRRO, CEP, MUN, UF, COD MUNICIPIO IBGE)
 *  - CSC (idCSC + token CSC do contribuinte SEFAZ)
 *  - Série + número atual (controle interno do PDV)
 *  - Certificado A1 (.pfx) em base64 + senha
 *
 * Quando todos os campos críticos estão preenchidos, o badge muda pra
 * "PRONTO PRA EMITIR". Sem CSC/cert, fica em modo "PREVIEW" (gera XML +
 * chave válida mas não transmite SEFAZ).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Save, Lock, Unlock, FileWarning, CheckCircle2, Upload, Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';

type ConfigState = {
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

export default function NfceConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [cfg, setCfg] = useState<ConfigState>({
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
  });

  // Campos sensíveis — write-only (não exibe valor já salvo)
  const [pfxBase64, setPfxBase64] = useState('');
  const [pfxPassword, setPfxPassword] = useState('');
  const [showPfxPwd, setShowPfxPwd] = useState(false);
  const [showCscToken, setShowCscToken] = useState(false);
  const [pfxFileName, setPfxFileName] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await api<any>('/pdv/nfce/config');
        setCfg((prev) => ({
          ...prev,
          ...data,
          endereco: data.endereco || prev.endereco,
        }));
      } catch (e: any) {
        setMsg({ kind: 'err', text: 'Falha ao ler config: ' + (e?.message || e) });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result vem como "data:application/x-pkcs12;base64,XXXXX"
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
      // Sensíveis: só envia se preenchido novo (preserva valor antigo no banco)
      if (cscTokenChanged) body.cscToken = cfg.cscToken;
      if (pfxBase64) body.certPfxB64 = pfxBase64;
      if (pfxPassword) body.certPfxPass = pfxPassword;

      const updated = await api<any>('/pdv/nfce/config', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCfg((prev) => ({
        ...prev,
        ...updated,
        endereco: updated.endereco || prev.endereco,
      }));
      // Limpa campos de upload após salvar
      setPfxBase64('');
      setPfxPassword('');
      setPfxFileName('');
      setCscTokenChanged(false);
      setMsg({ kind: 'ok', text: 'Configuração salva ✓' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Erro ao salvar: ' + (e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  const [cscTokenChanged, setCscTokenChanged] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-rose-50 p-6 flex items-center justify-center">
        <div className="text-rose-700">Carregando configuração…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-rose-50 p-4 md:p-6">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/retaguarda"
          className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar
        </Link>

        <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-rose-900">
              NFC-e — Configuração
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Emissão de cupom fiscal eletrônico (modelo 65) direto pelo PDV
            </p>
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
          {/* AMBIENTE */}
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

          {/* IDENTIFICAÇÃO */}
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

          {/* ENDEREÇO */}
          <Card title="Endereço do Estabelecimento">
            <Field label="Logradouro" value={cfg.endereco.logradouro} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, logradouro: v } })} />
            <div className="grid grid-cols-3 gap-3">
              <Field label="Número" value={cfg.endereco.numero} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, numero: v } })} />
              <Field label="Bairro" value={cfg.endereco.bairro} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, bairro: v } })} />
              <Field label="CEP" value={cfg.endereco.cep} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, cep: v } })} placeholder="00000-000" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Município" value={cfg.endereco.municipio} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, municipio: v } })} />
              <Field label="UF" value={cfg.uf} onChange={(v) => setCfg({ ...cfg, uf: v })} placeholder="SP" />
              <Field label="Cód. Município IBGE" value={cfg.endereco.codMunicipio} onChange={(v) => setCfg({ ...cfg, endereco: { ...cfg.endereco, codMunicipio: v } })} placeholder="3550308" />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Cód. IBGE de São Paulo capital = 3550308. Outros municípios:{' '}
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

          {/* CSC */}
          <Card
            title="CSC — Código de Segurança do Contribuinte"
            subtitle="Token e ID do CSC fornecidos pelo Posto Fiscal SEFAZ-SP"
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
                  placeholder={cfg.cscToken ? '••••• (já cadastrado — preencha pra trocar)' : ''}
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
              <p className="text-xs text-gray-500 mt-1">
                Como obter: Posto Fiscal SEFAZ-SP → solicitar credencial CSC NFC-e
              </p>
            </div>
          </Card>

          {/* SÉRIE */}
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
                <p className="text-xs text-gray-500 mt-1">
                  Auto-incrementa a cada emissão
                </p>
              </div>
            </div>
          </Card>

          {/* CERTIFICADO A1 */}
          <Card
            title="Certificado Digital A1 (.pfx)"
            subtitle="Arquivo .pfx + senha emitidos pela autoridade certificadora (Serasa, Certisign, Valid, etc)"
          >
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 text-xs text-amber-900">
              <FileWarning size={14} className="inline mr-1" />
              <strong>Importante:</strong> o .pfx é guardado criptografado no banco e só
              esse servidor consegue usar. Se trocar de servidor, precisa fazer upload de novo.
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
                  placeholder={cfg.certificadoCarregado ? '••••• (preencha pra trocar)' : 'Senha A1'}
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

          {/* SAVE */}
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
                  Faltam campos críticos (CNPJ, IE, CSC, certificado)
                </span>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving}
              className="bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2"
            >
              <Save size={18} />
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
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

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-lg font-bold text-rose-900 mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mb-3">{subtitle}</p>}
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
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

function RadioBox({
  checked,
  onChange,
  title,
  sub,
  color,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  sub: string;
  color: 'amber' | 'rose';
}) {
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
