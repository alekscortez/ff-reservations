import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmAvatar } from './hlm-avatar';
import { HlmAvatarFallback } from './hlm-avatar-fallback';
import { HlmAvatarImage } from './hlm-avatar-image';

@Component({
  standalone: true,
  imports: [HlmAvatar, HlmAvatarImage, HlmAvatarFallback],
  template: `
    <hlm-avatar [size]="size()">
      @if (src(); as s) {
        <img hlmAvatarImage [src]="s" alt="" />
      }
      <span hlmAvatarFallback>AB</span>
    </hlm-avatar>
  `,
})
class Host {
  size = signal<'sm' | 'default' | 'lg'>('default');
  src = signal<string | null>(null);
}

// Separate fixture for the consumer-class merge case — the effect snapshots
// `class` on first render, so static class="…" is the only path that goes
// through twMerge. Dynamic `[class]` rebinds bypass the snapshot (see
// CLAUDE.md: "UI primitives — Consumer-class merge rule").
@Component({
  standalone: true,
  imports: [HlmAvatar, HlmAvatarFallback],
  template: `
    <hlm-avatar class="rounded-lg bg-sidebar-primary">
      <span hlmAvatarFallback>AB</span>
    </hlm-avatar>
  `,
})
class StaticClassHost {}

function createHost() {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture;
}

function avatarEl(root: HTMLElement): HTMLElement {
  return root.querySelector('hlm-avatar') as HTMLElement;
}

function fallbackEl(root: HTMLElement): HTMLElement {
  return root.querySelector('[data-slot="avatar-fallback"]') as HTMLElement;
}

function imageEl(root: HTMLElement): HTMLImageElement | null {
  return root.querySelector('img[hlmAvatarImage]') as HTMLImageElement | null;
}

describe('HlmAvatar', () => {
  it('applies the default size class', () => {
    const fixture = createHost();
    const host = avatarEl(fixture.nativeElement);
    expect(host.className).toContain('size-8');
    expect(host.className).toContain('rounded-full');
    expect(host.className).toContain('bg-brand-100');
  });

  it('switches to the sm size variant', () => {
    const fixture = createHost();
    fixture.componentInstance.size.set('sm');
    fixture.detectChanges();
    const host = avatarEl(fixture.nativeElement);
    expect(host.className).toContain('size-6');
    expect(host.className).not.toContain('size-8');
  });

  it('switches to the lg size variant', () => {
    const fixture = createHost();
    fixture.componentInstance.size.set('lg');
    fixture.detectChanges();
    const host = avatarEl(fixture.nativeElement);
    expect(host.className).toContain('size-10');
    expect(host.className).not.toContain('size-8');
  });

  it('consumer class overrides default shape via tailwind-merge', () => {
    TestBed.configureTestingModule({ imports: [StaticClassHost] });
    const fixture = TestBed.createComponent(StaticClassHost);
    fixture.detectChanges();
    const host = avatarEl(fixture.nativeElement);
    expect(host.className).toContain('rounded-lg');
    expect(host.className).not.toContain('rounded-full');
    expect(host.className).toContain('bg-sidebar-primary');
    expect(host.className).not.toContain('bg-brand-100');
  });

  it('renders only the fallback when no image source is bound', () => {
    const fixture = createHost();
    const root = fixture.nativeElement as HTMLElement;
    expect(imageEl(root)).toBeNull();
    const fb = fallbackEl(root);
    expect(fb).toBeTruthy();
    expect(fb.hasAttribute('hidden')).toBe(false);
    expect(fb.textContent?.trim()).toBe('AB');
  });

  it('renders the image hidden initially while fallback stays visible', () => {
    const fixture = createHost();
    fixture.componentInstance.src.set('/some/photo.png');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const img = imageEl(root);
    const fb = fallbackEl(root);
    expect(img).toBeTruthy();
    expect(img!.hasAttribute('hidden')).toBe(true);
    expect(fb.hasAttribute('hidden')).toBe(false);
  });

  it('shows the image and hides the fallback after a successful load event', () => {
    const fixture = createHost();
    fixture.componentInstance.src.set('/some/photo.png');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const img = imageEl(root)!;
    img.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(img.hasAttribute('hidden')).toBe(false);
    expect(fallbackEl(root).hasAttribute('hidden')).toBe(true);
  });

  it('keeps the image hidden and the fallback visible after an error event', () => {
    const fixture = createHost();
    fixture.componentInstance.src.set('/missing.png');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const img = imageEl(root)!;
    img.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(img.hasAttribute('hidden')).toBe(true);
    expect(fallbackEl(root).hasAttribute('hidden')).toBe(false);
  });

  it('reverts the loaded state when an image errors after first loading', () => {
    const fixture = createHost();
    fixture.componentInstance.src.set('/photo.png');
    fixture.detectChanges();
    const img = imageEl(fixture.nativeElement)!;
    img.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(img.hasAttribute('hidden')).toBe(false);

    img.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(img.hasAttribute('hidden')).toBe(true);
    expect(fallbackEl(fixture.nativeElement).hasAttribute('hidden')).toBe(false);
  });
});
