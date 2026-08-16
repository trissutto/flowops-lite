export const CAMPAIGN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_id',
  'utm_term',
  'utm_content',
  'utm_adset',
] as const;

export type CampaignParam = (typeof CAMPAIGN_PARAMS)[number];

export function sanitizeCampaignParams(input: URLSearchParams): URLSearchParams {
  const safe = new URLSearchParams();
  for (const key of CAMPAIGN_PARAMS) {
    const value = input.get(key)?.trim();
    if (value) safe.set(key, value.slice(0, 200));
  }
  return safe;
}

export function isMetaCampaign(input: URLSearchParams): boolean {
  return input.get('utm_source')?.trim().toLowerCase() === 'meta';
}

export function withCampaignParams(destination: string, input: URLSearchParams): string {
  if (!destination.startsWith('/') || destination.startsWith('//')) return '/';

  const url = new URL(destination, 'https://www.lurdsplussize.com.br');
  const campaign = sanitizeCampaignParams(input);
  campaign.forEach((value, key) => url.searchParams.set(key, value));
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
}
