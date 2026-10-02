import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { Rei40Scores } from '../data/rei40-items';

// Generous on purpose: the API runs on Render's free tier, which sleeps after ~15 min idle and
// needs 30-50 s to wake up — a 10 s limit made the first click on an emailed link fail.
const REQUEST_TIMEOUT_MS = 90_000;

export interface Rei40ResultDto {
  participantId: string;
  language: 'sr' | 'en';
  answers: Record<number, number>;
  // The short-form variant only ever produces rationality/experientiality — the 4 facet scores
  // are omitted (server stores them as NULL) rather than fabricated from 2-3 items. On a timer
  // auto-submit (isTimedOut), any subscale with even one unanswered item computes to null too —
  // same "never fabricate a score from an incomplete subscale" rule, just triggered by the timer
  // instead of the short variant's smaller item pool.
  scores: { [K in keyof Rei40Scores]?: number | null } & { rationality: number | null; experientiality: number | null };
  variant: string;
  /** True when this submission was auto-sent because the per-research timer (Research.
   *  TimerRei40Enabled/Minutes) expired, not because the participant clicked Submit themselves. */
  isTimedOut?: boolean;
  /** The REI40 magic-link token this participant resolved with — required for a real (non-test)
   *  participant, omitted for a test participant (see server.mjs's POST /api/result). */
  token?: string | null;
}

@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private http = inject(HttpClient);

  /** Dev/testing-only path (the real entry point is the emailed magic link, see resolveLink).
   *  Resolves the participant's existence plus their research's REI item-set variant. */
  async checkParticipant(
    participantId: string
  ): Promise<{ exists: boolean; rei40Variant: string; timerEnabled: boolean; timerMinutes: number | null }> {
    const res = await firstValueFrom(
      this.http
        .get<{ exists: boolean; rei40Variant?: string; timerEnabled?: boolean; timerMinutes?: number | null }>(
          `/api/participant/${encodeURIComponent(participantId)}`
        )
        .pipe(timeout(REQUEST_TIMEOUT_MS))
    );
    if (typeof res?.exists !== 'boolean') {
      throw new Error('Unexpected participant check response');
    }
    return {
      exists: res.exists,
      rei40Variant: res.rei40Variant ?? 'v1',
      timerEnabled: res.timerEnabled === true,
      timerMinutes: res.timerMinutes ?? null,
    };
  }

  async saveResult(dto: Rei40ResultDto): Promise<void> {
    await firstValueFrom(
      this.http.post<void>('/api/result', dto).pipe(timeout(REQUEST_TIMEOUT_MS))
    );
  }

  async resolveLink(token: string): Promise<LinkResolveResult> {
    try {
      const res = await firstValueFrom(
        this.http
          .get<{
            participantId: string;
            lang: 'sr' | 'en';
            rei40Variant?: string;
            timerEnabled?: boolean;
            timerMinutes?: number | null;
          }>(`/api/link/${encodeURIComponent(token)}`)
          .pipe(timeout(REQUEST_TIMEOUT_MS))
      );
      return {
        ok: true,
        participantId: res.participantId,
        lang: res.lang,
        rei40Variant: res.rei40Variant ?? 'v1',
        timerEnabled: res.timerEnabled === true,
        timerMinutes: res.timerMinutes ?? null,
      };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NOT_FOUND' || code === 'EXPIRED' || code === 'ALREADY_COMPLETED' || code === 'NOT_ACTIVE') {
        return { ok: false, error: code };
      }
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }
}

export type LinkResolveResult =
  | { ok: true; participantId: string; lang: 'sr' | 'en'; rei40Variant: string; timerEnabled: boolean; timerMinutes: number | null }
  | { ok: false; error: 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_COMPLETED' | 'NOT_ACTIVE' | 'SERVER_ERROR' };