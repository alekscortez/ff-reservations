import { APP_CONFIG } from './config';

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface ApiClientOptions {
  getAccessToken: () => string | null | Promise<string | null>;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  get<T>(path: string, params?: QueryParams): Promise<T> {
    return this.request<T>('GET', path, undefined, params);
  }

  post<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
    return this.request<T>('POST', path, body, params);
  }

  put<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
    return this.request<T>('PUT', path, body, params);
  }

  delete<T>(path: string, params?: QueryParams): Promise<T> {
    return this.request<T>('DELETE', path, undefined, params);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    params: QueryParams | undefined
  ): Promise<T> {
    const url = new URL(APP_CONFIG.apiBaseUrl + path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers({ Accept: 'application/json' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const token = await this.options.getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(response.status, text || response.statusText);
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return undefined as T;
    return (await response.json()) as T;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
