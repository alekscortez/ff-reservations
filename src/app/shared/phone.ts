export type PhoneCountry = 'US' | 'MX';

const SUPPORTED_COUNTRIES: PhoneCountry[] = ['US', 'MX'];

export function normalizePhoneCountry(country: string | null | undefined): PhoneCountry {
  const value = String(country ?? '')
    .trim()
    .toUpperCase() as PhoneCountry;
  return SUPPORTED_COUNTRIES.includes(value) ? value : 'US';
}

function parseInternationalDigitsToE164(digitsOnly: string): string {
  const digits = String(digitsOnly ?? '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('1')) {
    const national = digits.slice(1);
    if (national.length === 10) return `+1${national}`;
    return '';
  }

  if (digits.startsWith('52')) {
    const national = digits.slice(2);
    if (national.length === 10) return `+52${national}`;
    if (national.length === 11 && national.startsWith('1')) return `+52${national.slice(1)}`;
    return '';
  }

  return '';
}

function parseNationalDigitsToE164(digitsOnly: string, countryHint: PhoneCountry): string {
  const digits = String(digitsOnly ?? '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith('52')) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith('521')) return `+52${digits.slice(3)}`;

  if (digits.length !== 10) return '';
  return countryHint === 'MX' ? `+52${digits}` : `+1${digits}`;
}

export function normalizePhoneToE164(
  phone: string | null | undefined,
  countryHint: PhoneCountry = 'US'
): string {
  const raw = String(phone ?? '').trim();
  if (!raw) return '';

  let cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;

  if (cleaned.startsWith('+')) {
    return parseInternationalDigitsToE164(cleaned.slice(1));
  }

  return parseNationalDigitsToE164(cleaned, normalizePhoneCountry(countryHint));
}

export function normalizePhoneToDigits(
  phone: string | null | undefined,
  countryHint: PhoneCountry = 'US'
): string {
  const e164 = normalizePhoneToE164(phone, countryHint);
  return e164 ? e164.replace(/\D/g, '') : '';
}

export function inferPhoneCountryFromE164(
  phone: string | null | undefined
): PhoneCountry | null {
  const e164 = normalizePhoneToE164(phone, 'US');
  if (e164.startsWith('+52')) return 'MX';
  if (e164.startsWith('+1')) return 'US';
  return null;
}
