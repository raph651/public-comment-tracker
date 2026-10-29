/**
 * Two workers over one append-only store.
 *
 *   fetcher    Regulations.gov v4  ->  data/list.jsonl, data/details.jsonl
 *   classifier Gemini               ->  data/classifications.jsonl
 *
 * They run concurrently: the fetcher is rate-limited to ~900 detail calls/hour
 * so it dominates wall-clock time, while the classifier drains text as it
 * lands. Both append only (never rewrite), so they can run at the same time
 * without locking, and a crash loses at most one buffered line.
 *
 * A final pass merges the three files into docs/data/summary.json and
 * docs/data/history.json, which is all the page reads.
 *
 *   node --experimental-strip-types scripts/pipeline.ts [options]
 *
 *     --details N      cap detail fetches this run (default: unlimited)
 *     --list-only      refresh the comment list, skip details/classification
 *     --build-only     rebuild artifacts from existing files, no network
 *     --fast           ~300ms between calls (for small bounded runs only)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Stance = 'Support' | 'Oppose' | "Can't tell";
type ClassifiedBy = 'gemini' | 'heuristic' | 'campaign-template';

interface ListRecord {
  id: string;
  title: string;
  postedDate: string;
  lastModifiedDate: string;
  campaignId: string | null;
  withdrawn: boolean;
}

interface DetailRecord {
  id: string;
  text: string;
  submitterName: string;
}

interface ClassRecord {
  id: string;
  stance: Stance;
  reason: string;
  by: ClassifiedBy;
}

interface HistoryPoint {
  t: string;
  support: number;
  oppose: number;
  cantTell: number;
  total: number;
}

const ROOT = process.cwd();

interface DocketConfig {
  slug: string;
  documentId: string;
  docketId: string;
  title: string;
  epoch: string;
  deadlineIso: string;
  deadlineDisplay: string;
}

const DOCKETS: Record<string, DocketConfig> = {
  h1b: {
    slug: 'h1b',
    documentId: 'USCIS-2026-0364-0001',
    docketId: 'USCIS-2026-0364',
    title: 'Eliminating the Discretionary 60-Day Grace Period',
    epoch: '2026-09-11 00:00:00',
    deadlineIso: '2026-11-11T04:59:59Z',
    deadlineDisplay: 'Nov 10, 2026 at 11:59 PM EST'
  },
  opt: {
    slug: 'opt',
    documentId: 'ICEB-2026-0100-0001',
    docketId: 'ICEB-2026-0100',
    title: 'Optional Practical Training Fees',
    epoch: '2026-10-07 00:00:00',
    deadlineIso: '2026-11-10T04:59:59Z',
    deadlineDisplay: 'Nov 9, 2026 at 11:59 PM EST'
  }
};

// Parsed inline: --docket opt (defaults to the H-1B docket).
const docketArgIndex = process.argv.indexOf('--docket');
const DOCKET =
  DOCKETS[docketArgIndex >= 0 ? process.argv[docketArgIndex + 1] ?? 'h1b' : 'h1b'] ?? DOCKETS.h1b;

const DATA_DIR = path.join(ROOT, 'data', DOCKET.slug);
const LIST_PATH = path.join(DATA_DIR, 'list.jsonl');
const DETAILS_PATH = path.join(DATA_DIR, 'details.jsonl');
const CLASSES_PATH = path.join(DATA_DIR, 'classifications.jsonl');
const STATE_PATH = path.join(DATA_DIR, 'fetch-state.json');
const SUMMARY_PATH = path.join(ROOT, 'docs', 'data', DOCKET.slug, 'summary.json');
const HISTORY_PATH = path.join(ROOT, 'docs', 'data', DOCKET.slug, 'history.json');

const DOCUMENT_ID = DOCKET.documentId;
const DOCKET_ID = DOCKET.docketId;
const DEADLINE_ISO = DOCKET.deadlineIso;
const EPOCH = DOCKET.epoch;

const API_KEY = process.env.REGULATIONS_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string): string | null => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? null : null;
};

const DETAIL_CAP = option('details') ? Number(option('details')) : Infinity;
const LIST_ONLY = flag('list-only');
const CLASSIFY_ONLY = flag('classify-only');
const RECLASSIFY = flag('reclassify');
const REPAIR = flag('repair');
const BUILD_ONLY = flag('build-only');
const FAST = flag('fast');

const LIST_DELAY_MS = FAST ? 120 : 300;
const DETAIL_DELAY_MS = FAST ? 300 : 3600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------- store ------------------------------- */

function ensureData(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function appendLines(file: string, rows: unknown[]): void {
  if (rows.length === 0) return;
  fs.appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}

function readLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn final line during a concurrent append; skip it.
    }
  }
  return out;
}

function readState(): { listDone: boolean; totalSeen: number; cursor: string | null } {
  if (!fs.existsSync(STATE_PATH)) return { listDone: false, totalSeen: 0, cursor: null };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { listDone: false, totalSeen: 0, cursor: null };
  }
}

function writeState(state: { listDone: boolean; totalSeen: number; cursor: string | null }): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/* ---------------------------- regulations ---------------------------- */

function campaignOf(title: string): string | null {
  const match = title.match(/\b(MM\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function stamp(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

async function apiGet(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status !== 429) return response;
      const wait = 20_000 * (attempt + 1);
      console.warn(`  429 rate limited; waiting ${wait / 1000}s`);
      await sleep(wait);
    } catch (error) {
      // Transient socket/HTTP2 failures kill a 23-hour sweep if unhandled.
      const wait = Math.min(60_000, 2_000 * 2 ** attempt);
      console.warn(`  network error (${(error as Error).message}); retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new Error('Regulations.gov unreachable after retries');
}

async function resolveObjectId(): Promise<string> {
  const response = await apiGet(
    `https://api.regulations.gov/v4/documents/${DOCUMENT_ID}?api_key=${encodeURIComponent(API_KEY)}`
  );
  if (!response.ok) throw new Error(`document metadata HTTP ${response.status}`);
  const json = (await response.json()) as { data?: { attributes?: { objectId?: string } } };
  const objectId = json.data?.attributes?.objectId;
  if (!objectId) throw new Error('could not resolve objectId');
  return objectId;
}

/**
 * Enumerate every comment. The v4 API caps one query at 20 pages x 250 rows
 * (5,000 comments), so walk `lastModifiedDate` forward window by window.
 */
async function fetchWorker(objectId: string): Promise<void> {
  const stored = readLines<ListRecord>(LIST_PATH);
  const known = new Set(stored.map((row) => row.id));
  const state = readState();
  // Without a saved cursor (fresh store, e.g. straight after a bulk ingest),
  // start from the newest comment we already hold instead of re-walking the
  // whole docket — otherwise the first window finds nothing and stops.
  const newest = stored.reduce((latest, row) => (row.lastModifiedDate > latest ? row.lastModifiedDate : latest), '');
  let cursor = state.cursor || (newest ? stamp(newest) : EPOCH);
  let seen = known.size;
  let windowCount = 0;

  console.log(`[fetch] starting from ${cursor} (${known.size} already stored)`);

  while (windowCount < 20) {
    windowCount++;
    let lastDate: string | null = null;
    let added = 0;

    for (let page = 1; page <= 20; page++) {
      const url = new URL('https://api.regulations.gov/v4/comments');
      url.searchParams.set('filter[commentOnId]', objectId);
      url.searchParams.set('filter[lastModifiedDate][ge]', cursor);
      url.searchParams.set('page[size]', '250');
      url.searchParams.set('page[number]', String(page));
      url.searchParams.set('sort', 'lastModifiedDate,documentId');
      url.searchParams.set('api_key', API_KEY);

      const response = await apiGet(url.toString());
      if (!response.ok) throw new Error(`list HTTP ${response.status} (window ${windowCount} page ${page})`);

      const json = (await response.json()) as {
        data?: Array<{
          id: string;
          attributes?: {
            title?: string;
            postedDate?: string;
            lastModifiedDate?: string;
            withdrawn?: boolean;
          };
        }>;
        meta?: { hasNextPage?: boolean };
      };

      const rows = json.data || [];
      if (rows.length === 0) break;

      const fresh: ListRecord[] = [];
      for (const row of rows) {
        const title = row.attributes?.title || `Comment ${row.id}`;
        const record: ListRecord = {
          id: row.id,
          title,
          postedDate: row.attributes?.postedDate || '',
          lastModifiedDate: row.attributes?.lastModifiedDate || '',
          campaignId: campaignOf(title),
          withdrawn: Boolean(row.attributes?.withdrawn)
        };
        if (row.attributes?.lastModifiedDate) lastDate = row.attributes.lastModifiedDate;
        if (!known.has(row.id)) {
          known.add(row.id);
          fresh.push(record);
        }
      }

      appendLines(LIST_PATH, fresh);
      added += fresh.length;
      seen += fresh.length;

      if (page % 10 === 0) console.log(`[fetch] window ${windowCount} page ${page}: ${seen} total`);

      // A short page ends this window, not the docket.
      if (!json.meta?.hasNextPage || rows.length < 250) break;
      await sleep(LIST_DELAY_MS);
    }

    writeState({ listDone: false, totalSeen: seen, cursor });

    const nextCursor = lastDate ? stamp(lastDate) : cursor;
    console.log(`[fetch] window ${windowCount} done: +${added}, cursor -> ${nextCursor}`);
    // A window with no new rows is not the end of the docket; only a cursor
    // that cannot advance terminates the walk.
    if (nextCursor === cursor) break;

    cursor = nextCursor;
    await sleep(LIST_DELAY_MS);
  }

  writeState({ listDone: true, totalSeen: seen, cursor });
  console.log(`[fetch] list complete: ${seen} comments`);

  if (LIST_ONLY) return;

  await fetchDetails();
}

/** One detail call per individual comment, plus one representative per campaign. */
async function fetchDetails(): Promise<void> {
  const list = dedupeById(readLines<ListRecord>(LIST_PATH)).filter((row) => !row.withdrawn);
  const haveText = new Set(readLines<DetailRecord>(DETAILS_PATH).map((row) => row.id));

  const campaignSeen = new Set<string>();
  const queue: ListRecord[] = [];

  for (const row of list) {
    if (haveText.has(row.id)) {
      if (row.campaignId) campaignSeen.add(row.campaignId);
      continue;
    }
    if (row.campaignId) {
      if (campaignSeen.has(row.campaignId)) continue;
      campaignSeen.add(row.campaignId);
    }
    queue.push(row);
  }

  const budget = Math.min(queue.length, Number.isFinite(DETAIL_CAP) ? DETAIL_CAP : Infinity);
  console.log(`[fetch] ${queue.length} comments need text; fetching ${budget} this run`);

  for (let index = 0; index < budget; index++) {
    const row = queue[index];
    const startedAt = Date.now();
    const response = await apiGet(
      `https://api.regulations.gov/v4/comments/${row.id}?api_key=${encodeURIComponent(API_KEY)}`
    );

    if (response.ok) {
      const json = (await response.json()) as {
        data?: {
          attributes?: { comment?: string; firstName?: string; lastName?: string; organization?: string };
        };
      };
      const attributes = json.data?.attributes;
      const fullName = [attributes?.firstName, attributes?.lastName].filter(Boolean).join(' ').trim();
      appendLines(DETAILS_PATH, [
        {
          id: row.id,
          text: (attributes?.comment || '').trim(),
          submitterName: attributes?.organization || fullName || ''
        }
      ]);
    }

    if ((index + 1) % 25 === 0) {
      console.log(`[fetch] details ${index + 1}/${budget}`);
    }
    // Pace from request start, so response latency doesn't eat into the
    // 1,000 calls/hour budget.
    if (index + 1 < budget) {
      const remaining = DETAIL_DELAY_MS - (Date.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    }
  }

  console.log(`[fetch] details done: ${budget}`);
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of rows) map.set(row.id, row);
  return [...map.values()];
}

/* ------------------------------- gemini ------------------------------- */

export function heuristicStance(text: string, title: string): { stance: Stance; reason: string } {
  const combined = `${title}\n${text}`.toLowerCase();

  if (/\bmm78\b/.test(combined)) return { stance: 'Support', reason: 'MM78 campaign supports eliminating the 60-day grace period.' };
  if (/\bmm83\b/.test(combined)) return { stance: 'Support', reason: 'MM83 campaign favors ending the 60-day grace period.' };
  if (/\bmm73\b/.test(combined)) return { stance: 'Support', reason: 'MM73 campaign urges eliminating the 60-day grace period.' };

  const oppose = [
    /oppose\s+(dhs'?s?\s+)?(proposal|proposed\s+rule|eliminating|removing|removal)/i,
    /strongly\s+oppose/i,
    /respectfully\s+oppose/i,
    /retain\s+the\s+(up-to-)?60-day\s+grace\s+period/i,
    /keep\s+the\s+(60-day\s+)?grace\s+period/i,
    /do\s+not\s+(eliminate|remove|end)\s+the\s+(discretionary\s+)?(60-day\s+)?grace\s+period/i,
    /against\s+(eliminating|removing)\s+the\s+(60-day\s+)?grace\s+period/i
  ];
  const support = [
    /support\s+(eliminating|removing|ending)\s+the\s+(discretionary\s+)?(60-day\s+)?grace\s+period/i,
    /in\s+favor\s+of\s+(ending|eliminating|removing)\s+the\s+(60[\s-]day\s+)?grace\s+period/i,
    /finalize\s+elimination\s+of\s+the\s+60-day\s+grace\s+period/i,
    /support\s+(this|the)\s+proposed\s+rule/i,
    /american\s+jobs\s+for\s+americans/i,
    /end\s+h-?1b/i
  ];

  for (const pattern of oppose) {
    if (pattern.test(combined)) {
      return { stance: 'Oppose', reason: 'Opposes eliminating the 60-day grace period.' };
    }
  }
  for (const pattern of support) {
    if (pattern.test(combined)) {
      return { stance: 'Support', reason: 'Supports the proposed rule.' };
    }
  }
  return { stance: "Can't tell", reason: 'No explicit stance in the comment text.' };
}

const PROMPT_HEADER = `You are classifying public comments on DHS/USCIS Proposed Rule USCIS-2026-0364-0001 ("Eliminating the Discretionary 60-Day Grace Period").

The rule ELIMINATES the discretionary up-to-60-day grace period for E-1, E-2, E-3, H-1B, H-1B1, L-1, O-1 and TN workers after employment ends.

Classify each comment's stance toward the PROPOSED RULE with exactly one label:
- "Support": wants to eliminate, end, shorten or restrict the grace period.
- "Oppose": wants to keep or retain the grace period, or argues removing it harms workers, employers or families.
- "Can't tell": text is entirely ambiguous, off-topic, or attachment-only.

Return ONLY a JSON array of objects with keys "id", "stance", "reason" (one short sentence, under 140 chars).`;

const STRICT_PROMPT_HEADER = `You are re-checking comments that were previously marked "Can't tell" on DHS/USCIS Proposed Rule USCIS-2026-0364-0001 ("Eliminating the Discretionary 60-Day Grace Period").

The rule eliminates the discretionary up-to-60-day grace period for E-1, E-2, E-3, H-1B, H-1B1, L-1, O-1 and TN workers after employment ends.

Decide each comment's stance toward THIS rule:
- "Support": wants to eliminate, end, shorten or restrict the grace period.
- "Oppose": wants to keep or retain it, or argues removal harms workers, employers or families.
- "Can't tell": ONLY for punctuation, greetings, bare "see attached", or a different rule entirely.

Follow these rules:
1. Read the whole text including the opening line. Stances are often phrased as "I agree with this rule", "I oppose this proposed rule", or "end this".
2. Your "reason" MUST start with the exact sentence that decides it, in double quotes, followed by a short justification.
3. Never fall back to "Can't tell" merely because a keyword is absent. Infer meaning.
4. If the comment addresses a different docket (for example the USCIS-2026-0298 H-1B fee rule), answer "Can't tell".

Return ONLY a JSON array of objects with keys "id", "stance", "reason".`;

async function classifyBatch(
  items: Array<{ id: string; title: string; text: string }>,
  promptHeader: string = PROMPT_HEADER
): Promise<Map<string, ClassRecord>> {
  const results = new Map<string, ClassRecord>();

  if (!GEMINI_KEY) {
    for (const item of items) {
      results.set(item.id, { id: item.id, ...heuristicStance(item.text, item.title), by: 'heuristic' });
    }
    return results;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `${promptHeader}\n\nComments:\n${JSON.stringify(
                    items.map((item) => ({ id: item.id, title: item.title, text: item.text.slice(0, 1500) })),
                    null,
                    1
                  )}`
                }
              ]
            }
          ],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        })
      }
    );

    if (!response.ok) throw new Error(`gemini HTTP ${response.status}`);

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '[]';
    const parsed = JSON.parse(raw) as Array<{ id: string; stance: Stance; reason: string }>;

    for (const row of parsed) {
      const stance: Stance =
        row.stance === 'Support' || row.stance === 'Oppose' || row.stance === "Can't tell" ? row.stance : "Can't tell";
      results.set(row.id, { id: row.id, stance, reason: row.reason || 'Classified by Gemini.', by: 'gemini' });
    }
  } catch (error) {
    // Retry a transient failure before degrading 20 comments to the keyword
    // matcher, whose abstentions are indistinguishable from real ambiguity.
    let recovered = false;
    for (let attempt = 0; attempt < 3 && !recovered; attempt++) {
      const wait = 2000 * 2 ** attempt;
      console.warn(`[classify] batch failed (${(error as Error).message}); retry in ${wait / 1000}s`);
      await sleep(wait);
      try {
        const retry = await fetch(GEMINI_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${PROMPT_HEADER}\n\nComments:\n${JSON.stringify(
              items.map((item) => ({ id: item.id, title: item.title, text: item.text.slice(0, 1500) })),
              null,
              1
            )}` }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
          })
        });
        if (!retry.ok) throw new Error(`gemini HTTP ${retry.status}`);
        const data = (await retry.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '[]';
        for (const row of JSON.parse(raw) as Array<{ id: string; stance: Stance; reason: string }>) {
          const stance: Stance =
            row.stance === 'Support' || row.stance === 'Oppose' || row.stance === "Can't tell" ? row.stance : "Can't tell";
          results.set(row.id, { id: row.id, stance, reason: row.reason || 'Classified by Gemini.', by: 'gemini' });
        }
        recovered = true;
      } catch (retryError) {
        if (attempt === 2) {
          console.warn(`[classify] giving up on batch: ${(retryError as Error).message}`);
        }
      }
    }
  }

  for (const item of items) {
    if (!results.has(item.id)) {
      results.set(item.id, { id: item.id, ...heuristicStance(item.text, item.title), by: 'heuristic' });
    }
  }

  return results;
}

/** Drains text that the fetcher has landed. Exits once the fetcher is done. */
async function classifyWorker(isFetchDone: () => boolean): Promise<void> {
  const done = new Set(readLines<ClassRecord>(CLASSES_PATH).map((row) => row.id));
  let idle = 0;

  while (true) {
    const list = dedupeById(readLines<ListRecord>(LIST_PATH));
    const details = new Map(readLines<DetailRecord>(DETAILS_PATH).map((row) => [row.id, row]));

    const pending = list
      .filter((row) => !done.has(row.id))
      .map((row) => ({ id: row.id, title: row.title, text: details.get(row.id)?.text || '' }))
      .filter((row) => row.text.length > 0);

    if (pending.length === 0) {
      if (isFetchDone()) {
        console.log(`[classify] nothing left; ${done.size} comments classified`);
        return;
      }
      idle++;
      if (idle % 10 === 0) console.log('[classify] waiting for text…');
      await sleep(3000);
      continue;
    }

    idle = 0;
    const { reps, twins } = dedupeByText(pending);
    for (let index = 0; index < reps.length; index += 20) {
      const batch = reps.slice(index, index + 20);
      const results = await classifyBatch(batch);
      const rows = expandTwins([...results.values()], twins);
      appendLines(CLASSES_PATH, rows);
      for (const row of rows) done.add(row.id);
      console.log(`[classify] ${done.size} classified (+${rows.length})`);
      await sleep(200);
    }
  }
}

/** Form letters share identical text; classify each distinct text once. */
export function dedupeByText(items: Array<{ id: string; title: string; text: string }>): {
  reps: Array<{ id: string; title: string; text: string }>;
  twins: Map<string, string[]>;
} {
  const groups = new Map<string, { rep: { id: string; title: string; text: string }; ids: string[] }>();
  for (const item of items) {
    const key = item.text.trim();
    const hit = groups.get(key);
    if (hit) hit.ids.push(item.id);
    else groups.set(key, { rep: item, ids: [item.id] });
  }

  const reps: Array<{ id: string; title: string; text: string }> = [];
  const twins = new Map<string, string[]>();
  for (const { rep, ids } of groups.values()) {
    reps.push(rep);
    if (ids.length > 1) twins.set(rep.id, ids.slice(1));
  }
  return { reps, twins };
}

/** Copy a representative's label onto every comment sharing its text. */
export function expandTwins(rows: ClassRecord[], twins: Map<string, string[]>): ClassRecord[] {
  const out: ClassRecord[] = [...rows];
  for (const row of rows) {
    for (const twinId of twins.get(row.id) ?? []) out.push({ ...row, id: twinId });
  }
  return out;
}

async function repairHeuristic(): Promise<void> {
  const classes = new Map(readLines<ClassRecord>(CLASSES_PATH).map((row) => [row.id, row]));
  const list = dedupeById(readLines<ListRecord>(LIST_PATH));
  const details = new Map(readLines<DetailRecord>(DETAILS_PATH).map((row) => [row.id, row]));

  const targets = list
    .filter((row) => {
      const record = classes.get(row.id);
      return !record || record.by === 'heuristic';
    })
    .map((row) => ({ id: row.id, title: row.title, text: details.get(row.id)?.text || '' }));

  const { reps, twins } = dedupeByText(targets);
  console.log(
    `[repair] ${targets.length} comments classified by the keyword fallback ` +
      `(${reps.length} distinct texts after dedupe)`
  );
  let fixed = 0;

  for (let index = 0; index < reps.length; index += 20) {
    const batch = reps.slice(index, index + 20);
    const results = await classifyBatch(batch, STRICT_PROMPT_HEADER);
    const rows = expandTwins([...results.values()], twins);
    appendLines(CLASSES_PATH, rows);
    fixed += rows.filter((row) => row.by === 'gemini').length;
    if ((index / 20) % 10 === 0) console.log(`[repair] ${Math.min(index + 20, reps.length)}/${reps.length} · ${fixed} now Gemini`);
    await sleep(200);
  }

  console.log(`[repair] done: ${fixed} of ${targets.length} moved to Gemini`);
}

async function reclassifyCantTell(): Promise<void> {
  const classes = new Map(readLines<ClassRecord>(CLASSES_PATH).map((row) => [row.id, row]));
  const list = dedupeById(readLines<ListRecord>(LIST_PATH));
  const details = new Map(readLines<DetailRecord>(DETAILS_PATH).map((row) => [row.id, row]));

  const targets = list
    .filter((row) => classes.get(row.id)?.stance === "Can't tell")
    .map((row) => ({ id: row.id, title: row.title, text: details.get(row.id)?.text || '' }));

  console.log(`[reclassify] ${targets.length} comments previously marked can't tell`);
  let resolved = 0;

  for (let index = 0; index < targets.length; index += 20) {
    const batch = targets.slice(index, index + 20);
    const results = await classifyBatch(batch, STRICT_PROMPT_HEADER);
    const rows = [...results.values()];
    appendLines(CLASSES_PATH, rows);
    resolved += rows.filter((row) => row.stance !== "Can't tell").length;
    console.log(`[reclassify] ${Math.min(index + 20, targets.length)}/${targets.length} · ${resolved} resolved`);
    await sleep(200);
  }

  console.log(`[reclassify] done: ${resolved} of ${targets.length} resolved to a stance`);
}

/* ------------------------------ artifacts ------------------------------ */

function niceDay(iso: string): string {
  return iso.slice(0, 10);
}

function dailySeries(rows: Array<{ postedDate: string; stance: Stance }>): HistoryPoint[] {
  const byDay = new Map<string, { support: number; oppose: number; cantTell: number; total: number; last: string }>();
  for (const row of rows) {
    if (!row.postedDate) continue;
    const day = niceDay(row.postedDate);
    const bucket = byDay.get(day) ?? { support: 0, oppose: 0, cantTell: 0, total: 0, last: row.postedDate };
    if (row.stance === 'Support') bucket.support++;
    else if (row.stance === 'Oppose') bucket.oppose++;
    else bucket.cantTell++;
    bucket.total++;
    if (row.postedDate > bucket.last) bucket.last = row.postedDate;
    byDay.set(day, bucket);
  }

  let running = { support: 0, oppose: 0, cantTell: 0, total: 0 };
  return [...byDay.keys()].sort().map((day) => {
    const bucket = byDay.get(day)!;
    running = {
      support: running.support + bucket.support,
      oppose: running.oppose + bucket.oppose,
      cantTell: running.cantTell + bucket.cantTell,
      total: running.total + bucket.total
    };
    return { t: bucket.last, ...running };
  });
}

function buildArtifacts(): void {
  const list = dedupeById(readLines<ListRecord>(LIST_PATH)).filter((row) => !row.withdrawn);
  const details = new Map(readLines<DetailRecord>(DETAILS_PATH).map((row) => [row.id, row]));
  const classes = new Map(readLines<ClassRecord>(CLASSES_PATH).map((row) => [row.id, row]));

  const merged = list.map((row) => {
    const detail = details.get(row.id);
    const classification = classes.get(row.id);
    return {
      id: row.id,
      title: row.title,
      submitterName: detail?.submitterName || extractSubmitter(row.title),
      postedDate: row.postedDate,
      lastModifiedDate: row.lastModifiedDate,
      campaignId: row.campaignId,
      commentText: detail?.text || '',
      stance: (classification?.stance ?? "Can't tell") as Stance,
      reason: classification?.reason || 'Not yet classified.',
      classifiedBy: (classification?.by ?? 'heuristic') as ClassifiedBy,
      url: `https://www.regulations.gov/comment/${row.id}`
    };
  });

  // Propagate one classified representative across its whole campaign.
  const templates = new Map<string, { stance: Stance; reason: string }>();
  for (const row of merged) {
    if (row.campaignId && row.commentText && classes.has(row.id) && !templates.has(row.campaignId)) {
      templates.set(row.campaignId, { stance: row.stance, reason: row.reason });
    }
  }
  for (const row of merged) {
    const template = row.campaignId ? templates.get(row.campaignId) : undefined;
    if (template) {
      row.stance = template.stance;
      row.reason = template.reason;
      row.classifiedBy = 'campaign-template';
    }
  }

  // Never publish a split where unclassified rows masquerade as "Can't tell".
  const pending = merged.filter((row) => row.reason === 'Not yet classified.').length;
  if (pending > merged.length * 0.01 && !flag('force')) {
    console.error(
      `[build] refusing to publish: ${pending.toLocaleString()} of ${merged.length.toLocaleString()} comments ` +
        `are unclassified (${((pending / merged.length) * 100).toFixed(1)}%). Finish classification or pass --force.`
    );
    return;
  }

  // Explain the "Can't tell" rows instead of leaving a generic reason.
  const ATTACHMENT_ONLY = /\bsee attach|attached file|attachment/i;
  for (const row of merged) {
    if (row.stance !== "Can't tell") continue;
    if (!row.commentText.trim()) {
      row.reason = 'No comment text was published, so there is nothing to classify.';
    } else if (ATTACHMENT_ONLY.test(row.commentText)) {
      row.reason = 'See attached file — the attachment could not be accessed, so no stance appears in the comment text.';
    }
  }

  const counts: Record<Stance, number> = { Support: 0, Oppose: 0, "Can't tell": 0 };
  for (const row of merged) counts[row.stance] += 1;

  const classifiedCount = merged.filter((row) => row.classifiedBy !== 'heuristic' || row.commentText.length > 0).length;

  const summary = {
    documentId: DOCUMENT_ID,
    docketId: DOCKET_ID,
    title: DOCKET.title,
    documentUrl: `https://www.regulations.gov/document/${DOCUMENT_ID}`,
    commentsPageUrl: `https://www.regulations.gov/document/${DOCUMENT_ID}/comment`,
    model: GEMINI_KEY ? GEMINI_MODEL : 'keyword heuristics',
    deadlineIso: DEADLINE_ISO,
    deadlineDisplay: DOCKET.deadlineDisplay,
    lastSyncedAt: new Date().toISOString(),
    totalPublishedOnDocket: merged.length,
    totalIndexedInTracker: merged.length,
    classifiedCount,
    counts,
    comments: merged
      .slice()
      .sort((a, b) => b.postedDate.localeCompare(a.postedDate))
      .slice(0, 1000)
  };

  fs.mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);

  const points = dailySeries(merged);

  // Per-campaign-tag series for the chart filter (only tags big enough to read).
  const MIN_TAG = 20;
  const MAX_TAGS = 12;
  const tagCounts = new Map<string, number>();
  for (const row of merged) {
    if (row.campaignId) tagCounts.set(row.campaignId, (tagCounts.get(row.campaignId) ?? 0) + 1);
  }
  const tags = [...tagCounts.entries()]
    .filter(([, count]) => count >= MIN_TAG)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAGS)
    .map(([id, count]) => ({
      id,
      count,
      points: dailySeries(merged.filter((row) => row.campaignId === id))
    }));

  const source = points.length >= 2 ? 'comments' : 'snapshots';
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify({ source, points, tags }, null, 2)}\n`);

  console.log(
    `[build] ${merged.length} comments | support ${counts.Support} / oppose ${counts.Oppose} / can't tell ${counts["Can't tell"]}`
  );
  console.log(`[build] history: ${points.length} daily points (source=${source})`);
}

function extractSubmitter(title: string): string {
  const match = title.match(/Submitted by\s+(.+)$/i);
  return match ? match[1].trim() : 'Anonymous';
}

/* -------------------------------- main -------------------------------- */

async function main(): Promise<void> {
  ensureData();

  if (BUILD_ONLY) {
    buildArtifacts();
    return;
  }

  if (REPAIR) {
    await repairHeuristic();
    buildArtifacts();
    return;
  }

  if (RECLASSIFY) {
    await reclassifyCantTell();
    buildArtifacts();
    return;
  }

  if (CLASSIFY_ONLY) {
    await classifyWorker(() => true);
    buildArtifacts();
    return;
  }

  if (!API_KEY) {
    throw new Error('REGULATIONS_API_KEY is required (see README "API keys")');
  }

  const objectId = await resolveObjectId();
  console.log(`[fetch] document objectId ${objectId}; model ${GEMINI_KEY ? GEMINI_MODEL : 'heuristics only'}`);

  let fetchDone = false;
  const fetcher = fetchWorker(objectId)
    .catch((error) => {
      console.error('[fetch] failed:', (error as Error).message);
      throw error;
    })
    .finally(() => {
      fetchDone = true;
    });

  const classify = LIST_ONLY
    ? Promise.resolve()
    : classifyWorker(() => fetchDone).catch((error) => {
        console.error('[classify] failed:', (error as Error).message);
      });

  await fetcher;
  await classify;

  if (LIST_ONLY) {
    console.log('[build] skipped (--list-only); published artifacts untouched');
    return;
  }

  buildArtifacts();
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
