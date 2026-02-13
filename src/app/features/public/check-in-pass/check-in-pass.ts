import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'app-check-in-pass-page',
  imports: [CommonModule],
  templateUrl: './check-in-pass.html',
  styleUrl: './check-in-pass.scss',
})
export class CheckInPassPage {
  private route = inject(ActivatedRoute);

  token = computed(() => String(this.route.snapshot.queryParamMap.get('token') ?? '').trim());
  payload = computed(() => {
    const token = this.token();
    return token ? `ffr-checkin:${token}` : '';
  });

  copyPayload(): void {
    const value = this.payload();
    if (!value) return;
    if (!navigator?.clipboard?.writeText) return;
    navigator.clipboard.writeText(value).catch(() => {
      // Ignore clipboard failures on restricted browsers.
    });
  }
}
