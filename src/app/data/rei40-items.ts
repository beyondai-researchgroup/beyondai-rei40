/**
 * REI-40 (Rational-Experiential Inventory, Pacini & Epstein 1999) item structure.
 * Item text lives in assets/i18n/{sr,en}.json under REI40.ITEM.<id> — this file only
 * holds the scoring-relevant metadata (subscale + reverse-scoring flag).
 *
 * Source: digitized from the researcher's original Google Form. That form had a data
 * entry error — 6 of its 40 rows were accidental duplicates of Rational Engagement /
 * Experiential Ability / Experiential Engagement items, leaving the Rational Ability
 * subscale with only 4 of its 10 items. The 6 missing Rational Ability items below were
 * reconstructed from the published instrument; the other 3 subscales (30 items) are
 * unchanged from the original form content.
 */

export type Rei40Subscale = 'RA' | 'RE' | 'EA' | 'EE';

export interface Rei40Item {
  /** Stable id, 1-40, also the i18n key suffix (REI40.ITEM.<id>). */
  id: number;
  subscale: Rei40Subscale;
  /** True if a high raw rating (agreement) should count as a LOW subscale score. */
  reverse: boolean;
}

export const REI40_SUBSCALE_ORDER: Rei40Subscale[] = ['RA', 'RE', 'EA', 'EE'];

export const REI40_ITEMS: Rei40Item[] = [
  // Rational Ability (RA)
  { id: 1, subscale: 'RA', reverse: false },
  { id: 2, subscale: 'RA', reverse: true },
  { id: 3, subscale: 'RA', reverse: true },
  { id: 4, subscale: 'RA', reverse: true },
  { id: 5, subscale: 'RA', reverse: true },
  { id: 6, subscale: 'RA', reverse: false },
  { id: 7, subscale: 'RA', reverse: false },
  { id: 8, subscale: 'RA', reverse: false },
  { id: 9, subscale: 'RA', reverse: false },
  { id: 10, subscale: 'RA', reverse: true },
  // Rational Engagement (RE)
  { id: 11, subscale: 'RE', reverse: true },
  { id: 12, subscale: 'RE', reverse: false },
  { id: 13, subscale: 'RE', reverse: true },
  { id: 14, subscale: 'RE', reverse: false },
  { id: 15, subscale: 'RE', reverse: true },
  { id: 16, subscale: 'RE', reverse: false },
  { id: 17, subscale: 'RE', reverse: true },
  { id: 18, subscale: 'RE', reverse: false },
  { id: 19, subscale: 'RE', reverse: true },
  { id: 20, subscale: 'RE', reverse: false },
  // Experiential Ability (EA)
  { id: 21, subscale: 'EA', reverse: true },
  { id: 22, subscale: 'EA', reverse: false },
  { id: 23, subscale: 'EA', reverse: false },
  { id: 24, subscale: 'EA', reverse: false },
  { id: 25, subscale: 'EA', reverse: false },
  { id: 26, subscale: 'EA', reverse: true },
  { id: 27, subscale: 'EA', reverse: false },
  { id: 28, subscale: 'EA', reverse: true },
  { id: 29, subscale: 'EA', reverse: false },
  { id: 30, subscale: 'EA', reverse: true },
  // Experiential Engagement (EE)
  { id: 31, subscale: 'EE', reverse: false },
  { id: 32, subscale: 'EE', reverse: false },
  { id: 33, subscale: 'EE', reverse: false },
  { id: 34, subscale: 'EE', reverse: true },
  { id: 35, subscale: 'EE', reverse: false },
  { id: 36, subscale: 'EE', reverse: true },
  { id: 37, subscale: 'EE', reverse: true },
  { id: 38, subscale: 'EE', reverse: true },
  { id: 39, subscale: 'EE', reverse: true },
  { id: 40, subscale: 'EE', reverse: false },
];

/** Standard 1-5 reverse transform: reversed = (min + max) - raw = 6 - raw. */
export function scoreValue(raw: number, reverse: boolean): number {
  return reverse ? 6 - raw : raw;
}

export interface Rei40Scores {
  RA: number;
  RE: number;
  EA: number;
  EE: number;
  rationality: number;
  experientiality: number;
}

/** Computes the 4 subscale averages + the 2 composite scores from raw 1-5 answers. */
export function computeRei40Scores(answers: Record<number, number>): Rei40Scores {
  const bySubscale: Record<Rei40Subscale, number[]> = { RA: [], RE: [], EA: [], EE: [] };
  for (const item of REI40_ITEMS) {
    const raw = answers[item.id];
    bySubscale[item.subscale].push(scoreValue(raw, item.reverse));
  }
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const RA = avg(bySubscale.RA);
  const RE = avg(bySubscale.RE);
  const EA = avg(bySubscale.EA);
  const EE = avg(bySubscale.EE);
  return { RA, RE, EA, EE, rationality: (RA + RE) / 2, experientiality: (EA + EE) / 2 };
}