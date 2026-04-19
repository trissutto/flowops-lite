/**
 * Extrai "Origem" e "Source" dos meta_data de attribution do WooCommerce.
 * Usa os campos `_wc_order_attribution_*` (plugin nativo do WC desde 2024).
 */
export function extractAttribution(meta: any[]): { origem: string; source: string } {
  const get = (key: string): string | undefined => {
    const m = (meta ?? []).find((x) => x?.key === key);
    return m ? String(m.value ?? '') : undefined;
  };

  const sourceType = (get('_wc_order_attribution_source_type') ?? '').toLowerCase();
  const utmSource = get('_wc_order_attribution_utm_source');
  const utmMedium = get('_wc_order_attribution_utm_medium');
  const utmCampaign = get('_wc_order_attribution_utm_campaign');
  const referrer = get('_wc_order_attribution_referrer');

  const hostOf = (url?: string) => {
    if (!url) return '';
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return url; }
  };

  // Direto / Type-in
  if (!sourceType || sourceType === 'typein' || sourceType === 'direct') {
    return { origem: 'Direto', source: '(Direct) ()' };
  }

  // Orgânico
  if (sourceType === 'organic') {
    const src = utmSource || hostOf(referrer).split('.')[0] || 'search';
    return {
      origem: `Orgânico: ${src.charAt(0).toUpperCase() + src.slice(1)}`,
      source: `${utmSource || hostOf(referrer) || 'search'} (organic)`,
    };
  }

  // Referral
  if (sourceType === 'referral') {
    const host = hostOf(referrer);
    return {
      origem: `Encaminhamento: ${host}`,
      source: `${host} (${utmMedium || 'social'})`,
    };
  }

  // UTM / Paid
  if (sourceType === 'utm' && utmSource) {
    const campaign = utmCampaign ? `${utmCampaign}` : '';
    return {
      origem: campaign ? `Origem: ${campaign}` : `Origem: ${utmSource}`,
      source: `${utmSource}${utmMedium ? ` (${utmMedium})` : ''}`,
    };
  }

  // Admin / Mobile app
  if (sourceType === 'admin') return { origem: 'Origem: Admin', source: 'admin' };
  if (sourceType === 'mobile_app' || sourceType === 'app') {
    return { origem: 'Origem: App', source: `${utmSource || 'app'} (${utmMedium || 'referral'})` };
  }

  // Fallback com utmSource
  if (utmSource) {
    return {
      origem: `Origem: ${utmSource}`,
      source: `${utmSource} (${utmMedium || sourceType})`,
    };
  }

  return { origem: sourceType ? `Origem: ${sourceType}` : '—', source: sourceType || '—' };
}
