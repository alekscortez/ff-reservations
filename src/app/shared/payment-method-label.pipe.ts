import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'paymentMethodLabel',
  standalone: true,
})
export class PaymentMethodLabelPipe implements PipeTransform {
  transform(value: unknown): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '—';
    const normalized = raw.toLowerCase();
    if (normalized === 'cash') return 'Cash';
    if (normalized === 'cashapp') return 'Cash App Pay';
    if (normalized === 'square') return 'Square';
    if (normalized === 'credit') return 'Reservation Credit';

    return normalized
      .replace(/[_-]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
}
