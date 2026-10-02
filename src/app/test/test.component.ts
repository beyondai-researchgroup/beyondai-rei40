import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { StateService } from '../services/state.service';
import { DatabaseService, Rei40ResultDto } from '../services/database.service';
import { REI40_ITEMS, REI40_SUBSCALE_ORDER, Rei40Item, Rei40Subscale, Rei40Scores, computeRei40Scores } from '../data/rei40-items';
import {
  REI_SHORT_ITEMS,
  REI_SHORT_RATIONALITY_IDS,
  REI_SHORT_EXPERIENTIALITY_IDS,
  computeReiShortScores,
} from '../data/rei40-short-items';
import { TimerDisplayComponent } from '../shared/timer-display/timer-display.component';

type SectionKey = Rei40Subscale | 'RATIONALITY' | 'EXPERIENTIALITY';

interface Section {
  subscale: SectionKey;
  items: Rei40Item[];
}

@Component({
  selector: 'app-test',
  standalone: true,
  imports: [TranslateModule, TimerDisplayComponent],
  templateUrl: './test.component.html',
  styleUrl: './test.component.scss',
})
export class TestComponent implements OnInit {
  private state = inject(StateService);
  private db = inject(DatabaseService);
  private router = inject(Router);

  // Short form uses a 2-section layout (its 10 items keep their original RA/RE/EA/EE tags for
  // scoring, but are grouped under the 2 composite headings a participant actually sees) — full
  // REI-40 keeps its existing 4-section layout. Branches once, up front, off the variant carried
  // in session state since login/link resolution.
  private readonly isShortForm = this.state.state()?.rei40Variant === 'short';

  readonly sections: Section[] = this.isShortForm
    ? [
        { subscale: 'RATIONALITY', items: REI_SHORT_ITEMS.filter((i) => REI_SHORT_RATIONALITY_IDS.includes(i.id)) },
        { subscale: 'EXPERIENTIALITY', items: REI_SHORT_ITEMS.filter((i) => REI_SHORT_EXPERIENTIALITY_IDS.includes(i.id)) },
      ]
    : REI40_SUBSCALE_ORDER.map((subscale) => ({
        subscale,
        items: REI40_ITEMS.filter((i) => i.subscale === subscale),
      }));

  readonly totalItems = this.isShortForm ? REI_SHORT_ITEMS.length : REI40_ITEMS.length;
  readonly answers = signal<Record<number, number>>({});
  readonly answeredCount = computed(() => Object.keys(this.answers()).length);
  readonly allAnswered = computed(() => this.answeredCount() === this.totalItems);
  readonly submitting = signal(false);
  readonly submitError = signal(false);

  // Per-app participant timer (2026-09-11) — read once at test-start, same as rei40Variant.
  readonly timerEnabled = this.state.state()?.timerEnabled ?? false;
  readonly timerMinutes = this.state.state()?.timerMinutes ?? 0;

  ngOnInit(): void {
    if (!this.state.state()) {
      this.router.navigate(['/login']);
    }
  }

  setAnswer(itemId: number, value: number): void {
    this.answers.update(a => ({ ...a, [itemId]: value }));
  }

  async submit(): Promise<void> {
    if (!this.allAnswered() || this.submitting()) return;
    await this.doSubmit(false);
  }

  /** Fired by <app-timer-display> exactly once, on expiry — sends whatever's currently answered
   *  instead of the normal allAnswered()-gated path. Guarded by the same `submitting` signal, so
   *  a manual submit that's already in flight (or just completed) can't race with this. */
  async onTimerExpired(): Promise<void> {
    if (this.submitting()) return;
    await this.doSubmit(true);
  }

  private async doSubmit(isTimedOut: boolean): Promise<void> {
    const s = this.state.state();
    if (!s) {
      this.router.navigate(['/login']);
      return;
    }

    this.submitting.set(true);
    this.submitError.set(false);

    try {
      // Short form only ever produces the 2 composites — RA/RE/EA/EE are omitted rather than
      // computed from 2-3 items each, which wouldn't be a meaningful facet score. On a timed-out
      // submission, computeRei40Scores/computeReiShortScores already produce NaN for any subscale
      // with even one missing item (their averaging naturally propagates a missing addend) —
      // sanitizeScores turns that into an honest `null` rather than sending NaN over the wire.
      const scores = this.isShortForm ? computeReiShortScores(this.answers()) : computeRei40Scores(this.answers());
      await this.db.saveResult({
        participantId: s.participantId,
        language: s.lang,
        answers: this.answers(),
        scores: this.sanitizeScores(scores),
        variant: s.rei40Variant,
        isTimedOut,
        token: s.linkToken ?? null,
      });
      this.state.clear();
      this.router.navigate(['/done']);
    } catch {
      this.submitError.set(true);
    } finally {
      this.submitting.set(false);
    }
  }

  private sanitizeScores(scores: Partial<Rei40Scores>): Rei40ResultDto['scores'] {
    const out: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(scores)) {
      out[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    return out as Rei40ResultDto['scores'];
  }
}