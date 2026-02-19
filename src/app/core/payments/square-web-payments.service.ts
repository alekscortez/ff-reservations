import { Injectable } from '@angular/core';

type SquareEnvMode = 'sandbox' | 'production';

interface CashAppMountRequest {
  applicationId: string;
  locationId: string;
  amount: number;
  container: HTMLElement;
  onTokenized: (sourceId: string) => void;
  onError?: (message: string) => void;
  label?: string;
  referenceId?: string;
  currencyCode?: string;
  countryCode?: string;
  squareEnvMode?: SquareEnvMode;
  redirectUrl?: string;
}

interface CashAppMountSession {
  destroy: () => Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class SquareWebPaymentsService {
  private scriptPromiseByUrl: Record<string, Promise<void>> = {};

  async mountCashAppPayButton(request: CashAppMountRequest): Promise<CashAppMountSession> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('Cash App Pay is only available in a browser context.');
    }

    const applicationId = String(request.applicationId ?? '').trim();
    const locationId = String(request.locationId ?? '').trim();
    const amount = Number(request.amount ?? 0);
    const container = request.container;
    const onTokenized = request.onTokenized;
    const onError = request.onError;
    const currencyCode = String(request.currencyCode ?? 'USD').trim().toUpperCase();
    const countryCode = String(request.countryCode ?? 'US').trim().toUpperCase();
    const referenceId = String(request.referenceId ?? '').trim();
    const label = String(request.label ?? 'Reservation payment').trim() || 'Reservation payment';
    const redirectUrl = String(request.redirectUrl ?? window.location.href).trim();
    const envMode: SquareEnvMode = request.squareEnvMode === 'production' ? 'production' : 'sandbox';

    if (!applicationId) throw new Error('Square application id is not configured.');
    if (!locationId) throw new Error('Square location id is not configured.');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than 0.');
    if (!container) throw new Error('Cash App container is required.');
    if (typeof onTokenized !== 'function') throw new Error('onTokenized handler is required.');

    await this.ensureSquareScript(envMode);
    const squareApi = this.getSquareApi();
    const payments = squareApi.payments(applicationId, locationId);
    if (!payments || typeof payments !== 'object') {
      throw new Error('Square Web Payments could not be initialized.');
    }

    if (!container.id) {
      container.id = `sq-cashapp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }
    container.innerHTML = '';

    const paymentRequest = payments.paymentRequest({
      countryCode,
      currencyCode,
      total: {
        amount: amount.toFixed(2),
        label,
      },
    });

    const cashAppPay = await payments.cashAppPay(paymentRequest, {
      redirectURL: redirectUrl,
      referenceId: referenceId || undefined,
    });

    const eventTarget = cashAppPay as unknown as {
      addEventListener?: (name: string, fn: (event: unknown) => void) => void;
      removeEventListener?: (name: string, fn: (event: unknown) => void) => void;
      ontokenization?: ((event: unknown) => void) | null;
      destroy?: () => Promise<void> | void;
      attach?: (selector: string) => Promise<void>;
    };

    const handler = (event: unknown) => {
      const payload =
        (event as { detail?: unknown })?.detail ??
        event;
      const tokenResult =
        (payload as { tokenResult?: unknown })?.tokenResult ??
        payload;
      const status = String((tokenResult as { status?: unknown })?.status ?? '').trim().toUpperCase();
      const token = String((tokenResult as { token?: unknown })?.token ?? '').trim();
      if (status === 'OK' && token) {
        onTokenized(token);
        return;
      }
      const errors = (tokenResult as { errors?: Array<{ detail?: string; message?: string }> })?.errors;
      const firstError = errors?.[0];
      const message =
        String(firstError?.detail ?? firstError?.message ?? '').trim() ||
        'Cash App Pay was not completed.';
      onError?.(message);
    };

    if (typeof eventTarget.addEventListener === 'function') {
      eventTarget.addEventListener('ontokenization', handler);
    } else {
      eventTarget.ontokenization = handler;
    }

    await eventTarget.attach?.(`#${container.id}`);

    return {
      destroy: async () => {
        try {
          if (typeof eventTarget.removeEventListener === 'function') {
            eventTarget.removeEventListener('ontokenization', handler);
          } else if (eventTarget.ontokenization === handler) {
            eventTarget.ontokenization = null;
          }
        } catch {
          // Best-effort listener cleanup.
        }
        try {
          await eventTarget.destroy?.();
        } catch {
          // Best-effort widget cleanup.
        }
        container.innerHTML = '';
      },
    };
  }

  private getSquareApi(): {
    payments: (
      applicationId: string,
      locationId: string
    ) => {
      paymentRequest: (value: unknown) => unknown;
      cashAppPay: (paymentRequest: unknown, options: unknown) => Promise<unknown>;
    };
  } {
    const square = (window as unknown as { Square?: unknown }).Square;
    if (!square || typeof square !== 'object') {
      throw new Error('Square Web Payments SDK is not loaded.');
    }
    const payments = (square as { payments?: unknown }).payments;
    if (typeof payments !== 'function') {
      throw new Error('Square Web Payments SDK is unavailable.');
    }
    return square as {
      payments: (
        applicationId: string,
        locationId: string
      ) => {
        paymentRequest: (value: unknown) => unknown;
        cashAppPay: (paymentRequest: unknown, options: unknown) => Promise<unknown>;
      };
    };
  }

  private ensureSquareScript(envMode: SquareEnvMode): Promise<void> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return Promise.reject(new Error('Square Web Payments is only available in a browser context.'));
    }
    const scriptUrl =
      envMode === 'production'
        ? 'https://web.squarecdn.com/v1/square.js'
        : 'https://sandbox.web.squarecdn.com/v1/square.js';

    const existing = this.scriptPromiseByUrl[scriptUrl];
    if (existing) return existing;

    const promise = new Promise<void>((resolve, reject) => {
      const alreadyLoaded = Array.from(document.getElementsByTagName('script')).find(
        (script) => script.src === scriptUrl
      );
      if (alreadyLoaded) {
        if ((window as unknown as { Square?: unknown }).Square) {
          resolve();
          return;
        }
        alreadyLoaded.addEventListener('load', () => resolve(), { once: true });
        alreadyLoaded.addEventListener('error', () => reject(new Error('Failed to load Square SDK.')), {
          once: true,
        });
        return;
      }

      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Square SDK.'));
      document.head.appendChild(script);
    });

    this.scriptPromiseByUrl[scriptUrl] = promise;
    return promise;
  }
}

