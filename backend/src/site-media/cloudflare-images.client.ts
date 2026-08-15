import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type CloudflareEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

export type DirectUploadResult = { id: string; uploadURL: string };
export type CloudflareImage = {
  id: string;
  filename?: string;
  uploaded?: string;
  requireSignedURLs?: boolean;
  variants?: string[];
  meta?: Record<string, unknown>;
};

@Injectable()
export class CloudflareImagesClient {
  constructor(private readonly config: ConfigService) {}

  private credentials() {
    const accountId = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID')?.trim();
    const token = this.config.get<string>('CLOUDFLARE_IMAGES_TOKEN')?.trim();
    if (!accountId || !token) {
      throw new ServiceUnavailableException('Cloudflare Images não configurado');
    }
    return { accountId, token };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { accountId, token } = this.credentials();
    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/images/v1${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.headers || {}),
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new BadGatewayException('Cloudflare Images indisponível');
    }

    const body = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
    if (!response.ok || !body?.success || body.result == null) {
      const reason = body?.errors?.map((error) => error.message).filter(Boolean).join('; ');
      throw new BadGatewayException(reason || 'Cloudflare Images recusou a operação');
    }
    return body.result;
  }

  createDirectUpload(metadata: Record<string, string>, expiresAt: Date) {
    const form = new FormData();
    form.set('requireSignedURLs', 'false');
    form.set('metadata', JSON.stringify(metadata));
    form.set('expiry', expiresAt.toISOString());
    return this.request<DirectUploadResult>('/direct_upload', { method: 'POST', body: form });
  }

  get(id: string) {
    return this.request<CloudflareImage>(`/${encodeURIComponent(id)}`);
  }

  delete(id: string) {
    return this.request<Record<string, never>>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
