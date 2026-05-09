import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { ApiError } from '@/lib/api-client';
import {
  useVerifyCheckInPass,
  type CheckInResult,
  type CheckInResultCode,
} from '@/lib/api/check-in';

const RESULT_TONE: Record<CheckInResultCode, string> = {
  CHECKED_IN: 'border-success-200 bg-success-100/40 text-success-700',
  ALREADY_USED: 'border-accent bg-accent/30 text-accent-foreground',
  EXPIRED: 'border-danger-200 bg-danger-100/40 text-danger-700',
  REVOKED: 'border-danger-200 bg-danger-100/40 text-danger-700',
  INVALID_TOKEN: 'border-danger-200 bg-danger-100/40 text-danger-700',
};

function extractToken(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const prefix = 'ffr-checkin:';
  if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery) return fromQuery.trim();
  } catch {
    // Not a URL — fall through.
  }
  return trimmed;
}

function hasScannerSupport(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export function StaffCheckIn() {
  const { t } = useTranslation();
  const verify = useVerifyCheckInPass();
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserQRCodeReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastTokenRef = useRef<{ token: string; at: number }>({ token: '', at: 0 });

  const [scannerActive, setScannerActive] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [manualToken, setManualToken] = useState('');
  const [result, setResult] = useState<CheckInResult | null>(null);
  const supported = hasScannerSupport();

  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  function stopScanner() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScannerActive(false);
  }

  async function startScanner() {
    if (!supported || scannerActive) return;
    setScannerError(null);
    setResult(null);
    if (!videoRef.current) {
      setScannerError(t('checkIn.cameraNotReady'));
      return;
    }
    try {
      readerRef.current ??= new BrowserQRCodeReader();
      const constraints: MediaStreamConstraints = {
        video: { facingMode: { ideal: facing } },
      };
      const controls = await readerRef.current.decodeFromConstraints(
        constraints,
        videoRef.current,
        (decoded, err) => {
          if (decoded) {
            const token = extractToken(decoded.getText());
            const now = Date.now();
            if (
              token &&
              (token !== lastTokenRef.current.token ||
                now - lastTokenRef.current.at > 5000)
            ) {
              lastTokenRef.current = { token, at: now };
              void runVerify(token, true);
            }
          }
          // err on each frame is normal (no decode); ignore.
          void err;
        }
      );
      controlsRef.current = controls;
      setScannerActive(true);
    } catch (err) {
      setScannerError(err instanceof Error ? err.message : t('checkIn.cameraError'));
      setScannerActive(false);
    }
  }

  async function runVerify(token: string, fromCamera: boolean) {
    const parsed = extractToken(token);
    if (!parsed) {
      setResult({
        ok: false,
        code: 'INVALID_TOKEN',
        message: t('checkIn.noToken'),
      });
      return;
    }
    try {
      const res = await verify.mutateAsync({
        token: parsed,
        scannerDevice: fromCamera ? 'staff-web-camera' : 'staff-web-manual',
      });
      setResult(res);
      if (res.ok && fromCamera) stopScanner();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setResult({
        ok: false,
        code: 'INVALID_TOKEN',
        message: apiErr ? `${apiErr.status}: ${apiErr.message}` : t('common.error'),
      });
    }
  }

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    void runVerify(manualToken, false);
    setManualToken('');
  }

  function flipCamera() {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    if (scannerActive) {
      stopScanner();
      setTimeout(() => void startScanner(), 100);
    }
  }

  return (
    <div className="p-6 sm:p-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <header>
          <h1 className="text-3xl font-semibold text-brand-900">{t('checkIn.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('checkIn.subtitle')}</p>
        </header>

        <section className="rounded-lg border border-border bg-background p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('checkIn.scannerHeading')}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void startScanner()}
              disabled={!supported || scannerActive}
              className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {t('checkIn.startCamera')}
            </button>
            <button
              type="button"
              onClick={stopScanner}
              disabled={!scannerActive}
              className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium text-brand-900 hover:bg-muted disabled:opacity-50"
            >
              {t('checkIn.stop')}
            </button>
            <button
              type="button"
              onClick={flipCamera}
              disabled={!supported}
              className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium text-brand-900 hover:bg-muted disabled:opacity-50"
            >
              {t('checkIn.flipCamera')}
            </button>
            <span
              className={`rounded-full border px-2 py-1 text-xs font-semibold ${
                scannerActive
                  ? 'border-success-200 bg-success-100 text-success-700'
                  : 'border-border bg-background text-muted-foreground'
              }`}
            >
              {scannerActive ? t('checkIn.cameraActive') : t('checkIn.cameraOff')}
            </span>
          </div>

          {!supported && (
            <p className="mt-2 text-xs text-muted-foreground">{t('checkIn.notSupported')}</p>
          )}
          {scannerError && (
            <p className="mt-2 text-xs text-destructive">{scannerError}</p>
          )}

          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-black">
            <video
              ref={videoRef}
              className="h-56 w-full object-cover sm:h-72"
              playsInline
              muted
            />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-background p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('checkIn.manualHeading')}
          </h2>
          <form onSubmit={handleManualSubmit} className="mt-3 flex gap-2">
            <input
              type="text"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              placeholder={t('checkIn.manualPlaceholder')}
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
            <button
              type="submit"
              disabled={!manualToken.trim() || verify.isPending}
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {verify.isPending ? t('common.saving') : t('checkIn.verify')}
            </button>
          </form>
        </section>

        {result && (
          <section className={`rounded-lg border-2 p-4 text-sm ${RESULT_TONE[result.code]}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border bg-background/40 px-2 py-0.5 text-xs font-semibold">
                {result.code}
              </span>
              <span className="font-semibold">{result.message}</span>
            </div>
            {result.reservation && (
              <p className="mt-2 text-xs">
                {result.reservation.customerName ?? '—'} ·{' '}
                {t('reservations.tableShort')} {result.reservation.tableId ?? '—'} ·{' '}
                {result.reservation.eventDate ?? '—'}
              </p>
            )}
            {result.pass?.usedAt && (
              <p className="mt-1 text-xs">
                {t('checkIn.usedAt', {
                  at: new Date(result.pass.usedAt * 1000).toLocaleString(),
                  by: result.pass.usedBy ?? '—',
                })}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
