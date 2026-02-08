import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { APP_CONFIG } from '../config/app-config';

type QueryParams = Record<string, string | number | boolean | null | undefined>;

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private http = inject(HttpClient);
  private baseUrl = APP_CONFIG.apiBaseUrl;

  get<T>(path: string, params?: QueryParams) {
    return this.http.get<T>(this.baseUrl + path, { params: this.toParams(params) });
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
