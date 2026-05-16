import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client';

// Mirror of the BE per-type slot. `active === null` means no admin upload
// has happened — the public /branding/{filename} route 302s to the baked-in
// default (so the page still shows a real image).
export interface BrandingSlot {
  type: 'og-image' | 'og-image-square' | 'favicon';
  description: string;
  defaultStaticPath: string;
  maxBytes: number;
  allowedContentTypes: string[];
  active: BrandingAsset | null;
}

export interface BrandingAsset {
  type: string;
  contentType: string;
  sizeBytes: number;
  // 16-char sha256 prefix — used as the cache-buster on `<img>` src so
  // a fresh upload renders immediately instead of showing the stale
  // browser-cached copy.
  contentHash: string;
  updatedAt: number;
  updatedBy: string;
}

export interface BrandingListResponse {
  assets: BrandingSlot[];
}

@Injectable({ providedIn: 'root' })
export class BrandingService {
  private api = inject(ApiClient);

  list() {
    return this.api.get<BrandingListResponse>('/admin/branding');
  }

  upload(type: string, data: string, contentType: string) {
    // `data` is base64-encoded payload (FileReader's data URL minus the
    // "data:image/png;base64," prefix). Server caps size + content type.
    return this.api.post<{ asset: BrandingAsset }>(
      `/admin/branding/${encodeURIComponent(type)}`,
      { data, contentType }
    );
  }

  clear(type: string) {
    return this.api.delete<{ type: string; cleared: boolean }>(
      `/admin/branding/${encodeURIComponent(type)}`
    );
  }
}
