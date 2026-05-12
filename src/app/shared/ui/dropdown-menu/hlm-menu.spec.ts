import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmMenu, HlmMenuItem, HlmMenuTrigger } from './hlm-menu';
import { HlmMenuCheckbox } from './hlm-menu-checkbox';
import { HlmMenuSeparator } from './hlm-menu-separator';

@Component({
  standalone: true,
  imports: [HlmMenuTrigger, HlmMenu, HlmMenuItem, HlmMenuSeparator],
  template: `
    <button [hlmMenuTriggerFor]="rowMenu" type="button" aria-label="Open row menu">⋮</button>
    <ng-template #rowMenu>
      <div hlmMenu>
        <button hlmMenuItem (click)="last.set('edit')">Edit</button>
        <hlm-menu-separator />
        <button hlmMenuItem variant="destructive" (click)="last.set('delete')">Delete</button>
      </div>
    </ng-template>
  `,
})
class Host {
  last = signal<'edit' | 'delete' | null>(null);
}

function createHost() {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture;
}

async function nextTick() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('HlmMenu (dropdown)', () => {
  afterEach(() => {
    // Close any lingering overlay between tests
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  it('renders a trigger button only — menu content lives in the overlay portal', () => {
    const fixture = createHost();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('button[aria-label="Open row menu"]')).toBeTruthy();
    expect(document.querySelector('[hlmMenu]')).toBeNull();
  });

  it('opens the menu in an overlay when the trigger is clicked', async () => {
    const fixture = createHost();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label="Open row menu"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await nextTick();
    fixture.detectChanges();

    const menu = document.querySelector('[hlmMenu]') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu!.className).toContain('rounded-md');
    expect(menu!.className).toContain('shadow-md');
    expect(menu!.querySelectorAll('button[hlmMenuItem]').length).toBe(2);
  });

  it('invokes the item handler when an item is clicked', async () => {
    const fixture = createHost();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label="Open row menu"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await nextTick();
    fixture.detectChanges();

    const editBtn = document.querySelector(
      '[hlmMenu] button[hlmMenuItem]',
    ) as HTMLButtonElement;
    editBtn.click();
    fixture.detectChanges();
    await nextTick();

    expect(fixture.componentInstance.last()).toBe('edit');
  });

  it('applies the destructive variant classes to a destructive item', async () => {
    const fixture = createHost();
    (fixture.nativeElement as HTMLElement)
      .querySelector('button[aria-label="Open row menu"]')!
      .dispatchEvent(new MouseEvent('click'));
    fixture.detectChanges();
    await nextTick();
    fixture.detectChanges();

    const items = document.querySelectorAll('[hlmMenu] button[hlmMenuItem]');
    const destructive = items[1] as HTMLElement;
    expect(destructive.className).toContain('text-danger-700');
    expect(destructive.className).toContain('hover:bg-danger-50');
  });

  it('renders the separator with the expected styling', async () => {
    const fixture = createHost();
    (fixture.nativeElement as HTMLElement)
      .querySelector('button[aria-label="Open row menu"]')!
      .dispatchEvent(new MouseEvent('click'));
    fixture.detectChanges();
    await nextTick();
    fixture.detectChanges();

    const sep = document.querySelector('hlm-menu-separator') as HTMLElement;
    expect(sep).toBeTruthy();
    expect(sep.getAttribute('role')).toBe('separator');
    expect(sep.className).toContain('bg-brand-100');
  });
});

@Component({
  standalone: true,
  imports: [HlmMenuTrigger, HlmMenu, HlmMenuCheckbox],
  template: `
    <button [hlmMenuTriggerFor]="columnsMenu" type="button" aria-label="Open columns menu">
      Columns
    </button>
    <ng-template #columnsMenu>
      <div hlmMenu>
        <button hlmMenuCheckbox [checked]="visible.name" (triggered)="toggle('name')">Name</button>
        <button hlmMenuCheckbox [checked]="visible.phone" (triggered)="toggle('phone')">Phone</button>
      </div>
    </ng-template>
  `,
})
class CheckboxHost {
  visible = { name: true, phone: false };
  toggle(k: 'name' | 'phone') {
    this.visible = { ...this.visible, [k]: !this.visible[k] };
  }
}

describe('HlmMenuCheckbox', () => {
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  async function createHost() {
    TestBed.configureTestingModule({ imports: [CheckboxHost] });
    const fixture = TestBed.createComponent(CheckboxHost);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement)
      .querySelector('button[aria-label="Open columns menu"]')!
      .dispatchEvent(new MouseEvent('click'));
    fixture.detectChanges();
    await nextTick();
    fixture.detectChanges();
    return fixture;
  }

  it('renders the leading checkmark indicator only for items with checked=true', async () => {
    const fixture = await createHost();
    const items = document.querySelectorAll('[hlmMenu] button[hlmMenuCheckbox]');
    // Item 1 (Name) is checked → has the icon
    const item1Icon = (items[0] as HTMLElement).querySelector('ng-icon');
    expect(item1Icon).toBeTruthy();
    // Item 2 (Phone) is unchecked → no icon
    const item2Icon = (items[1] as HTMLElement).querySelector('ng-icon');
    expect(item2Icon).toBeNull();
  });

  it('fires (triggered) on click and updates the parent state', async () => {
    const fixture = await createHost();
    const items = document.querySelectorAll('[hlmMenu] button[hlmMenuCheckbox]');
    (items[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    await nextTick();
    expect(fixture.componentInstance.visible.phone).toBe(true);
  });
});
