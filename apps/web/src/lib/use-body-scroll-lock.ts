import { useEffect } from 'react';

// Module-level counter so multiple components stacking modals don't fight
// over the body's overflow style. The lock is released only when every
// caller has unlocked.
let lockCount = 0;
let savedOverflow: string | null = null;
let savedHtmlOverflow: string | null = null;

function applyLock() {
  if (typeof document === 'undefined') return;
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    savedHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function releaseLock() {
  if (typeof document === 'undefined') return;
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = savedOverflow ?? '';
    document.documentElement.style.overflow = savedHtmlOverflow ?? '';
    savedOverflow = null;
    savedHtmlOverflow = null;
  }
}

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    applyLock();
    return () => {
      releaseLock();
    };
  }, [active]);
}
