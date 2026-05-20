import { Controller, Get, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Endpoint público pra distribuir o app desktop pras lojas.
 *
 * Estratégia:
 *   - GET /api/desktop/latest    → JSON { version, downloadUrl, fileName, publishedAt }
 *   - GET /api/desktop/download  → 302 redirect direto pro .exe da última release
 *
 * Repo: github.com/trissutto/flowops-lite — releases públicos
 * O electron-updater nas máquinas das lojas usa esses mesmos releases.
 */
@Controller('desktop')
export class DesktopController {
  private readonly logger = new Logger(DesktopController.name);
  private readonly GITHUB_REPO = 'trissutto/flowops-lite';
  private readonly CACHE_MS = 5 * 60 * 1000; // 5 minutos
  private cache: { data: any; expiresAt: number } | null = null;

  /**
   * Busca info da última release do GitHub.
   * Cacheia 5min pra não estourar rate-limit (60 req/h sem token).
   */
  private async fetchLatestRelease(): Promise<{
    version: string;
    downloadUrl: string;
    fileName: string;
    publishedAt: string;
    sizeBytes: number;
  } | null> {
    // Cache hit
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.data;
    }
    try {
      const url = `https://api.github.com/repos/${this.GITHUB_REPO}/releases/latest`;
      const res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) {
        this.logger.warn(`GitHub API ${res.status} pra ${url}`);
        return null;
      }
      const json: any = await res.json();
      // Acha o asset .exe (instalador Windows)
      const exeAsset = (json.assets || []).find((a: any) =>
        String(a.name || '').toLowerCase().endsWith('.exe'),
      );
      if (!exeAsset) {
        this.logger.warn(`Release ${json.tag_name} sem asset .exe`);
        return null;
      }
      const data = {
        version: String(json.tag_name || '').replace(/^v/, ''),
        downloadUrl: exeAsset.browser_download_url,
        fileName: exeAsset.name,
        publishedAt: json.published_at,
        sizeBytes: exeAsset.size || 0,
      };
      this.cache = { data, expiresAt: Date.now() + this.CACHE_MS };
      return data;
    } catch (e: any) {
      this.logger.error(`Falha consultando GitHub: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * GET /api/desktop/latest
   * Retorna info da última versão pro frontend mostrar "Baixar v1.0.3".
   * Sem auth — informação pública.
   */
  @Get('latest')
  async getLatest() {
    const data = await this.fetchLatestRelease();
    if (!data) {
      return {
        available: false,
        version: null,
        downloadUrl: null,
        fileName: null,
        publishedAt: null,
        sizeBytes: 0,
        message: 'Última release não encontrada. Verifica em github.com/trissutto/flowops-lite/releases',
      };
    }
    return { available: true, ...data };
  }

  /**
   * GET /api/desktop/download
   * Redireciona direto pro .exe — útil pra distribuir link curto:
   *   "https://flowops-lite-production.up.railway.app/api/desktop/download"
   * Sempre aponta pra última versão. Sem auth.
   */
  @Get('download')
  async downloadLatest(@Res() res: Response) {
    const data = await this.fetchLatestRelease();
    if (!data) {
      return res.status(404).json({
        error: 'Última release indisponível. Tenta direto em github.com/trissutto/flowops-lite/releases',
      });
    }
    return res.redirect(302, data.downloadUrl);
  }
}
