import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideExternalLink,
  lucideRefreshCw,
  lucideTrash2,
  lucideUpload,
} from '@ng-icons/lucide';
import {
  BrandingService,
  BrandingSlot,
} from '../../../core/http/branding.service';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmBadge } from '../../../shared/ui/badge';
import { HlmButton } from '../../../shared/ui/button';
import { HlmConfirmDialog } from '../../../shared/ui/dialog';

// FileReader's data URL is "data:image/png;base64,iVBORw0KG..." — strip
// the prefix before sending so the BE just gets the raw base64 bytes.
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function formatTimestamp(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return '';
  const d = new Date(epoch * 1000);
  const date = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function formatSizeKb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return `${Math.round(bytes / 1000)} KB`;
}

interface SlotUiState {
  uploading: boolean;
  clearing: boolean;
  error: string | null;
  notice: string | null;
}

@Component({
  selector: 'branding-manager',
  imports: [
    CommonModule,
    HlmAlert,
    HlmBadge,
    HlmButton,
    HlmConfirmDialog,
    NgIcon,
  ],
  providers: [
    provideIcons({
      lucideUpload,
      lucideTrash2,
      lucideRefreshCw,
      lucideExternalLink,
    }),
  ],
  templateUrl: './branding-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandingManager implements OnInit {
  private brandingApi = inject(BrandingService);
  private destroyRef = inject(DestroyRef);

  @ViewChild('ogImageInput') ogImageInput?: ElementRef<HTMLInputElement>;
  @ViewChild('ogSquareInput') ogSquareInput?: ElementRef<HTMLInputElement>;
  @ViewChild('faviconInput') faviconInput?: ElementRef<HTMLInputElement>;

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly slots = signal<BrandingSlot[]>([]);
  private readonly slotStates = signal<Record<string, SlotUiState>>({
    'og-image': blankSlotState(),
    'og-image-square': blankSlotState(),
    favicon: blankSlotState(),
  });
  readonly pendingClear = signal<string | null>(null);

  // src= for each slot's preview <img>. Always points at the public
  // /branding/{filename} URL with a `?v=<hash>` cache-buster derived
  // from the active contentHash so an upload renders immediately. When
  // no custom is uploaded, the public URL 302s to the baked-in default
  // — same UX as the real Meta scraper sees in production.
  readonly previewUrls = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const slot of this.slots()) {
      const filename = filenameFor(slot.type);
      const hash = slot.active?.contentHash || `default-${slot.type}`;
      out[slot.type] = `/branding/${filename}?v=${encodeURIComponent(hash)}`;
    }
    return out;
  });

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.brandingApi
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.slots.set(res.assets ?? []);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.loadError.set(
            this.toMessage(err, 'No se pudo cargar las imágenes')
          );
        },
      });
  }

  stateFor(type: string): SlotUiState {
    return this.slotStates()[type] ?? blankSlotState();
  }

  active(type: string): BrandingSlot['active'] | null {
    return this.slots().find((s) => s.type === type)?.active ?? null;
  }

  slotByType(type: string): BrandingSlot | undefined {
    return this.slots().find((s) => s.type === type);
  }

  formatTimestamp = formatTimestamp;
  formatSizeKb = formatSizeKb;

  trackBySlot(_index: number, slot: BrandingSlot): string {
    return slot.type;
  }

  onFilePicked(type: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-uploading the same file
    if (!file) return;

    const slot = this.slotByType(type);
    if (!slot) return;

    if (!slot.allowedContentTypes.includes(file.type)) {
      this.updateSlotState(type, {
        error: `Formato no permitido. Permitidos: ${slot.allowedContentTypes.join(', ')}`,
        notice: null,
      });
      return;
    }
    if (file.size > slot.maxBytes) {
      const maxKb = Math.round(slot.maxBytes / 1000);
      this.updateSlotState(type, {
        error: `El archivo es muy grande (${Math.round(file.size / 1000)} KB). Máximo: ${maxKb} KB`,
        notice: null,
      });
      return;
    }

    this.updateSlotState(type, { uploading: true, error: null, notice: null });
    this.readFileAsBase64(file)
      .then((base64) => {
        this.brandingApi
          .upload(type, base64, file.type)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => {
              this.updateSlotState(type, {
                uploading: false,
                notice: 'Imagen actualizada',
                error: null,
              });
              this.refresh();
            },
            error: (err) => {
              this.updateSlotState(type, {
                uploading: false,
                notice: null,
                error: this.toMessage(err, 'No se pudo subir la imagen'),
              });
            },
          });
      })
      .catch(() => {
        this.updateSlotState(type, {
          uploading: false,
          error: 'No se pudo leer el archivo',
          notice: null,
        });
      });
  }

  requestClear(type: string): void {
    this.pendingClear.set(type);
  }

  cancelClear(): void {
    this.pendingClear.set(null);
  }

  confirmClear(): void {
    const type = this.pendingClear();
    if (!type) return;
    this.updateSlotState(type, { clearing: true, error: null, notice: null });
    this.brandingApi
      .clear(type)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.pendingClear.set(null);
          this.updateSlotState(type, {
            clearing: false,
            notice: 'Restaurada la imagen original',
            error: null,
          });
          this.refresh();
        },
        error: (err) => {
          this.pendingClear.set(null);
          this.updateSlotState(type, {
            clearing: false,
            notice: null,
            error: this.toMessage(err, 'No se pudo restaurar la imagen'),
          });
        },
      });
  }

  // Opens Meta's Sharing Debugger for the customer URL — staff click
  // "Scrape Again" there to force Meta to re-fetch the new OG image
  // immediately instead of waiting for cache expiry.
  openMetaDebugger(): void {
    if (typeof window === 'undefined') return;
    const url = encodeURIComponent('https://famosofuego.com/reserva');
    window.open(
      `https://developers.facebook.com/tools/debug/?q=${url}`,
      '_blank',
      'noopener,noreferrer'
    );
  }

  pendingClearLabel = computed<string | null>(() => {
    const t = this.pendingClear();
    if (!t) return null;
    const slot = this.slotByType(t);
    return slot ? `Restaurar la imagen original para: ${slot.description}` : null;
  });

  private updateSlotState(type: string, patch: Partial<SlotUiState>): void {
    this.slotStates.update((prev) => ({
      ...prev,
      [type]: { ...(prev[type] ?? blankSlotState()), ...patch },
    }));
  }

  private readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') return reject(new Error('Bad reader result'));
        resolve(stripDataUrlPrefix(result));
      };
      reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
      reader.readAsDataURL(file);
    });
  }

  private toMessage(err: unknown, fallback: string): string {
    const e = err as { error?: { message?: string }; message?: string } | null;
    return e?.error?.message || e?.message || fallback;
  }
}

function blankSlotState(): SlotUiState {
  return { uploading: false, clearing: false, error: null, notice: null };
}

function filenameFor(type: string): string {
  switch (type) {
    case 'og-image':
      return 'og-image.png';
    case 'og-image-square':
      return 'og-image-square.png';
    case 'favicon':
      return 'favicon.svg';
    default:
      return type;
  }
}
