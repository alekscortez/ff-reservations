import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronsUpDown } from '@ng-icons/lucide';
import { HlmMenu, HlmMenuItem, HlmMenuTrigger } from '../dropdown-menu';

export type PhoneCountryCode = 'US' | 'MX';

interface PhoneCountryOption {
  readonly code: PhoneCountryCode;
  readonly flag: string;
  readonly dial: string;
  readonly name: string;
}

/**
 * Minimal country-code prefix for international phone inputs. Renders
 * a flag + chevron button inside the same visual border as the phone
 * <input>; tapping opens a dropdown of the two supported countries.
 * Replaces the two-pill US/MX toggle that wasted a row of vertical
 * space when the country rarely changes.
 *
 * @example
 *   <div class="flex h-14 items-stretch overflow-hidden rounded-lg border border-input bg-background focus-within:border-ring transition-colors">
 *     <hlm-phone-country-prefix
 *       [country]="phoneCountry"
 *       [disabled]="loading"
 *       (countryChange)="onPhoneCountryChanged($event)"
 *     />
 *     <div aria-hidden="true" class="w-px self-stretch bg-input"></div>
 *     <input
 *       type="tel"
 *       hlmInput size="xl"
 *       class="rounded-none border-0 bg-transparent focus:border-transparent"
 *       formControlName="phone"
 *       inputmode="tel"
 *       autocomplete="tel-national"
 *     />
 *   </div>
 *
 * Flags come from HatScripts/circle-flags (MIT) — pre-masked circular
 * SVGs at src/assets/flags/{cc}.svg. Two countries hard-coded for
 * now since FF Reservations only serves US + MX numbers; extending
 * to a full list later means adding rows to OPTIONS + bumping the
 * type union (or accepting a `[countries]` input).
 *
 * Behavior:
 * - The button renders inside a parent wrapper that owns the border
 *   + focus ring (focus-within); the button itself has no border so
 *   the input flows visually past it with just a 1px divider.
 * - Selecting the already-active country is a no-op (no event).
 * - HlmMenuTrigger / HlmMenuItem (CDK menu) handle Esc, outside-tap,
 *   arrow nav, and auto-close on item click.
 */
@Component({
  selector: 'hlm-phone-country-prefix',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgIcon, HlmMenu, HlmMenuItem, HlmMenuTrigger],
  providers: [provideIcons({ lucideCheck, lucideChevronsUpDown })],
  template: `
    <button
      type="button"
      [hlmMenuTriggerFor]="countryMenu"
      [disabled]="disabled()"
      class="inline-flex h-full shrink-0 items-center gap-2 px-3 text-sm font-medium text-brand-900 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
      [attr.aria-label]="'Country code — currently ' + currentOption().name"
    >
      <img
        [src]="currentOption().flag"
        class="size-5 shrink-0 rounded-full"
        alt=""
        aria-hidden="true"
      />
      <ng-icon
        name="lucideChevronsUpDown"
        size="14"
        class="shrink-0 text-brand-400"
        aria-hidden="true"
      />
    </button>

    <ng-template #countryMenu>
      <div hlmMenu class="min-w-[15rem]">
        <button
          *ngFor="let opt of OPTIONS; trackBy: trackByCode"
          type="button"
          hlmMenuItem
          (click)="select(opt.code)"
        >
          <img
            [src]="opt.flag"
            class="size-5 shrink-0 rounded-full"
            alt=""
            aria-hidden="true"
          />
          <span class="w-10 font-semibold tabular-nums text-brand-900">{{ opt.dial }}</span>
          <span class="flex-1 truncate text-brand-700">{{ opt.name }}</span>
          <ng-icon
            *ngIf="opt.code === country()"
            name="lucideCheck"
            size="14"
            class="shrink-0 text-brand-600"
            aria-hidden="true"
          />
        </button>
      </div>
    </ng-template>
  `,
})
export class HlmPhoneCountryPrefix {
  public readonly country = input<PhoneCountryCode>('US');
  public readonly disabled = input<boolean>(false);
  public readonly countryChange = output<PhoneCountryCode>();

  // Public for the template's *ngFor — kept readonly so consumers
  // can't mutate the row list at runtime.
  protected readonly OPTIONS: readonly PhoneCountryOption[] = [
    { code: 'US', flag: 'assets/flags/us.svg', dial: '+1', name: 'United States' },
    { code: 'MX', flag: 'assets/flags/mx.svg', dial: '+52', name: 'Mexico' },
  ];

  protected readonly currentOption = computed<PhoneCountryOption>(
    () => this.OPTIONS.find((o) => o.code === this.country()) ?? this.OPTIONS[0],
  );

  protected trackByCode(_index: number, opt: PhoneCountryOption): string {
    return opt.code;
  }

  protected select(code: PhoneCountryCode): void {
    if (this.disabled()) return;
    if (code === this.country()) return;
    this.countryChange.emit(code);
  }
}
