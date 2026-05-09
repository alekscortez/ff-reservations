import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { retry, throwError, timer } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';

type QueryParams = Record<string, string | number | boolean | null | undefined>;

// Retry policy for idempotent verbs only. Lambda cold starts and DDB
// transient throttling occasionally produce 5xx that succeed on second
// try; that recovery shouldn't surface to staff. We never retry POST/PUT
// because a 5xx with a body may have already mutated state.
const RETRY_DELAY_MS = 200;
const isTransient = (err: unknown): boolean => {
  if (!(err instanceof HttpErrorResponse)) return false;
  if (err.status === 0) return true; // network/CORS
  return err.status >= 500 && err.status < 600;
};

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private http = inject(HttpClient);
  private baseUrl = APP_CONFIG.apiBaseUrl;

  get<T>(path: string, params?: QueryParams) {
    return this.http
      .get<T>(this.baseUrl + path, { params: this.toParams(params) })
      .pipe(
        retry({
          count: 1,
          delay: (err) =>
            isTransient(err) ? timer(RETRY_DELAY_MS) : throwError(() => err),
        })
      );
  }

  post<T>(path: string, body?: unknown, params?: QueryParams) {
    return this.http.post<T>(this.baseUrl + path, body, { params: this.toParams(params) });
  }

  put<T>(path: string, body?: unknown, params?: QueryParams) {
    return this.http.put<T>(this.baseUrl + path, body, { params: this.toParams(params) });
  }

  delete<T>(path: string, params?: QueryParams) {
    return this.http.delete<T>(this.baseUrl + path, { params: this.toParams(params) });
  }

  private toParams(params?: QueryParams): HttpParams | undefined {
    if (!params) return undefined;
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      httpParams = httpParams.set(key, String(value));
    }
    return httpParams;
  }
}
