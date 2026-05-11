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

// On-screen debug panel — gated by the same ff-debug flag as Eruda.
// Pure DOM (no Angular) so it's immune to zone / change-detection issues
// we may be trying to diagnose. Updates a small fixed-position panel with
// live event counters so we can see what's happening without console pastes.
function maybeInstallDebugOverlay(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  try {
    if (window.localStorage.getItem('ff-debug') !== '1') return;
  } catch {
    return;
  }
  const install = () => {
    if (document.getElementById('ff-debug-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ff-debug-panel';
    panel.style.cssText =
      'position:fixed;top:64px;right:4px;z-index:2147483646;' +
      'background:rgba(0,0,0,0.88);color:#0f0;' +
      'font:10px/1.2 ui-monospace,Menlo,monospace;' +
      'padding:5px 7px;border-radius:4px;pointer-events:none;' +
      'white-space:pre;max-width:55vw;border:1px solid #333;';
    document.body.appendChild(panel);
    const state = {
      ts: 0, te: 0, tc: 0, c: 0, pd: 0, pu: 0,
      vpR: 0, vpS: 0, tap: '', click: '',
    };
    const fmt = (el: EventTarget | null) => {
      if (!el || !(el instanceof Element)) return '?';
      const tag = el.tagName;
      const id = el.id ? '#' + el.id : '';
      const cls = (el.className || '').toString().trim().split(/\s+/)[0] || '';
      return tag + id + (cls ? '.' + cls.slice(0, 18) : '');
    };
    const render = () => {
      panel.textContent =
        `ts:${state.ts} te:${state.te} tc:${state.tc}\n` +
        `pd:${state.pd} pu:${state.pu} click:${state.c}\n` +
        `vp:resize ${state.vpR} scroll ${state.vpS}\n` +
        `tap:${state.tap}\n` +
        `click:${state.click}`;
    };
    render();
    document.addEventListener('touchstart', (e) => { state.ts++; state.tap = fmt(e.target); render(); }, { capture: true, passive: true });
    document.addEventListener('touchend', () => { state.te++; render(); }, { capture: true, passive: true });
    document.addEventListener('touchcancel', () => { state.tc++; render(); }, { capture: true, passive: true });
    document.addEventListener('click', (e) => { state.c++; state.click = fmt(e.target); render(); }, { capture: true });
    document.addEventListener('pointerdown', () => { state.pd++; render(); }, { capture: true, passive: true });
    document.addEventListener('pointerup', () => { state.pu++; render(); }, { capture: true, passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => { state.vpR++; render(); });
      window.visualViewport.addEventListener('scroll', () => { state.vpS++; render(); });
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}

maybeLoadEruda().finally(() => {
  maybeInstallDebugOverlay();
  bootstrapApplication(App, appConfig).catch((err) => console.error(err));
});
