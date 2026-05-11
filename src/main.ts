import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Mobile devtools (eruda), gated behind ?debug=1 or a localStorage flag.
// Loads from CDN as a side-script so it never ships into the regular
// production bundle. Used to diagnose iOS Chrome-specific issues that
// can't be inspected via Safari Web Inspector. Disable with ?debug=0.
//
// Usage on phone:
//   https://famosofuego.com/?debug=1
//     → sets localStorage flag, persists across Cognito redirects
//     → floating Eruda button appears bottom-right after reload
//   https://famosofuego.com/?debug=0  → clears the flag
function maybeLoadEruda(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  try {
    const param = new URLSearchParams(window.location.search).get('debug');
    if (param === '0') {
      window.localStorage.removeItem('ff-debug');
      return Promise.resolve();
    }
    if (param === '1') {
      window.localStorage.setItem('ff-debug', '1');
    }
    const enabled = window.localStorage.getItem('ff-debug') === '1';
    if (!enabled) return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/eruda';
    script.onload = () => {
      const eruda = (window as unknown as { eruda?: { init: () => void } }).eruda;
      try {
        eruda?.init();
      } catch {
        // ignore — debug-only path, never block bootstrap
      }
      resolve();
    };
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
}

maybeLoadEruda().finally(() =>
  bootstrapApplication(App, appConfig).catch((err) => console.error(err))
);
