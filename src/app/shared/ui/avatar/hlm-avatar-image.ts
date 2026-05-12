import { Directive, ElementRef, HostListener, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

import { HlmAvatar } from './hlm-avatar';

/**
 * `<img>` slot for `<hlm-avatar>`. Hides itself until a real `load`
 * event fires; if the image fails to load (404, network error, decode
 * error), it stays hidden so the fallback remains visible.
 *
 * If the binding source is null/undefined, omit the `<img>` entirely
 * via `@if` in the template rather than binding an empty `src` — browsers
 * are inconsistent about whether an empty/missing `src` fires `error`,
 * and this directive only knows to mark `imageLoaded=false` after an
 * explicit `error` event.
 *
 * @example
 *   <hlm-avatar>
 *     @if (photoUrl(); as src) {
 *       <img hlmAvatarImage [src]="src" [alt]="name()" />
 *     }
 *     <span hlmAvatarFallback>{{ initials() }}</span>
 *   </hlm-avatar>
 */
@Directive({
  selector: 'img[hlmAvatarImage]',
  exportAs: 'hlmAvatarImage',
  standalone: true,
  host: {
    'data-slot': 'avatar-image',
    '[attr.hidden]': '!parent.imageLoaded() ? "" : null',
  },
})
export class HlmAvatarImage {
  private readonly el = inject<ElementRef<HTMLImageElement>>(ElementRef);
  protected readonly parent = inject(HlmAvatar);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      const host = this.el.nativeElement;
      if (this.consumerClasses === null) {
        this.consumerClasses = host.getAttribute('class') ?? '';
      }
      host.setAttribute(
        'class',
        twMerge('absolute inset-0 size-full object-cover', this.consumerClasses),
      );
    });
  }

  @HostListener('load')
  onLoad(): void {
    this.parent.imageLoaded.set(true);
  }

  @HostListener('error')
  onError(): void {
    this.parent.imageLoaded.set(false);
  }
}
