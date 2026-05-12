import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

import { HlmAvatar } from './hlm-avatar';

/**
 * Content shown inside `<hlm-avatar>` when no image is rendered, or while
 * the image is still loading. Typically holds initials, an icon, or a
 * placeholder character. Auto-hides once the sibling
 * `<img hlmAvatarImage>` fires its `load` event.
 *
 * @example
 *   <span hlmAvatarFallback>{{ initials() }}</span>
 *   <span hlmAvatarFallback><ng-icon name="lucideCircleUser" /></span>
 */
@Directive({
  selector: 'span[hlmAvatarFallback], [hlmAvatarFallback]',
  exportAs: 'hlmAvatarFallback',
  standalone: true,
  host: {
    'data-slot': 'avatar-fallback',
    '[attr.hidden]': 'parent.imageLoaded() ? "" : null',
  },
})
export class HlmAvatarFallback {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
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
        twMerge(
          'absolute inset-0 flex size-full items-center justify-center font-semibold leading-none',
          this.consumerClasses,
        ),
      );
    });
  }
}
