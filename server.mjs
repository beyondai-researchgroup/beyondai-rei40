// Minimal local API server for the REI-40 app: participant lookup + result writes
// against the shared Neon Postgres database. Run with `node --env-file=.env server.mjs`.
// Mirrors the pattern used by the NASA-TLX app's api/_lib/db.ts + server.ts, simplified
// (no SSR — this app is served separately via `ng serve` during local development).

import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { neon } from '@neondatabase/serverless';
import { createLocalSql } from './server/local-db.mjs';
import { sendMail } from './server/email/mailer.mjs';
import { buildIntroTaskEmail } from './server/email/introTaskEmail.mjs';

const PORT = process.env.PORT || 4310;

// Mirrors src/app/data/rei40-items.ts (full set) and rei40-short-items.ts (the 10-item subset) —
// duplicated here rather than shared with the Angular build, same convention already used
// elsewhere in this ecosystem (e.g. admin-dashboard's rei40-items-meta.ts) since this server has
// no build step importing frontend TS. See rei40-short-items.ts for why "short" is a transparent
// REI-40 subset rather than the unpublished official REI-10.
const REI40_ITEM_IDS = Array.from({ length: 40 }, (_, i) => i + 1);
const REI_SHORT_ITEM_IDS = [1, 2, 6, 11, 12, 21, 22, 26, 31, 34];
const ITEM_IDS_BY_VARIANT = { v1: REI40_ITEM_IDS, short: REI_SHORT_ITEM_IDS };
const VALID_VARIANTS = Object.keys(ITEM_IDS_BY_VARIANT);

// Dual-mode (2026-09-08, extended platform-wide) — DB_MODE=local (.env.local,
// npm run serve:api:local) swaps in a local Postgres client; see local-db.mjs's header comment.
// npm run serve:api:neon (.env) always talks to the real Neon project unchanged.
let dbClient;
function getDb() {
  if (!dbClient) {
    if (process.env.DB_MODE === 'local') {
      const url = process.env.LOCAL_DATABASE_URL;
      if (!url) throw new Error('LOCAL_DATABASE_URL environment variable is not set (DB_MODE=local)');
      dbClient = createLocalSql(url);
      console.log('[db] developer mode: local Postgres');
    } else {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL environment variable is not set');
      dbClient = neon(url);
    }
  }
  return dbClient;
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isScoreNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5;
}

function validatePayload(body) {
  if (typeof body !== 'object' || body === null) return 'body must be an object';
  if (!isNonEmptyString(body.participantId, 50)) return 'participantId invalid';
  if (body.language !== 'sr' && body.language !== 'en') return 'language must be "sr" or "en"';

  if (body.variant !== undefined && !isNonEmptyString(body.variant, 20)) {
    return 'variant must be a non-empty string up to 20 characters';
  }
  const variant = body.variant ?? 'v1';
  if (!VALID_VARIANTS.includes(variant)) return `variant must be one of: ${VALID_VARIANTS.join(', ')}`;
  const itemIds = ITEM_IDS_BY_VARIANT[variant];

  // Timer auto-submit (2026-09-11) — a timed-out submission may legitimately have unanswered
  // items (the participant ran out of time mid-section); everything answered still has to be a
  // valid 1-5 integer, but a missing item is allowed instead of rejecting the whole payload.
  const isTimedOut = body.isTimedOut === true;

  const answers = body.answers;
  if (typeof answers !== 'object' || answers === null) return 'answers must be an object';
  for (const id of itemIds) {
    const v = answers[id] ?? answers[String(id)];
    if (v === undefined || v === null) {
      if (!isTimedOut) return `answers[${id}] must be an integer 1-5`;
      continue;
    }
    if (!Number.isInteger(v) || v < 1 || v > 5) return `answers[${id}] must be an integer 1-5`;
  }

  const scores = body.scores;
  if (typeof scores !== 'object' || scores === null) return 'scores must be an object';
  // The short form only ever reports the 2 composites — RA/RE/EA/EE aren't required (and aren't
  // meaningful from 2-3 items), so they're validated only for the full REI-40 variant. On a timed
  // -out submission a required score may also legitimately be null (the frontend nulls out any
  // subscale with even one unanswered item — a mean from a smaller N wouldn't be comparable to a
  // real completed subscale, matching this app's existing "never fabricate instrument data" rule).
  const requiredScoreKeys = variant === 'short' ? ['rationality', 'experientiality'] : ['RA', 'RE', 'EA', 'EE', 'rationality', 'experientiality'];
  for (const key of requiredScoreKeys) {
    if (isTimedOut && (scores[key] === null || scores[key] === undefined)) continue;
    if (!isScoreNumber(scores[key])) return `scores.${key} must be a number 1-5`;
  }

  return null;
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

app.get('/api/participant/:id', async (req, res) => {
  const id = req.params.id;
  if (!isNonEmptyString(id, 50)) {
    res.status(400).json({ error: 'Invalid participant id' });
    return;
  }
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT r."Rei40Variant", r."TimerRei40Enabled", r."TimerRei40Minutes", p."IsTestParticipant" FROM "Participant" p
      JOIN "Research" r ON r."Id" = p."ResearchId"
      WHERE p."ParticipantId" = ${id}
    `;
    // 2026-09-09 fix — ParticipantId is scoped per research now, not globally unique; this
    // dev-login-only lookup used to silently pick whichever research's row came back first on a
    // same-id collision (the real entry point is the /link/:token magic link, which resolves
    // unambiguously via the token itself, same as before).
    if (rows.length > 1) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!rows.length) {
      res.json({ exists: false });
      return;
    }
    // The dev-login form (/login) is test-participants-only now — every real participant arrives
    // exclusively via their emailed magic link (/api/link/:token above), which never hits this
    // check since it's already proof of authorization on its own.
    if (!rows[0].IsTestParticipant) {
      res.status(403).json({ error: 'PERSONAL_LINK_REQUIRED' });
      return;
    }
    res.json({
      exists: true,
      rei40Variant: rows[0].Rei40Variant ?? 'v1',
      // Per-app participant timer (2026-09-11) — null minutes whenever disabled, matching the
      // admin-dashboard PUT's own "Enabled=false forces Minutes=null" guarantee.
      timerEnabled: rows[0].TimerRei40Enabled === true,
      timerMinutes: rows[0].TimerRei40Enabled ? rows[0].TimerRei40Minutes : null,
      isTestParticipant: true,
    });
  } catch (err) {
    console.error('[DB] participant check error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Magic-link resolution (Phase C of the consent/token project — see beyondai's CLAUDE.md):
// participants reach this app exclusively via an emailed /link/:token URL now, issued by the
// Consent app. Resolves against SurveyAccessToken (SurveyType='REI40') + Rei40Result as the
// completion signal, same as the plan's design — no separate "consumed" flag on the token row.
app.get('/api/link/:token', async (req, res) => {
  const token = req.params.token;
  if (!isNonEmptyString(token, 64)) {
    res.status(400).json({ error: 'Invalid token' });
    return;
  }
  try {
    const sql = getDb();
    // Joins on ParticipantGuid, not the bare ParticipantId — item 1 of admin-dashboard's
    // "platform improvements round 2" plan scoped ParticipantId per research (no longer globally
    // unique), and SurveyAccessToken already carries its own resolved ParticipantGuid. Joining on
    // the bare string here would risk resolving the WRONG participant's Language/Rei40Variant (and
    // wrong ALREADY_COMPLETED check below) if two researches happen to share this ParticipantId —
    // the Token itself is what's actually unique and already fully resolves which participant this
    // is, so the JOIN should follow that resolution, not re-derive it from a string that can collide.
    const rows = await sql`
      SELECT sat."ParticipantId", sat."ParticipantGuid", sat."ExpiresAt", p."Language", r."Rei40Variant", r."ConsentPortalActive",
             r."TimerRei40Enabled", r."TimerRei40Minutes"
      FROM "SurveyAccessToken" sat
      JOIN "Participant" p ON p."Guid" = sat."ParticipantGuid"
      JOIN "Research" r ON r."Id" = p."ResearchId"
      WHERE sat."Token" = ${token} AND sat."SurveyType" = 'REI40'
      LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const row = rows[0];
    if (new Date(row.ExpiresAt) < new Date()) {
      res.status(410).json({ error: 'EXPIRED' });
      return;
    }
    // 2026-09-09 master pause switch — same Research.ConsentPortalActive column the Consent
    // app's slug-link Activate/Deactivate toggle writes; a researcher pausing a research now also
    // closes already-issued REI-40 links, not just new Consent-app visits.
    if (!row.ConsentPortalActive) {
      res.status(403).json({ error: 'NOT_ACTIVE' });
      return;
    }
    const existing = await sql`SELECT 1 FROM "Rei40Result" WHERE "ParticipantGuid" = ${row.ParticipantGuid} LIMIT 1`;
    if (existing.length) {
      res.status(409).json({ error: 'ALREADY_COMPLETED' });
      return;
    }
    res.json({
      participantId: row.ParticipantId,
      lang: row.Language ?? 'sr',
      rei40Variant: row.Rei40Variant ?? 'v1',
      timerEnabled: row.TimerRei40Enabled === true,
      timerMinutes: row.TimerRei40Enabled ? row.TimerRei40Minutes : null,
    });
  } catch (err) {
    console.error('[DB] link resolve error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

const CODE_REVIEW_APP_URL = process.env.CODE_REVIEW_APP_URL || 'http://localhost:4202';
// Same lifetime as admin-dashboard-andrejkatin's own CODE_REVIEW_TOKEN_TTL_MS — effectively
// permanent (2026-10-02 follow-up, was 90 days), meant to be reused for the participant's whole
// study run (Intro, both experimental sessions, every NASA-TLX handoff round-trip), not a
// one-shot 7-day instrument link.
const CODE_REVIEW_TOKEN_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Fires once, automatically, the moment a real (non-test) participant has completed BOTH REI-40
 * and Big Five — called from this app's own POST /api/result AND from bigfive-andrejkatin's own
 * identical copy of this function, since either submission could be the one that completes the
 * pair. Mints a CODE_REVIEW magic link (the same token type code-review-ai's own
 * ResolveParticipantIdByLinkTokenAsync already resolves, and the same type admin-dashboard's
 * Participant Detail "Generate" button already mints manually) and emails it.
 *
 * Race-safety: both apps' handlers independently check "is the sibling done too?" right after
 * their own insert, so a near-simultaneous finish could have both see "yes" at once. The atomic
 * `UPDATE ... WHERE "IntroEmailSentAt" IS NULL RETURNING ...` below is the actual guard — only
 * the caller that flips NULL -> NOW() proceeds to mint+send; the loser sees zero rows back and
 * exits quietly. Never throws into the caller — always caught there, log-only, since this must
 * never affect the participant's own submission response.
 */
async function maybeSendIntroEmail(sql, participantGuid) {
  const rows = await sql`
    SELECT p."Email", p."Language", r."TaskType", r."EmailSenderName", r."StudyDisplayName", r."Name" AS "ResearchName"
    FROM "Participant" p JOIN "Research" r ON r."Id" = p."ResearchId"
    WHERE p."Guid" = ${participantGuid}
  `;
  const p = rows[0];
  if (!p || p.TaskType !== 'PR_REVIEW') return;

  const rei40Done = await sql`SELECT 1 FROM "Rei40Result" WHERE "ParticipantGuid" = ${participantGuid} LIMIT 1`;
  if (!rei40Done.length) return;
  const bigfiveDone = await sql`SELECT 1 FROM "BigFiveResult" WHERE "ParticipantGuid" = ${participantGuid} LIMIT 1`;
  if (!bigfiveDone.length) return;

  const claim = await sql`
    UPDATE "Participant" SET "IntroEmailSentAt" = NOW()
    WHERE "Guid" = ${participantGuid} AND "IntroEmailSentAt" IS NULL
    RETURNING "ParticipantId"
  `;
  if (!claim.length) return;
  if (!p.Email) return;

  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CODE_REVIEW_TOKEN_TTL_MS).toISOString();
  await sql`
    INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
    VALUES (${claim[0].ParticipantId}, ${participantGuid}, 'CODE_REVIEW', ${token}, ${expiresAt})
    ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
      "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
  `;

  const url = `${CODE_REVIEW_APP_URL}/?link=${token}`;
  const senderName = p.EmailSenderName ?? p.StudyDisplayName ?? p.ResearchName ?? undefined;
  const { subject, html } = buildIntroTaskEmail(p.Language ?? 'sr', { url, senderName });
  await sendMail({ to: p.Email, subject, html, fromName: senderName });
}

app.post('/api/result', async (req, res) => {
  const validationError = validatePayload(req.body);
  if (validationError) {
    res.status(400).json({ error: `Invalid payload: ${validationError}` });
    return;
  }
  try {
    const sql = getDb();
    const b = req.body;
    const variant = b.variant ?? 'v1';
    const itemIds = ITEM_IDS_BY_VARIANT[variant];

    // Normalize answers to a plain {"<id>": n, ...} JSON object for storage — only the ids this
    // variant actually asked (10 for "short", 40 for "v1"), not a fixed 1-40 range.
    const answersJson = {};
    for (const id of itemIds) {
      answersJson[id] = b.answers[id] ?? b.answers[String(id)];
    }

    // Every submission needs to know whether this is a repeatable test participant (upsert, no
    // token needed) or a real one (token required, one-shot). Looked up by the bare id here since
    // the participant already exists by this point regardless of path — a genuine cross-research
    // collision would mean two DIFFERENT participants share this id, which the token check right
    // below resolves unambiguously for the real-participant path anyway.
    const participantRows = await sql`SELECT "Guid", "IsTestParticipant" FROM "Participant" WHERE "ParticipantId" = ${b.participantId}`;
    if (participantRows.length !== 1) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const isTestParticipant = participantRows[0].IsTestParticipant === true;

    if (!isTestParticipant) {
      // Defense in depth — a real participant must present the same REI40 token they resolved
      // via GET /api/link/:token, re-validated against this exact participant, so this endpoint
      // is never reachable just by guessing/replaying a participant id.
      const tokenRows = !isNonEmptyString(b.token, 64)
        ? []
        : await sql`
            SELECT 1 FROM "SurveyAccessToken"
            WHERE "Token" = ${b.token} AND "SurveyType" = 'REI40' AND "ParticipantGuid" = ${participantRows[0].Guid} AND "ExpiresAt" > NOW()
          `;
      if (!tokenRows.length) {
        res.status(403).json({ error: 'PERSONAL_LINK_REQUIRED' });
        return;
      }

      // "No editing after submission" — the magic-link path (GET /api/link/:token) already blocks
      // re-entry once a result exists, but that's a UI-reachability gate, not an independent guard
      // on this endpoint itself. Enforce it here directly instead of unconditionally upserting.
      // Joined on ParticipantGuid, not the bare ParticipantId — same reasoning as every other
      // Guid-based check in this file (ParticipantId is scoped per research, not globally unique).
      const existing = await sql`SELECT 1 FROM "Rei40Result" WHERE "ParticipantGuid" = ${participantRows[0].Guid} LIMIT 1`;
      if (existing.length) {
        res.status(409).json({ error: 'ALREADY_COMPLETED' });
        return;
      }

      await sql`
        INSERT INTO "Rei40Result" (
          "ParticipantId", "Language", "Answers",
          "RationalAbility", "RationalEngagement", "ExperientialAbility", "ExperientialEngagement",
          "Rationality", "Experientiality", "Variant", "IsTimedOut"
        ) VALUES (
          ${b.participantId}, ${b.language}, ${JSON.stringify(answersJson)},
          ${b.scores.RA ?? null}, ${b.scores.RE ?? null}, ${b.scores.EA ?? null}, ${b.scores.EE ?? null},
          ${b.scores.rationality ?? null}, ${b.scores.experientiality ?? null}, ${variant}, ${b.isTimedOut === true}
        )
      `;
      res.status(201).json({ ok: true });
      maybeSendIntroEmail(sql, participantRows[0].Guid).catch((err) =>
        console.error('[rei40] intro email trigger failed:', err)
      );
      return;
    }

    // Test participant — always upserts, only the latest submission is ever kept.
    await sql`
      INSERT INTO "Rei40Result" (
        "ParticipantId", "Language", "Answers",
        "RationalAbility", "RationalEngagement", "ExperientialAbility", "ExperientialEngagement",
        "Rationality", "Experientiality", "Variant", "IsTimedOut"
      ) VALUES (
        ${b.participantId}, ${b.language}, ${JSON.stringify(answersJson)},
        ${b.scores.RA ?? null}, ${b.scores.RE ?? null}, ${b.scores.EA ?? null}, ${b.scores.EE ?? null},
        ${b.scores.rationality ?? null}, ${b.scores.experientiality ?? null}, ${variant}, ${b.isTimedOut === true}
      )
      ON CONFLICT ("ParticipantGuid") DO UPDATE SET
        "Language" = EXCLUDED."Language", "Answers" = EXCLUDED."Answers",
        "RationalAbility" = EXCLUDED."RationalAbility", "RationalEngagement" = EXCLUDED."RationalEngagement",
        "ExperientialAbility" = EXCLUDED."ExperientialAbility", "ExperientialEngagement" = EXCLUDED."ExperientialEngagement",
        "Rationality" = EXCLUDED."Rationality", "Experientiality" = EXCLUDED."Experientiality",
        "Variant" = EXCLUDED."Variant", "IsTimedOut" = EXCLUDED."IsTimedOut", "CompletedAt" = NOW()
    `;
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[DB] save result error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.listen(PORT, () => {
  console.log(`REI-40 API server listening on http://localhost:${PORT}`);
});
