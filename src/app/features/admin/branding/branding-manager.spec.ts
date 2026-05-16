import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { describe, beforeEach, it, expect, vi } from 'vitest';

import { BrandingService, BrandingSlot } from '../../../core/http/branding.service';
import { BrandingManager } from './branding-manager';

function slotFixture(type: BrandingSlot['type'], active = false): BrandingSlot {
  return {
    type,
    description: type,
    defaultStaticPath: `/${type}.png`,
    maxBytes: 300_000,
    allowedContentTypes:
      type === 'favicon' ? ['image/svg+xml'] : ['image/png', 'image/jpeg', 'image/webp'],
    active: active
      ? {
          type,
          contentType: 'image/png',
          sizeBytes: 50_000,
          contentHash: 'abc1234567890def',
          updatedAt: 1_700_000_000,
          updatedBy: 'aleks',
        }
      : null,
  };
}

function defaultListResponse() {
  return {
    assets: [
      slotFixture('og-image'),
      slotFixture('og-image-square'),
      slotFixture('favicon'),
    ],
  };
}

function tick(ms = 60) {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

describe('BrandingManager', () => {
  let fixture: ComponentFixture<BrandingManager>;
  let cmp: BrandingManager;
  let listSpy: ReturnType<typeof vi.fn>;
  let uploadSpy: ReturnType<typeof vi.fn>;
  let clearSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    listSpy = vi.fn().mockReturnValue(of(defaultListResponse()));
    uploadSpy = vi
      .fn()
      .mockReturnValue(of({ asset: { contentHash: 'new', sizeBytes: 1, updatedAt: 1, updatedBy: 'me', contentType: 'image/png', type: 'og-image' } }));
    clearSpy = vi.fn().mockReturnValue(of({ type: 'og-image', cleared: true }));

    await TestBed.configureTestingModule({
      imports: [BrandingManager],
      providers: [
        {
          provide: BrandingService,
          useValue: { list: listSpy, upload: uploadSpy, clear: clearSpy },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(BrandingManager);
    cmp = fixture.componentInstance;
  });

  it('loads slots on init', () => {
    fixture.detectChanges();
    expect(listSpy).toHaveBeenCalled();
    expect(cmp.slots().length).toBe(3);
  });

  it('renders a load error when /admin/branding fails', () => {
    listSpy.mockReturnValueOnce(throwError(() => ({ error: { message: 'boom' } })));
    fixture.detectChanges();
    expect(cmp.loadError()).toBe('boom');
  });

  it('rejects files of disallowed content type before posting', () => {
    fixture.detectChanges();
    const file = new File(['x'], 'evil.exe', { type: 'application/octet-stream' });
    const evt = { target: { files: [file], value: 'evil.exe' } } as unknown as Event;
    cmp.onFilePicked('og-image', evt);
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(cmp.stateFor('og-image').error).toMatch(/no permitido/i);
  });

  it('rejects files larger than the per-type max size before posting', () => {
    fixture.detectChanges();
    const big = new Uint8Array(400_000);
    const file = new File([big], 'big.png', { type: 'image/png' });
    const evt = { target: { files: [file], value: 'big.png' } } as unknown as Event;
    cmp.onFilePicked('og-image', evt);
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(cmp.stateFor('og-image').error).toMatch(/muy grande/i);
  });

  it('uploads a valid file as base64 and re-fetches the list on success', async () => {
    fixture.detectChanges();
    listSpy.mockClear();
    listSpy.mockReturnValue(
      of({
        assets: [
          slotFixture('og-image', true),
          slotFixture('og-image-square'),
          slotFixture('favicon'),
        ],
      })
    );

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'small.png', { type: 'image/png' });
    const evt = { target: { files: [file], value: 'small.png' } } as unknown as Event;
    cmp.onFilePicked('og-image', evt);

    await tick(50);
    expect(uploadSpy).toHaveBeenCalledWith('og-image', expect.any(String), 'image/png');
    const [, sentData] = uploadSpy.mock.calls[0];
    expect(sentData).not.toContain('data:'); // prefix stripped
    expect(listSpy).toHaveBeenCalled();
    expect(cmp.stateFor('og-image').notice).toBe('Imagen actualizada');
  });

  it('clear flow: requestClear → confirmClear posts DELETE and refreshes', () => {
    fixture.detectChanges();
    cmp.requestClear('og-image');
    expect(cmp.pendingClear()).toBe('og-image');
    listSpy.mockClear();

    cmp.confirmClear();
    expect(clearSpy).toHaveBeenCalledWith('og-image');
    expect(cmp.pendingClear()).toBe(null);
    expect(cmp.stateFor('og-image').notice).toBe('Restaurada la imagen original');
    expect(listSpy).toHaveBeenCalled();
  });

  it('cancelClear clears the pending state without DELETE', () => {
    fixture.detectChanges();
    cmp.requestClear('og-image-square');
    cmp.cancelClear();
    expect(cmp.pendingClear()).toBe(null);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('previewUrls include the active contentHash as cache-buster', () => {
    listSpy.mockReturnValue(
      of({
        assets: [
          slotFixture('og-image', true),
          slotFixture('og-image-square'),
          slotFixture('favicon'),
        ],
      })
    );
    fixture.detectChanges();
    const urls = cmp.previewUrls();
    expect(urls['og-image']).toBe('/branding/og-image.png?v=abc1234567890def');
    // No active asset → falls back to "default-{type}" sentinel
    expect(urls['favicon']).toBe('/branding/favicon.svg?v=default-favicon');
  });

  it('surfaces server error message on upload failure', async () => {
    fixture.detectChanges();
    uploadSpy.mockReturnValueOnce(throwError(() => ({ error: { message: 'Bad image' } })));

    const file = new File([new Uint8Array([1, 2])], 'tiny.png', { type: 'image/png' });
    const evt = { target: { files: [file], value: 'tiny.png' } } as unknown as Event;
    cmp.onFilePicked('og-image', evt);

    await tick(50);
    expect(cmp.stateFor('og-image').error).toBe('Bad image');
  });

  it('openMetaDebugger opens the Sharing Debugger pre-filled with /reserva', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null as any);
    cmp.openMetaDebugger();
    expect(open).toHaveBeenCalledWith(
      'https://developers.facebook.com/tools/debug/?q=https%3A%2F%2Ffamosofuego.com%2Freserva',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
