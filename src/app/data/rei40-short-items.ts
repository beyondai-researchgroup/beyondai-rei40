/**
 * Short-form REI variant: 10 of the 40 existing REI-40 items, not the official (unpublished)
 * Norris/Pacini/Epstein REI-10 — only 2 of that instrument's 10 items are publicly available
 * anywhere (checked directly against sjdm.org/dmidi, the standard public repository for these
 * scales), so the other 8 can't be reproduced without fabricating psychometric content. This is
 * instead a transparent subset of the REI-40 item pool this app already has full, legitimate text
 * for (see rei40-items.ts) — no new item text, no new translations. Never call this "REI-10" in
 * user-facing copy; it's the "short form"/"skraćena verzija".
 *
 * Selection: balanced across the 4 original facets and across reverse-scoring so the short form
 * isn't skewed toward one response direction.
 *   Rationality side (5):    RA {1, 2, 6} + RE {11, 12}   — reverse F,T,F,T,F
 *   Experientiality side (5): EA {21, 22, 26} + EE {31, 34} — reverse T,F,T,F,T
 *
 * Reported scores are just rationality/experientiality (mean of each 5-item side) — no RA/RE/EA/EE
 * facet scores, since 2-3 items isn't a meaningful facet measurement on its own. This mirrors the
 * real REI-10's own reported shape (2 composites, not 4 facets) while being explicit it's derived.
 */
import { REI40_ITEMS, Rei40Item, scoreValue } from './rei40-items';

export const REI_SHORT_RATIONALITY_IDS = [1, 2, 6, 11, 12];
export const REI_SHORT_EXPERIENTIALITY_IDS = [21, 22, 26, 31, 34];
export const REI_SHORT_IDS = [...REI_SHORT_RATIONALITY_IDS, ...REI_SHORT_EXPERIENTIALITY_IDS];

export const REI_SHORT_ITEMS: Rei40Item[] = REI40_ITEMS.filter((i) => REI_SHORT_IDS.includes(i.id));

export interface ReiShortScores {
  rationality: number;
  experientiality: number;
}

/** Same scoreValue reverse-transform as REI-40, averaged into the 2 short-form composites. */
export function computeReiShortScores(answers: Record<number, number>): ReiShortScores {
  const scoreOf = (id: number): number => {
    const item = REI_SHORT_ITEMS.find((i) => i.id === id)!;
    return scoreValue(answers[id], item.reverse);
  };
  const avg = (ids: number[]) => ids.reduce((sum, id) => sum + scoreOf(id), 0) / ids.length;
  return {
    rationality: avg(REI_SHORT_RATIONALITY_IDS),
    experientiality: avg(REI_SHORT_EXPERIENTIALITY_IDS),
  };
}
