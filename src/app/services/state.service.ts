import { Injectable, signal } from '@angular/core';

export interface StudyState {
  participantId: string;
  lang: 'sr' | 'en';
  /** Which REI item-set this participant's research uses: 'v1' (the full 40-item REI-40) or
   *  'short' (a 10-item subset of the same pool — see data/rei40-short-items.ts for why it's a
   *  subset rather than the official unpublished REI-10). */
  rei40Variant: string;
  /** Per-app participant timer (2026-09-11), set on login/link-resolve from Research.
   *  TimerRei40Enabled/Minutes. timerMinutes is only meaningful when timerEnabled is true. */
  timerEnabled: boolean;
  timerMinutes: number | null;
  /** The magic-link token this participant resolved with — null for a test participant (the
   *  dev-login form has no token). Re-sent on submit as defense in depth (see server.mjs's
   *  POST /api/result). */
  linkToken?: string | null;
}

const STORAGE_KEY = 'rei40-state';

/**
 * Minimal session state: just the participant id + locked language for this run.
 * Persisted to sessionStorage so a page refresh mid-test doesn't lose the login.
 */
@Injectable({ providedIn: 'root' })
export class StateService {
  private readonly _state = signal<StudyState | null>(this.restore());
  readonly state = this._state.asReadonly();

  setState(state: StudyState): void {
    this._state.set(state);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }

  clear(): void {
    this._state.set(null);
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  private restore(): StudyState | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StudyState) : null;
    } catch {
      return null;
    }
  }
}