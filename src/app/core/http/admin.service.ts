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

@Injectable({ providedIn: 'root' })
export class AdminService {
  private api = inject(ApiClient);

  whoami() {
    return this.api.get<WhoAmIResponse>('/admin/whoami');
  }
}
