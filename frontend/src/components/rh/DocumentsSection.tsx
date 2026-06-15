'use client';

/**
 * DocumentsSection — UI de upload + listagem agrupada por categoria.
 *
 * Categorias (precisa bater com backend SellerDocumentsService):
 *   documento_pessoal | contrato | recibo_pagamento | atestado | ferias | outro
 *
 * Endpoints:
 *   GET    /sellers/:id/documents       → { grouped: {cat: [...]} }
 *   POST   /sellers/:id/documents       → multipart/form-data
 *   DELETE /sellers/documents/:docId
 */

import { useEffect, useState } from 'react';
import {
  FileText, Upload, Trash2, Download, Loader2, Plus, X,
  Folder, FolderOpen,
} from 'lucide-react';

const CATEGORIAS: Array<{ key: string; label: string; emoji: string }> = [
  { key: 'documento_pessoal', label: 'Documento Pessoal', emoji: '🪪' },
  { key: 'contrato', label: 'Contrato', emoji: '📋' },
  { key: 'recibo_pagamento', label: 'Recibo Pagamento', emoji: '💵' },
  { key: 'atestado', label: 'Atestado', emoji: '🏥' },
  { key: 'ferias', label: 'Férias', emoji: '🌴' },
  { key: 'outro', label: 'Outros', emoji: '📁' },
];

type DocItem = {
  id: string;
  categoria: string;
  titulo: string;
  fileUrl: string;
  fileSize?: number | null;
  mimeType?: string | null;
  dataReferencia?: string | null;
  observacoes?: string | null;
  uploadedAt: string;
};

const fmtSize = (n?: number | null) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtDate = (s?: string | null) => {
  if (!s) return '';
  try {
    return new Date(s).toLocaleDateString('pt-BR');
  } catch {
    return '';
  }
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  '';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (
      window.localStorage?.getItem('flowops_token') ||
      window.sessionStorage?.getItem('flowops_token')
    );
  } catch {
    return null;
  }
}

export default function DocumentsSection({ sellerId }: { sellerId: string }) {
  const [grouped, setGrouped] = useState<Record<string, DocItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState<string | null>(null); // categoria

  async function load() {
    setLoading(true);
    try {
      const token = getToken();
      const r = await fetch(`${API_BASE}/sellers/${sellerId}/documents`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const json = await r.json();
      setGrouped(json?.grouped || {});
    } catch (e) {
      console.error('[docs] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (sellerId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellerId]);

  async function handleUpload(
    categoria: string,
    file: File,
    titulo: string,
    dataReferencia: string,
    observacoes: string,
  ) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('categoria', categoria);
    if (titulo) fd.append('titulo', titulo);
    if (dataReferencia) fd.append('dataReferencia', dataReferencia);
    if (observacoes) fd.append('observacoes', observacoes);

    const token = getToken();
    const r = await fetch(`${API_BASE}/sellers/${sellerId}/documents`, {
      method: 'POST',
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err?.message || `HTTP ${r.status}`);
    }
    await load();
  }

  async function handleDelete(docId: string) {
    if (!confirm('Excluir este documento? Não dá pra desfazer.')) return;
    const token = getToken();
    const r = await fetch(`${API_BASE}/sellers/documents/${docId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!r.ok) {
      alert('Erro ao excluir');
      return;
    }
    await load();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-5 h-5 animate-spin text-emerald-600" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {CATEGORIAS.map((cat) => {
        const items = grouped[cat.key] || [];
        const isOpen = expanded === cat.key;
        return (
          <div key={cat.key} className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setExpanded(isOpen ? null : cat.key)}
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-slate-50 hover:bg-slate-100"
            >
              <span className="text-lg">{cat.emoji}</span>
              <span className="font-bold text-sm text-slate-700 flex-1 text-left">
                {cat.label}
              </span>
              <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full font-bold">
                {items.length}
              </span>
              {isOpen ? (
                <FolderOpen className="w-4 h-4 text-emerald-600" />
              ) : (
                <Folder className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {isOpen && (
              <div className="p-3 bg-white space-y-2">
                {items.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-2">
                    Nenhum documento nessa categoria.
                  </p>
                ) : (
                  items.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center gap-2 p-2 bg-slate-50 rounded border border-slate-200"
                    >
                      <FileText className="w-4 h-4 text-slate-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-800 truncate">
                          {d.titulo}
                        </p>
                        <p className="text-xs text-slate-500">
                          {fmtDate(d.uploadedAt)}
                          {d.fileSize ? ` · ${fmtSize(d.fileSize)}` : ''}
                          {d.dataReferencia ? ` · Ref: ${fmtDate(d.dataReferencia)}` : ''}
                        </p>
                      </div>
                      <a
                        href={d.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded"
                        title="Abrir"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                      <button
                        onClick={() => handleDelete(d.id)}
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                        title="Excluir"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}

                <button
                  onClick={() => setShowUpload(cat.key)}
                  className="w-full flex items-center justify-center gap-2 py-2 mt-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold text-sm rounded border border-dashed border-emerald-300"
                >
                  <Plus className="w-4 h-4" />
                  Adicionar {cat.label}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {showUpload && (
        <UploadModal
          categoria={showUpload}
          categoriaLabel={
            CATEGORIAS.find((c) => c.key === showUpload)?.label || showUpload
          }
          onClose={() => setShowUpload(null)}
          onSubmit={handleUpload}
        />
      )}
    </div>
  );
}

function UploadModal({
  categoria,
  categoriaLabel,
  onClose,
  onSubmit,
}: {
  categoria: string;
  categoriaLabel: string;
  onClose: () => void;
  onSubmit: (
    categoria: string,
    file: File,
    titulo: string,
    dataReferencia: string,
    observacoes: string,
  ) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [titulo, setTitulo] = useState('');
  const [dataRef, setDataRef] = useState('');
  const [obs, setObs] = useState('');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!file) {
      setErr('Selecione um arquivo');
      return;
    }
    setUploading(true);
    setErr(null);
    try {
      await onSubmit(categoria, file, titulo, dataRef, obs);
      onClose();
    } catch (e: any) {
      setErr(e?.message || 'Falha no upload');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-800">Adicionar — {categoriaLabel}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Arquivo (PDF / JPG / PNG — máx 10MB)
            </label>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-sm"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx"
            />
            {file && (
              <p className="text-xs text-emerald-700 mt-1">
                ✓ {file.name} ({fmtSize(file.size)})
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Título (opcional — usa nome do arquivo se vazio)
            </label>
            <input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder={`Ex: ${categoriaLabel} ${new Date().getFullYear()}`}
              className="w-full px-3 py-2 border rounded text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Data de referência
            </label>
            <input
              type="date"
              value={dataRef}
              onChange={(e) => setDataRef(e.target.value)}
              className="w-full px-3 py-2 border rounded text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Observações
            </label>
            <textarea
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border rounded text-sm"
            />
          </div>

          {err && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 p-2 rounded">
              {err}
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 py-2 border rounded font-bold text-slate-600 hover:bg-slate-50"
            disabled={uploading}
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={uploading || !file}
            className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded font-bold flex items-center justify-center gap-2"
          >
            {uploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Subindo...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Subir
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
