import { Pipe, PipeTransform } from '@angular/core';
import { inferPhoneCountryFromE164, normalizePhoneToE164 } from './phone';

@Pipe({
  name: 'phoneDisplay',
  standalone: true,
})
export class PhoneDisplayPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '—';

    const country = inferPhoneCountryFromE164(raw) ?? 'US';
    const e164 = normalizePhoneToE164(raw, country);
    if (!e164) return raw;

    const digits = e164.replace(/\D/g, '');
    if (e164.startsWith('+1') && digits.length === 11) {
      const n = digits.slice(1);
      return `+1 (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
    }
    if (e164.startsWith('+52') && digits.length === 12) {
      const n = digits.slice(2);
      return `+52 (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
    }

    return e164;
  }
}
