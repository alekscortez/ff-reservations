import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style avatar primitive family. Renders a rounded image with a
 * fallback (initials / icon) when the image is missing or fails to load.
 *
 * @example
 *   <hlm-avatar>
 *     @if (photoUrl(); as src) {
 *       <img hlmAvatarImage [src]="src" [alt]="name()" />
 *     }
 *     <span hlmAvatarFallback>{{ initials() }}</span>
 *   </hlm-avatar>
 *
 * Compose with the image + fallback directives:
 *   - `HlmAvatarImage` tracks `load` / `error` and toggles the parent's
 *     `imageLoaded` signal. Hides itself until loaded.
 *   - `HlmAvatarFallback` is visible by default and hides once
 *     `imageLoaded` is true. Render it unconditionally — when there's no
 *     image source, just omit the `<img>` via `@if` and the fallback stays.
 *
 * Default shape is `rounded-full`. Override with `class="rounded-lg"` for
 * a squared tile (e.g. sidebar user chip) — tailwind-merge resolves the
 * conflict in the consumer's favor.
 */
export const avatarVariants = cva(
  'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-100',
  {
    variants: {
      size: {
        sm: 'size-6 text-[10px]',
        default: 'size-8 text-sm',
        lg: 'size-10 text-base',
      },
    },
    defaultVariants: { size: 'default' },
  },
);
export type AvatarVariants = VariantProps<typeof avatarVariants>;

@Component({
  selector: 'hlm-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content></ng-content>',
  host: { 'data-slot': 'avatar' },
})
export class HlmAvatar {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly size = input<AvatarVariants['size']>('default');

  /**
   * Public state — `HlmAvatarImage` flips this to `true` on successful
   * `load`, back to `false` on `error`. `HlmAvatarFallback` reads it to
   * decide whether to hide itself. Public so consumers can also react
   * (e.g. log a metric on image error) if they ever need to.
   */
  readonly imageLoaded = signal(false);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      const host = this.el.nativeElement;
      if (this.consumerClasses === null) {
        this.consumerClasses = host.getAttribute('class') ?? '';
      }
      host.setAttribute(
        'class',
        twMerge(avatarVariants({ size: this.size() }), this.consumerClasses),
      );
    });
  }
}
