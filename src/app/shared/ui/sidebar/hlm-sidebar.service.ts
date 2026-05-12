import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  Signal,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';

const MOBILE_BREAKPOINT_PX = 768;
const COOKIE_NAME = 'ff-sidebar-state';
const KEYBOARD_KEY = 'b';

/**
 * Shared, app-wide state for the sidebar shell:
 *
 *   - `open`         — desktop expanded vs collapsed (persisted in a cookie)
 *   - `openMobile`   — mobile slide-over visible vs hidden (not persisted)
 *   - `isMobile`     — true when viewport ≤ 768px (drives which surface
 *                      `toggle()` mutates and which the trigger renders)
 *
 * `toggle()` is dispatched by every `hlmSidebarTrigger` and by the
 * Cmd/Ctrl+B keyboard shortcut. The service auto-installs the matchMedia
 * + keydown listeners on first render and tears them down on destroy.
 *
 * Cookie persistence is intentionally cookie (not localStorage) so a
 * server-rendered shell could read it during SSR. We're SPA-only today
 * but the pattern leaves the door open.
 */
@Injectable({ providedIn: 'root' })
export class HlmSidebarService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  private readonly openSignal = signal<boolean>(this.readPersistedOpen());
  private readonly openMobileSignal = signal<boolean>(false);
  private readonly isMobileSignal = signal<boolean>(false);

  readonly open: Signal<boolean> = this.openSignal.asReadonly();
  readonly openMobile: Signal<boolean> = this.openMobileSignal.asReadonly();
  readonly isMobile: Signal<boolean> = this.isMobileSignal.asReadonly();

  readonly state: Signal<'expanded' | 'collapsed'> = computed(() =>
    this.openSignal() ? 'expanded' : 'collapsed',
  );

  constructor() {
    afterNextRender(() => {
      if (!isPlatformBrowser(this.platformId)) return;
      const window = this.document.defaultView;
      if (!window) return;

      const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
      this.isMobileSignal.set(media.matches);
      const onMediaChange = (e: MediaQueryListEvent) => {
        this.isMobileSignal.set(e.matches);
        if (!e.matches) this.openMobileSignal.set(false);
      };
      media.addEventListener('change', onMediaChange);

      const onKeydown = (event: KeyboardEvent) => {
        if (event.key !== KEYBOARD_KEY) return;
        if (!(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        this.toggle();
      };
      window.addEventListener('keydown', onKeydown);

      this.destroyRef.onDestroy(() => {
        media.removeEventListener('change', onMediaChange);
        window.removeEventListener('keydown', onKeydown);
      });
    });
  }

  toggle(): void {
    if (this.isMobileSignal()) {
      this.openMobileSignal.update((v) => !v);
      return;
    }
    this.setOpen(!this.openSignal());
  }

  setOpen(open: boolean): void {
    this.openSignal.set(open);
    this.persistOpen(open);
  }

  setOpenMobile(open: boolean): void {
    this.openMobileSignal.set(open);
  }

  private readPersistedOpen(): boolean {
    if (!isPlatformBrowser(this.platformId)) return true;
    const cookie = this.document.cookie ?? '';
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    if (!match) return true;
    return match[1] === '1';
  }

  private persistOpen(open: boolean): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const oneYear = 60 * 60 * 24 * 365;
    this.document.cookie = `${COOKIE_NAME}=${open ? '1' : '0'}; path=/; max-age=${oneYear}; SameSite=Lax`;
  }
}
