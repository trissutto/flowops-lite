'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Eye,
  FileImage,
  Globe2,
  GripVertical,
  ImagePlus,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Unlink,
  UploadCloud,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';

type Media = {
  id: string;
  kind: string;
  fileName: string;
  sourceUrl: string;
  mimeType?: string | null;
  caption?: string | null;
  sortOrder: number;
  isCover: boolean;
  active: boolean;
};

type Checklist = {
  ready: boolean;
  items: Array<{ key: string; label: string; ok: boolean }>;
};

type CommercialData = {
  property: Record<string, any>;
  profile: Record<string, any> | null;
  media: Media[];
  publication: Record<string, any> | null;
  checklist: Checklist;
  jobs: Array<Record<string, any>>;
};

type PreviewData = {
  checklist: Checklist;
  snapshot: Record<string, any>;
  mediaSources: Media[];
  privateFields: string[];
  publicUrl: string;
};

const EMPTY_PROFILE: Record<string, any> = {
  municipalRegistration: '',
  propertyType: '',
  commercialStatus: 'disponivel',
  internalReference: '',
  mapUrl: '',
  publicLocationNote: '',
  publishFullAddress: true,
  landAreaM2: '',
  landAreaNotApplicable: false,
  builtAreaM2: '',
  builtAreaNotApplicable: false,
  usefulAreaM2: '',
  bedrooms: '',
  suites: '',
  bathrooms: '',
  parkingSpaces: '',
  floor: '',
  elevator: null,
  furnished: null,
  constructionYear: '',
  features: [],
  salePrice: '',
  condominiumMonthly: '',
  iptuAnnual: '',
  acceptsFinancing: null,
  acceptsExchange: null,
  negotiable: null,
  negotiationText: '',
  description: '',
  whatsappSummary: '',
  campaignTitle: '',
  lastReviewedAt: '',
  brokerCommissionNotes: '',
  internalNegotiationNotes: '',
};

const PROPERTY_TYPES: Array<[string, string]> = [
  ['casa', 'Casa'],
  ['apartamento', 'Apartamento'],
  ['terreno', 'Terreno'],
  ['sala_comercial', 'Sala comercial'],
  ['galpao', 'Galpão'],
  ['loja', 'Loja'],
  ['outro', 'Outro'],
];

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: { label: 'Rascunho', className: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  publishing: { label: 'Publicando', className: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  published: { label: 'Publicado', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  update_pending: { label: 'Atualização pendente', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  updating: { label: 'Atualizando', className: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  unpublishing: { label: 'Despublicando', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  unpublished: { label: 'Despublicado', className: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  error: { label: 'Erro na sincronização', className: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
};

const TRANSITIONAL = new Set(['publishing', 'updating', 'unpublishing']);

export function PropertyCommercialTab({ propertyId }: { propertyId: string }) {
  const [data, setData] = useState<CommercialData | null>(null);
  const [form, setForm] = useState<Record<string, any>>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [linkKind, setLinkKind] = useState('video');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkCaption, setLinkCaption] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await api<CommercialData>(`/properties/${propertyId}/commercial`);
      setData(result);
      if (!quiet) {
        const loaded = { ...EMPTY_PROFILE, ...(result.profile || {}) };
        if (loaded.lastReviewedAt) loaded.lastReviewedAt = String(loaded.lastReviewedAt).slice(0, 10);
        setForm(loaded);
        setDirty(false);
      }
      setError(null);
    } catch (e: any) {
      setError(readError(e));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const status = data?.publication?.status;
    if (!status || (!TRANSITIONAL.has(status) && status !== 'error')) return;
    const timer = setInterval(() => load(true), 5000);
    return () => clearInterval(timer);
  }, [data?.publication?.status, load]);

  const setField = (key: string, value: any) => {
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const payload = { ...form, features: normalizeFeatures(form.features) };
      const result = await api<CommercialData>(`/properties/${propertyId}/commercial`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setData(result);
      setDirty(false);
      setSuccess('Ficha salva.');
      setTimeout(() => setSuccess(null), 2500);
      return true;
    } catch (e: any) {
      setError(readError(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files);
    if (!selected.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of selected) {
        const body = new FormData();
        body.append('file', file);
        body.append('kind', file.type === 'application/pdf' ? 'floorplan' : 'photo');
        await api(`/properties/${propertyId}/commercial/media/upload`, { method: 'POST', body });
      }
      await load(true);
      setSuccess(`${selected.length} arquivo(s) enviado(s).`);
      setTimeout(() => setSuccess(null), 2500);
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const addLink = async () => {
    if (!linkUrl.trim()) return;
    setWorking('link');
    setError(null);
    try {
      await api(`/properties/${propertyId}/commercial/media/link`, {
        method: 'POST',
        body: JSON.stringify({
          kind: linkKind,
          sourceUrl: linkUrl,
          fileName: linkKind === 'video' ? 'Vídeo do imóvel' : 'Tour virtual',
          caption: linkCaption,
        }),
      });
      setLinkUrl('');
      setLinkCaption('');
      await load(true);
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setWorking(null);
    }
  };

  const patchMedia = async (mediaId: string, patch: Record<string, any>) => {
    setWorking(mediaId);
    try {
      const result = await api<CommercialData>(`/properties/${propertyId}/commercial/media/${mediaId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setData(result);
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setWorking(null);
    }
  };

  const deleteMedia = async (media: Media) => {
    if (!confirm(`Remover “${media.fileName}” da ficha comercial?`)) return;
    setWorking(media.id);
    try {
      await api(`/properties/${propertyId}/commercial/media/${media.id}`, { method: 'DELETE' });
      await load(true);
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setWorking(null);
    }
  };

  const reorder = async (orderedIds: string[]) => {
    if (!data) return;
    const byId = new Map(data.media.map((item) => [item.id, item]));
    setData({ ...data, media: orderedIds.map((id, index) => ({ ...byId.get(id)!, sortOrder: index })) });
    try {
      const result = await api<CommercialData>(`/properties/${propertyId}/commercial/media-order`, {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds }),
      });
      setData(result);
    } catch (e: any) {
      setError(readError(e));
      await load(true);
    }
  };

  const moveMedia = (id: string, direction: -1 | 1) => {
    if (!data) return;
    const ids = data.media.map((item) => item.id);
    const index = ids.indexOf(id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    reorder(ids);
  };

  const dropOn = (targetId: string) => {
    if (!data || !draggedId || draggedId === targetId) return setDraggedId(null);
    const ids = data.media.map((item) => item.id).filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(targetIndex, 0, draggedId);
    setDraggedId(null);
    reorder(ids);
  };

  const openPreview = async () => {
    setPreviewLoading(true);
    setError(null);
    try {
      if (dirty && !(await save())) return;
      setPreview(await api<PreviewData>(`/properties/${propertyId}/commercial/preview`));
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const publicationAction = async (action: 'publish' | 'unpublish' | 'rotate-link' | 'retry') => {
    const messages: Record<string, string> = {
      'unpublish': 'Despublicar a ficha agora? O link, as fotos, o PDF e o ZIP deixarão de abrir.',
      'rotate-link': 'Gerar um novo link? O endereço anterior será revogado.',
    };
    if (messages[action] && !confirm(messages[action])) return;
    setWorking(action);
    setError(null);
    try {
      const result = await api<CommercialData>(`/properties/${propertyId}/commercial/${action}`, { method: 'POST' });
      setData(result);
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setWorking(null);
    }
  };

  const copyLink = async () => {
    const url = data?.publication?.publicUrl;
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setSuccess('Link copiado.');
    setTimeout(() => setSuccess(null), 2000);
  };

  if (loading) {
    return <div className="py-20 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-amber-400" /></div>;
  }
  if (!data) {
    return <Message tone="error">{error || 'Não foi possível carregar a ficha comercial.'}</Message>;
  }

  const publication = data.publication;
  const status = publication?.status || 'draft';
  const statusInfo = STATUS_LABELS[status] || STATUS_LABELS.draft;
  const busy = TRANSITIONAL.has(status) || !!working;
  const featuresText = Array.isArray(form.features) ? form.features.join('\n') : String(form.features || '');

  return (
    <div className="space-y-5">
      <section className="bg-gradient-to-br from-amber-500/10 to-slate-900/30 border border-amber-500/25 rounded-2xl p-5">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
            <Globe2 className="w-6 h-6 text-amber-300" />
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-black">Ficha para Corretores</h2>
              <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full border ${statusInfo.className}`}>
                {statusInfo.label}
              </span>
              {dirty && <span className="text-[10px] font-bold uppercase px-2 py-1 rounded-full border bg-amber-500/15 text-amber-300 border-amber-500/30">Alterações não salvas</span>}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Somente os dados desta aba e as mídias comerciais podem seguir para o portal isolado.
            </p>
            {publication?.lastError && (
              <p className="text-xs text-rose-300 mt-2">{publication.lastError}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton icon={Eye} onClick={openPreview} disabled={previewLoading} secondary>
              {previewLoading ? 'Carregando...' : 'Pré-visualizar'}
            </ActionButton>
            {publication?.publicUrl && status !== 'unpublished' && (
              <>
                <ActionButton icon={Copy} onClick={copyLink} secondary>Copiar link</ActionButton>
                <a href={publication.publicUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs font-bold hover:bg-white/10">
                  <ExternalLink className="w-3.5 h-3.5" /> Abrir
                </a>
              </>
            )}
          </div>
        </div>
      </section>

      {error && <Message tone="error">{error}</Message>}
      {success && <Message tone="success">{success}</Message>}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5 items-start">
        <div className="space-y-5">
          <FormSection title="Identificação comercial">
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Inscrição municipal *" value={form.municipalRegistration} onChange={(v) => setField('municipalRegistration', v)} />
              <Field label="Referência interna" value={form.internalReference} onChange={(v) => setField('internalReference', v)} />
              <SelectField label="Tipo do imóvel *" value={form.propertyType} onChange={(v) => setField('propertyType', v)} options={PROPERTY_TYPES} />
              <SelectField label="Situação comercial *" value={form.commercialStatus} onChange={(v) => setField('commercialStatus', v)} options={[
                ['disponivel', 'Disponível'], ['reservado', 'Reservado'], ['em_negociacao', 'Em negociação'], ['vendido', 'Vendido'],
              ]} />
            </div>
            <Field label="Título de campanha" value={form.campaignTitle} onChange={(v) => setField('campaignTitle', v)} placeholder="Ex: Oportunidade em Moema" />
            <Field label="Data da última conferência" value={form.lastReviewedAt} onChange={(v) => setField('lastReviewedAt', v)} type="date" />
          </FormSection>

          <FormSection title="Localização pública">
            <div className="p-3 bg-black/20 border border-white/10 rounded-xl text-xs text-slate-300">
              {[data.property.endereco, data.property.numero, data.property.complemento, data.property.bairro, data.property.cidade, data.property.estado]
                .filter(Boolean).join(', ') || 'Endereço ainda não cadastrado na aba Geral.'}
            </div>
            <Field label="Link do Google Maps" value={form.mapUrl} onChange={(v) => setField('mapUrl', v)} placeholder="https://maps.google.com/..." />
            <Field label="Observação pública da localização" value={form.publicLocationNote} onChange={(v) => setField('publicLocationNote', v)} type="textarea" placeholder="Próximo ao metrô, acesso fácil..." />
            <Toggle label="Publicar endereço completo" checked={form.publishFullAddress !== false} onChange={(v) => setField('publishFullAddress', v)} />
          </FormSection>

          <FormSection title="Metragens">
            <div className="grid md:grid-cols-3 gap-3">
              <AreaField label="Terreno (m²)" value={form.landAreaM2} notApplicable={form.landAreaNotApplicable} onValue={(v) => setField('landAreaM2', v)} onNotApplicable={(v) => setField('landAreaNotApplicable', v)} />
              <AreaField label="Construída (m²)" value={form.builtAreaM2} notApplicable={form.builtAreaNotApplicable} onValue={(v) => setField('builtAreaM2', v)} onNotApplicable={(v) => setField('builtAreaNotApplicable', v)} />
              <Field label="Área útil (m²)" value={form.usefulAreaM2} onChange={(v) => setField('usefulAreaM2', v)} type="number" />
            </div>
          </FormSection>

          <FormSection title="Características">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="Quartos" value={form.bedrooms} onChange={(v) => setField('bedrooms', v)} type="number" />
              <Field label="Suítes" value={form.suites} onChange={(v) => setField('suites', v)} type="number" />
              <Field label="Banheiros" value={form.bathrooms} onChange={(v) => setField('bathrooms', v)} type="number" />
              <Field label="Vagas" value={form.parkingSpaces} onChange={(v) => setField('parkingSpaces', v)} type="number" />
              <Field label="Andar" value={form.floor} onChange={(v) => setField('floor', v)} type="number" />
              <Field label="Ano de construção" value={form.constructionYear} onChange={(v) => setField('constructionYear', v)} type="number" />
              <TriState label="Elevador" value={form.elevator} onChange={(v) => setField('elevator', v)} />
              <TriState label="Mobiliado" value={form.furnished} onChange={(v) => setField('furnished', v)} />
            </div>
            <Field label="Diferenciais — um por linha" value={featuresText} onChange={(v) => setField('features', v)} type="textarea" placeholder={'Varanda gourmet\nVista livre\nPortaria 24 horas'} />
          </FormSection>

          <FormSection title="Valores e negociação">
            <div className="grid md:grid-cols-3 gap-3">
              <Field label="Valor de venda (R$) *" value={form.salePrice} onChange={(v) => setField('salePrice', v)} type="number" />
              <Field label="Condomínio mensal (R$)" value={form.condominiumMonthly} onChange={(v) => setField('condominiumMonthly', v)} type="number" />
              <Field label="IPTU anual (R$)" value={form.iptuAnnual} onChange={(v) => setField('iptuAnnual', v)} type="number" />
              <TriState label="Aceita financiamento" value={form.acceptsFinancing} onChange={(v) => setField('acceptsFinancing', v)} />
              <TriState label="Aceita permuta" value={form.acceptsExchange} onChange={(v) => setField('acceptsExchange', v)} />
              <TriState label="Valor negociável" value={form.negotiable} onChange={(v) => setField('negotiable', v)} />
            </div>
            <Field label="Condições públicas de negociação" value={form.negotiationText} onChange={(v) => setField('negotiationText', v)} type="textarea" />
          </FormSection>

          <FormSection title="Texto de divulgação">
            <Field label="Descrição comercial *" value={form.description} onChange={(v) => setField('description', v)} type="textarea" rows={7} />
            <Field label="Resumo personalizado para WhatsApp" value={form.whatsappSummary} onChange={(v) => setField('whatsappSummary', v)} type="textarea" placeholder="Se ficar vazio, o sistema monta automaticamente." />
          </FormSection>

          <FormSection title="Informações internas — nunca publicadas" privateSection>
            <Field label="Comissão do corretor" value={form.brokerCommissionNotes} onChange={(v) => setField('brokerCommissionNotes', v)} type="textarea" />
            <Field label="Observações internas de negociação" value={form.internalNegotiationNotes} onChange={(v) => setField('internalNegotiationNotes', v)} type="textarea" />
          </FormSection>

          <button onClick={save} disabled={saving} className="w-full px-5 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black flex items-center justify-center gap-2 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar ficha comercial
          </button>

          <FormSection title="Fotos e materiais comerciais">
            <div
              className="border-2 border-dashed border-amber-500/30 rounded-xl p-6 text-center hover:bg-amber-500/5 cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); uploadFiles(event.dataTransfer.files); }}
            >
              {uploading ? <Loader2 className="w-8 h-8 animate-spin text-amber-400 mx-auto" /> : <UploadCloud className="w-8 h-8 text-amber-400 mx-auto" />}
              <div className="font-bold text-sm mt-2">{uploading ? 'Enviando arquivos...' : 'Enviar fotos ou planta'}</div>
              <div className="text-[11px] text-slate-500 mt-1">JPG, PNG ou PDF · até 10 MB por arquivo</div>
              <input ref={fileInputRef} type="file" multiple accept=".jpg,.jpeg,.png,.pdf" className="hidden" onChange={(event) => event.target.files && uploadFiles(event.target.files)} />
            </div>

            <div className="grid md:grid-cols-[140px_1fr_1fr_auto] gap-2 items-end p-3 bg-black/20 rounded-xl">
              <SelectField label="Tipo do link" value={linkKind} onChange={setLinkKind} options={[["video", "Vídeo"], ["virtual_tour", "Tour virtual"]]} />
              <Field label="URL HTTPS" value={linkUrl} onChange={setLinkUrl} placeholder="https://..." />
              <Field label="Legenda" value={linkCaption} onChange={setLinkCaption} />
              <button onClick={addLink} disabled={!linkUrl.trim() || working === 'link'} className="h-[42px] px-4 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-bold disabled:opacity-40 flex items-center gap-2">
                <Link2 className="w-4 h-4" /> Adicionar
              </button>
            </div>

            {data.media.length === 0 ? (
              <div className="py-10 text-center text-slate-500 text-sm"><ImagePlus className="w-9 h-9 mx-auto mb-2 opacity-50" />Nenhuma mídia comercial.</div>
            ) : (
              <div className="space-y-2">
                {data.media.map((media, index) => (
                  <MediaRow
                    key={media.id}
                    media={media}
                    index={index}
                    total={data.media.length}
                    working={working === media.id}
                    dragged={draggedId === media.id}
                    onDragStart={() => setDraggedId(media.id)}
                    onDrop={() => dropOn(media.id)}
                    onMove={(direction) => moveMedia(media.id, direction)}
                    onPatch={(patch) => patchMedia(media.id, patch)}
                    onDelete={() => deleteMedia(media)}
                  />
                ))}
              </div>
            )}
          </FormSection>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-28">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <h3 className="font-black text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-amber-400" />Checklist de publicação</h3>
            <div className="space-y-2 mt-4">
              {data.checklist.items.map((item) => (
                <div key={item.key} className="flex items-center gap-2 text-xs">
                  {item.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
                  <span className={item.ok ? 'text-slate-300' : 'text-amber-200'}>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
            <h3 className="font-black text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-400" />Publicação segura</h3>
            <p className="text-[11px] text-slate-400">A página pública recebe uma cópia sanitizada. O portal não acessa o banco do FlowOps.</p>

            {(status === 'draft' || status === 'unpublished' || status === 'published' || status === 'update_pending') && (
              <button onClick={() => publicationAction('publish')} disabled={busy || dirty || !data.checklist.ready} title={dirty ? 'Salve as alterações antes de publicar.' : undefined} className="w-full px-4 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black disabled:opacity-40 flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe2 className="w-4 h-4" />}
                {status === 'published' || status === 'update_pending' ? 'Atualizar publicação' : 'Publicar ficha'}
              </button>
            )}
            {status === 'error' && (
              <button onClick={() => publicationAction('retry')} disabled={busy} className="w-full px-4 py-3 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-black flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4" />Tentar novamente</button>
            )}
            {publication?.publishedVersion > 0 && status !== 'unpublished' && (
              <>
                <button onClick={() => publicationAction('rotate-link')} disabled={busy} className="w-full px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold disabled:opacity-40 flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4" />Gerar novo link</button>
                <button onClick={() => publicationAction('unpublish')} disabled={busy} className="w-full px-4 py-2.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-300 text-xs font-bold disabled:opacity-40 flex items-center justify-center gap-2"><Unlink className="w-4 h-4" />Despublicar</button>
              </>
            )}
          </div>
        </aside>
      </div>

      {preview && <PreviewModal data={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function MediaRow({
  media,
  index,
  total,
  working,
  dragged,
  onDragStart,
  onDrop,
  onMove,
  onPatch,
  onDelete,
}: {
  media: Media;
  index: number;
  total: number;
  working: boolean;
  dragged: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onMove: (direction: -1 | 1) => void;
  onPatch: (patch: Record<string, any>) => void;
  onDelete: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl border transition ${dragged ? 'opacity-40 border-amber-400' : 'bg-white/5 border-white/10'}`}
    >
      <GripVertical className="hidden sm:block w-4 h-4 text-slate-600 cursor-grab" />
      <div className="w-full sm:w-24 h-20 rounded-lg overflow-hidden bg-black/30 shrink-0 flex items-center justify-center">
        {media.kind === 'photo' ? <img src={media.sourceUrl} alt={media.caption || media.fileName} className="w-full h-full object-cover" /> : <FileImage className="w-7 h-7 text-amber-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold truncate">{media.fileName}</span>
          <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-white/10 text-slate-400">{media.kind}</span>
          {media.isCover && <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">Capa</span>}
          {!media.active && <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">Oculta</span>}
        </div>
        <input
          defaultValue={media.caption || ''}
          onBlur={(event) => event.target.value !== (media.caption || '') && onPatch({ caption: event.target.value })}
          placeholder="Legenda da mídia"
          className="w-full mt-2 px-2.5 py-1.5 bg-black/20 border border-white/10 rounded text-xs focus:outline-none focus:border-amber-400"
        />
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => onMove(-1)} disabled={index === 0 || working} className="p-2 hover:bg-white/10 rounded disabled:opacity-25" title="Subir"><ChevronUp className="w-4 h-4" /></button>
        <button onClick={() => onMove(1)} disabled={index === total - 1 || working} className="p-2 hover:bg-white/10 rounded disabled:opacity-25" title="Descer"><ChevronDown className="w-4 h-4" /></button>
        {media.kind === 'photo' && !media.isCover && <button onClick={() => onPatch({ isCover: true })} disabled={working} className="px-2 py-1.5 text-[10px] font-bold bg-amber-500/10 text-amber-300 rounded">Capa</button>}
        <button onClick={() => onPatch({ active: !media.active })} disabled={working} className="px-2 py-1.5 text-[10px] font-bold bg-white/5 rounded">{media.active ? 'Ocultar' : 'Exibir'}</button>
        <button onClick={onDelete} disabled={working} className="p-2 text-rose-400 hover:bg-rose-500/10 rounded"><Trash2 className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

function PreviewModal({ data, onClose }: { data: PreviewData; onClose: () => void }) {
  const snapshot = data.snapshot;
  const photos = data.mediaSources.filter((media) => media.kind === 'photo');
  return (
    <div className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-sm p-4 overflow-y-auto" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="max-w-5xl mx-auto bg-slate-900 border border-white/15 rounded-2xl overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-white/10 flex items-center gap-3 sticky top-0 bg-slate-900 z-10">
          <Eye className="w-5 h-5 text-amber-400" />
          <div className="flex-1"><div className="font-black">Prévia exata da publicação</div><div className="text-[11px] text-slate-500">Nenhum dado é enviado ao abrir esta tela.</div></div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded"><X className="w-5 h-5" /></button>
        </div>
        {photos[0] && <img src={photos[0].sourceUrl} alt="Foto de capa" className="w-full h-64 md:h-96 object-cover" />}
        <div className="p-6 grid lg:grid-cols-[1fr_300px] gap-6">
          <div>
            <div className="text-xs uppercase tracking-widest text-amber-400 font-bold">{snapshot.propertyType}</div>
            <h2 className="text-3xl font-black mt-1">{snapshot.campaignTitle || snapshot.name}</h2>
            <div className="text-slate-400 mt-2">{[snapshot.address.endereco, snapshot.address.numero, snapshot.address.bairro, snapshot.address.cidade, snapshot.address.estado].filter(Boolean).join(', ')}</div>
            <div className="text-3xl font-black text-emerald-400 mt-5">{formatCurrency(snapshot.financial.salePrice)}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-5">
              {snapshot.areas.landM2 && <PreviewMetric label="Terreno" value={`${snapshot.areas.landM2} m²`} />}
              {snapshot.areas.builtM2 && <PreviewMetric label="Construída" value={`${snapshot.areas.builtM2} m²`} />}
              {snapshot.areas.usefulM2 && <PreviewMetric label="Útil" value={`${snapshot.areas.usefulM2} m²`} />}
              {snapshot.characteristics.bedrooms !== null && <PreviewMetric label="Quartos" value={snapshot.characteristics.bedrooms} />}
              {snapshot.characteristics.bathrooms !== null && <PreviewMetric label="Banheiros" value={snapshot.characteristics.bathrooms} />}
              {snapshot.characteristics.parkingSpaces !== null && <PreviewMetric label="Vagas" value={snapshot.characteristics.parkingSpaces} />}
            </div>
            <p className="whitespace-pre-line text-sm text-slate-300 leading-7 mt-6">{snapshot.description}</p>
            {photos.length > 1 && <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-6">{photos.slice(1).map((photo) => <img key={photo.id} src={photo.sourceUrl} alt={photo.caption || photo.fileName} className="w-full h-36 object-cover rounded-lg" />)}</div>}
          </div>
          <aside className="space-y-4">
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
              <div className="font-black text-sm text-emerald-300 flex items-center gap-2"><ShieldCheck className="w-4 h-4" />Dados bloqueados</div>
              <div className="space-y-1.5 mt-3">{data.privateFields.map((field) => <div key={field} className="text-xs text-slate-400">• {field}</div>)}</div>
            </div>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-xs text-slate-400">Inscrição municipal: <b className="text-white">{snapshot.municipalRegistration}</b></div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function FormSection({ title, children, privateSection = false }: { title: string; children: React.ReactNode; privateSection?: boolean }) {
  return <section className={`border rounded-2xl p-5 space-y-4 ${privateSection ? 'bg-rose-500/5 border-rose-500/20' : 'bg-white/5 border-white/10'}`}><h3 className={`text-xs font-black uppercase tracking-wider ${privateSection ? 'text-rose-300' : 'text-amber-400'}`}>{title}</h3>{children}</section>;
}

function Field({ label, value, onChange, type = 'text', placeholder, rows = 3 }: {
  label: string;
  value: any;
  onChange: (value: string) => void;
  type?: 'text' | 'number' | 'date' | 'textarea';
  placeholder?: string;
  rows?: number;
}) {
  const className = 'w-full px-3 py-2.5 bg-black/20 border border-white/10 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400';
  return <label className="block"><span className="text-xs font-bold text-slate-300 mb-1.5 block">{label}</span>{type === 'textarea' ? <textarea value={value ?? ''} rows={rows} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`${className} resize-y`} /> : <input type={type} value={value ?? ''} placeholder={placeholder} min={type === 'number' ? 0 : undefined} step={type === 'number' ? '0.01' : undefined} onChange={(event) => onChange(event.target.value)} className={className} />}</label>;
}

function SelectField({ label, value, onChange, options }: {
  label: string;
  value: any;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  return <label className="block"><span className="text-xs font-bold text-slate-300 mb-1.5 block">{label}</span><select value={value ?? ''} onChange={(event) => onChange(event.target.value)} className="w-full px-3 py-2.5 bg-slate-900 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-amber-400"><option value="">Selecione</option>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}

function TriState({ label, value, onChange }: {
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  const serialized = value === true ? 'true' : value === false ? 'false' : '';
  return <SelectField label={label} value={serialized} onChange={(next: string) => onChange(next === '' ? null : next === 'true')} options={[["true", "Sim"], ["false", "Não"]]} />;
}

function Toggle({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return <label className="flex items-center gap-3 cursor-pointer"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="w-4 h-4 accent-amber-500" /><span className="text-xs font-bold text-slate-300">{label}</span></label>;
}

function AreaField({ label, value, notApplicable, onValue, onNotApplicable }: {
  label: string;
  value: any;
  notApplicable: boolean;
  onValue: (value: string) => void;
  onNotApplicable: (value: boolean) => void;
}) {
  return <div className="space-y-2"><Field label={label} value={value} onChange={onValue} type="number" /><Toggle label="Não se aplica" checked={notApplicable} onChange={onNotApplicable} /></div>;
}

function ActionButton({ icon: Icon, children, onClick, disabled, secondary }: any) {
  return <button onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-40 ${secondary ? 'bg-white/5 hover:bg-white/10 border border-white/10' : 'bg-amber-500 text-slate-950'}`}><Icon className="w-3.5 h-3.5" />{children}</button>;
}

function Message({ tone, children }: { tone: 'error' | 'success'; children: React.ReactNode }) {
  return <div className={`p-3 rounded-xl border text-sm ${tone === 'error' ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}`}>{children}</div>;
}

function PreviewMetric({ label, value }: any) {
  return <div className="p-3 rounded-lg bg-white/5 border border-white/10"><div className="font-black">{value}</div><div className="text-[10px] text-slate-500 uppercase">{label}</div></div>;
}

function normalizeFeatures(value: unknown) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function formatCurrency(value: unknown) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function readError(error: any) {
  const raw = String(error?.message || error || 'Erro inesperado.');
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (Array.isArray(parsed?.missing)) return `${parsed.message || 'Ficha incompleta'}: ${parsed.missing.join(', ')}.`;
      if (parsed?.message) return Array.isArray(parsed.message) ? parsed.message.join(', ') : parsed.message;
    } catch { /* mantém mensagem original */ }
  }
  return raw.replace(/^\d{3}:\s*/, '');
}
