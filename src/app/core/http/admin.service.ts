import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client';

export interface WhoAmIResponse {
  sub: string | null;
  username: string | null;
  email: string | null;
  name: string | null;
  groups: string[];
  role: 'Admin' | 'Staff' | 'User';
  hasGroups: boolean;
  tokenUse: string | null;
  groupsClaimSource: string | null;
  diagnostic: {
    missingGroupsLikelyPreTokenGen: boolean;
  };
}

// Live-visitor snapshot for the staff dashboard "Live now" tile. Backed
// by the PK="PRESENCE" rows that services-presence writes from the
// /public/telemetry handler. Cache-control:no-store on the BE so each
// 5s poll sees fresh numbers.
export interface LiveVisitorsResponse {
  count: number;
  byStage: {
    map: number;
    modal: number;
    checkout: number;
    paid_landing: number;
  };
  updatedAt: number;
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private api = inject(ApiClient);

  whoami() {
    return this.api.get<WhoAmIResponse>('/admin/whoami');
  }

  liveVisitors() {
    return this.api.get<LiveVisitorsResponse>('/admin/live-visitors');
  }
}
