import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toDataURL } from 'qrcode';
import { ApiError } from '@/lib/api-client';
import { usePassPreview } from '@/lib/api/check-in-pass';

function formatEventDate(value: string | null | undefined, locale: string) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parsed = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusLabel(status: string | null | undefined, t: (k: string) => string) {
  const upper = String(status ?? '').trim().toUpperCase();
  switch (upper) {
    case 'ACTIVE':
      return t('checkInPassPage.status.active');
    case 'CONSUMED':
      return t('checkInPassPage.status.consumed');
    case 'EXPIRED':
      return t('checkInPassPage.status.expired');
    case 'REVOKED':
      return t('checkInPassPage.status.revoked');
    default:
      return upper || '—';
  }
}

export function CheckInPassPage() {
  const { t, i18n } = useTranslation();
  const [search] = useSearchParams();
  const token = (search.get('token') ?? '').trim();
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState<string | null>(null);

  const { data: pass, isLoading, error } = usePassPreview(token);

  useEffect(() => {
    let cancelled = false;
    setQrError(null);
    setQrDataUrl('');
    if (!token) return;
    const payload = `ffr-checkin:${token}`;
    void toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, scale: 8 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) setQrError(err?.message ?? 'QR error');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <main className="grid min-h-screen w-full place-content-center px-4 py-8">
        <article className="max-w-md rounded-2xl border border-danger-200 bg-danger-100/40 p-6">
          <h1 className="text-xl font-semibold text-danger-700">
            {t('checkInPassPage.invalidTitle')}
          </h1>
          <p className="mt-2 text-sm text-danger-700">{t('checkInPassPage.invalidBody')}</p>
        </article>
      </main>
    );
  }

  const apiError = error instanceof ApiError ? error : null;
  const checkCode = token.slice(-8).toUpperCase();
  const guestName = pass?.customerName?.trim() || t('checkInPassPage.guestFallback');
  const tableLabel = pass?.tableId?.trim() || '—';
  const dateLabel = formatEventDate(pass?.eventDate, i18n.language) || t('checkInPassPage.eventFallback');

  return (
    <main className="min-h-screen w-full bg-black px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-center text-3xl font-black tracking-wide">
          {t('checkInPassPage.heading')}
        </h1>
        <p className="mt-1 text-center text-sm text-white/80">{t('checkInPassPage.subheading')}</p>

        {isLoading ? (
          <p className="mt-6 text-center text-sm text-white/70">{t('common.loading')}</p>
        ) : apiError ? (
          <article className="mt-6 rounded-2xl border border-danger-200 bg-danger-100/40 p-6">
            <h2 className="text-lg font-semibold text-danger-700">
              {apiError.status === 404
                ? t('checkInPassPage.notFoundTitle')
                : t('checkInPassPage.errorTitle')}
            </h2>
            <p className="mt-2 text-sm text-danger-700">
              {apiError.status === 404
                ? t('checkInPassPage.notFoundBody')
                : `${apiError.status}: ${apiError.message}`}
            </p>
          </article>
        ) : pass ? (
          <article className="relative mt-5 overflow-hidden rounded-3xl bg-white text-black shadow-2xl">
            <div className="p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <p className="text-2xl font-black tracking-wide text-brand-900">
                  Famoso Fuego
                </p>
                <div className="text-right">
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-black/50">
                    {t('checkInPassPage.checkCode')}
                  </p>
                  <p className="text-xl font-extrabold leading-none">{checkCode}</p>
                </div>
              </div>

              <div className="mt-4 flex justify-center">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Check-in QR code"
                    className="h-72 w-72 rounded-lg border border-black/10 bg-white p-2"
                  />
                ) : (
                  <p className="mt-2 text-center text-xs text-danger-700">
                    {qrError || t('checkInPassPage.qrUnavailable')}
                  </p>
                )}
              </div>

              <div className="mt-4">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-black/50">
                  {t('checkInPassPage.guestLabel')}
                </p>
                <p className="text-3xl font-black leading-tight">{guestName}</p>
                <p className="mt-3 text-[11px] font-semibold tracking-[0.14em] text-black/50">
                  {t('checkInPassPage.eventLabel')}
                </p>
                <p className="text-lg font-extrabold">{dateLabel}</p>
              </div>
            </div>

            <div className="relative border-t-2 border-dashed border-black/20 px-5 py-5 sm:px-6">
              <span className="absolute -left-4 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full bg-black"></span>
              <span className="absolute -right-4 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full bg-black"></span>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-black/50">
                    {t('checkInPassPage.statusLabel')}
                  </p>
                  <p className="text-3xl font-black uppercase leading-none">
                    {statusLabel(pass.status, t)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-black/50">
                    {t('checkInPassPage.tableLabel')}
                  </p>
                  <p className="text-5xl font-black leading-none">{tableLabel}</p>
                </div>
              </div>
              <p className="mt-4 text-center text-xs text-black/60">
                {t('checkInPassPage.contactNote')}
              </p>
            </div>
          </article>
        ) : null}
      </div>
    </main>
  );
}
