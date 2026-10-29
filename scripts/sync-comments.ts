import fs from 'node:fs';
import path from 'node:path';

export type Stance = 'Support' | 'Oppose' | "Can't tell";

export interface CommentRecord {
  id: string;
  title: string;
  submitterName: string;
  postedDate: string;
  lastModifiedDate: string;
  campaignId: string | null;
  commentText: string;
  stance: Stance;
  reason: string;
  classifiedBy: 'gemini' | 'campaign-template' | 'heuristic';
  url: string;
}

export interface CampaignSummary {
  campaignId: string;
  label: string;
  count: number;
  stance: Stance;
  sampleId: string;
  sampleUrl: string;
  sampleExcerpt: string;
}

export interface TrackerSummary {
  documentId: string;
  docketId: string;
  title: string;
  documentUrl: string;
  commentsPageUrl: string;
  deadlineIso: string;
  deadlineDisplay: string;
  lastSyncedAt: string;
  lastModifiedCursor: string | null;
  totalPublishedOnDocket: number;
  totalIndexedInTracker: number;
  counts: {
    Support: number;
    Oppose: number;
    "Can't tell": number;
  };
  campaigns: CampaignSummary[];
  comments: CommentRecord[];
}

export interface HistoryPoint {
  t: string;
  support: number;
  oppose: number;
  cantTell: number;
  total: number;
}

const DOCUMENT_ID = 'USCIS-2026-0364-0001';
const DOCKET_ID = 'USCIS-2026-0364';
const SUMMARY_PATH = path.join(process.cwd(), 'docs', 'data', 'summary.json');
const HISTORY_PATH = path.join(process.cwd(), 'docs', 'data', 'history.json');
const MAX_HISTORY_POINTS = 2000;

const REGULATIONS_API_KEY = process.env.REGULATIONS_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_DETAIL_FETCHES_PER_RUN = Number(process.env.MAX_DETAIL_FETCHES || '450');

function detectCampaignId(title: string): string | null {
  const match = title.match(/\b(MM\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractSubmitter(title: string): string {
  const match = title.match(/Submitted by\s+(.+)$/i);
  return match ? match[1].trim() : 'Anonymous';
}

export function classifyHeuristic(text: string, title: string): { stance: Stance; reason: string } {
  const combined = `${title}\n${text}`.toLowerCase();

  // Known mass-mail campaigns on USCIS-2026-0364-0001 verified on Regulations.gov
  if (/\bmm78\b/i.test(combined)) {
    return {
      stance: 'Support',
      reason: 'MM78 campaign explicitly supports eliminating the discretionary 60-day grace period.'
    };
  }
  if (/\bmm83\b/i.test(combined)) {
    return {
      stance: 'Support',
      reason: 'MM83 campaign states favor for ending the 60-day grace period.'
    };
  }
  if (/\bmm73\b/i.test(combined)) {
    return {
      stance: 'Support',
      reason: 'MM73 campaign urges DHS to finalize elimination of the 60-day grace period.'
    };
  }

  const opposeRulePatterns = [
    /oppose\s+(dhs'?s?\s+)?(proposal|proposed\s+rule|eliminating|removing|removal)/i,
    /strongly\s+oppose/i,
    /respectfully\s+oppose/i,
    /retain\s+the\s+(up-to-)?60-day\s+grace\s+period/i,
    /keep\s+the\s+(60-day\s+)?grace\s+period/i,
    /do\s+not\s+(eliminate|remove|end)\s+the\s+(discretionary\s+)?(60-day\s+)?grace\s+period/i,
    /eliminating\s+the\s+grace\s+period\s+(would|will)\s+(harm|hurt|disrupt|force)/i,
    /urge\s+(dhs|uscis)\s+to\s+(withdraw|reject|keep|retain)/i,
    /against\s+(eliminating|removing)\s+the\s+(60-day\s+)?grace\s+period/i
  ];

  const supportRulePatterns = [
    /support\s+(eliminating|removing|ending)\s+the\s+(discretionary\s+)?(60-day\s+)?grace\s+period/i,
    /in\s+favor\s+of\s+(ending|eliminating|removing)\s+the\s+(60[\s-]day\s+)?grace\s+period/i,
    /finalize\s+elimination\s+of\s+the\s+60-day\s+grace\s+period/i,
    /support\s+(this|the)\s+proposed\s+rule/i,
    /end\s+the\s+(60[\s-]day\s+)?grace\s+period/i,
    /american\s+jobs\s+for\s+americans/i,
    /end\s+h-?1b/i,
    /remove\s+the\s+(up\s+to\s+)?60-day\s+(discretionary\s+)?grace\s+period/i
  ];

  for (const pat of opposeRulePatterns) {
    if (pat.test(combined)) {
      return {
        stance: 'Oppose',
        reason: 'Opposes eliminating the 60-day grace period and urges DHS to retain transition flexibility.'
      };
    }
  }

  for (const pat of supportRulePatterns) {
    if (pat.test(combined)) {
      return {
        stance: 'Support',
        reason: 'Supports the proposed rule to eliminate the 60-day discretionary grace period.'
      };
    }
  }

  if (combined.includes('oppose') && !combined.includes('support eliminating')) {
    return {
      stance: 'Oppose',
      reason: 'Expresses opposition to removing the 60-day grace period.'
    };
  }
  if (combined.includes('support') && !combined.includes('support the 60-day grace period')) {
    return {
      stance: 'Support',
      reason: 'Expresses support for the DHS proposed rulemaking.'
    };
  }

  return {
    stance: "Can't tell",
    reason: 'Comment text is brief, attachment-only, or does not state a clear stance on eliminating the grace period.'
  };
}

async function classifyBatchWithGemini(
  items: { id: string; title: string; commentText: string }[]
): Promise<Map<string, { stance: Stance; reason: string; classifiedBy: 'gemini' | 'heuristic' }>> {
  const results = new Map<string, { stance: Stance; reason: string; classifiedBy: 'gemini' | 'heuristic' }>();
  if (items.length === 0) return results;

  if (!GEMINI_API_KEY) {
    for (const item of items) {
      const h = classifyHeuristic(item.commentText, item.title);
      results.set(item.id, { ...h, classifiedBy: 'heuristic' });
    }
    return results;
  }

  const prompt = `You are classifying public comments on DHS/USCIS Proposed Rule USCIS-2026-0364-0001 ("Eliminating the Discretionary 60-Day Grace Period").
The proposed rule ELIMINATES the up-to-60-day discretionary grace period for E-1, E-2, E-3, H-1B, H-1B1, L-1, O-1, and TN nonimmigrant workers after cessation of employment.

Classify each comment's stance on the PROPOSED RULE into one of three exact labels:
- "Support": Supports the proposed rule (wants to eliminate, end, or shorten the 60-day grace period, or restrict H-1B/nonimmigrant grace periods).
- "Oppose": Opposes the proposed rule (wants to KEEP/retain the 60-day grace period, argues eliminating it harms workers/employers/families).
- "Can't tell": Use RARELY, only when the comment text is completely ambiguous, off-topic, or contains no discernible position.

Return a JSON array of objects with keys: "id", "stance" ("Support" | "Oppose" | "Can't tell"), and "reason" (concise 1-sentence explanation under 140 chars).

Comments to classify:
${JSON.stringify(items, null, 2)}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const parsed = JSON.parse(rawText) as Array<{ id: string; stance: Stance; reason: string }>;

    for (const row of parsed) {
      const normalizedStance: Stance =
        row.stance === 'Support' || row.stance === 'Oppose' || row.stance === "Can't tell"
          ? row.stance
          : "Can't tell";
      results.set(row.id, {
        stance: normalizedStance,
        reason: row.reason || 'Classified by Gemini.',
        classifiedBy: 'gemini'
      });
    }
  } catch (err) {
    console.warn('Gemini batch classification fallback triggered:', (err as Error).message);
  }

  for (const item of items) {
    if (!results.has(item.id)) {
      const h = classifyHeuristic(item.commentText, item.title);
      results.set(item.id, { ...h, classifiedBy: 'heuristic' });
    }
  }

  return results;
}

function formatRegulationsDate(isoDate: string): string {
  // Regulations.gov v4 filter[lastModifiedDate][ge] accepts 'YYYY-MM-DD HH:mm:ss' in Eastern/UTC format
  const d = new Date(isoDate);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

interface HistoryFile {
  source?: 'comments' | 'snapshots';
  points?: HistoryPoint[];
}

function readHistoryFile(): HistoryFile {
  if (!fs.existsSync(HISTORY_PATH)) return { points: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) as HistoryFile;
    return { source: parsed.source, points: Array.isArray(parsed.points) ? parsed.points : [] };
  } catch {
    return { points: [] };
  }
}

function writeHistory(source: 'comments' | 'snapshots', points: HistoryPoint[]): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify({ source, points }, null, 2)}\n`, 'utf8');
  console.log(`Saved ${points.length} history point(s) to ${HISTORY_PATH}`);
}

/**
 * Rebuild the cumulative curve from each comment's postedDate.
 *
 * Regulations.gov reports postedDate at day granularity, so this yields one
 * point per calendar day, carrying the running total of comments filed and the
 * running stance split as of that day. One full sync reconstructs the entire
 * comment period instead of waiting for 6-hourly snapshots to accumulate.
 */
export function buildHistoryFromComments(comments: CommentRecord[]): HistoryPoint[] {
  const dated = comments.filter((comment) => comment.postedDate);
  if (dated.length < 100) return [];

  const byDay = new Map<string, { support: number; oppose: number; cantTell: number; total: number; last: string }>();
  for (const comment of dated) {
    const day = comment.postedDate.slice(0, 10);
    const bucket = byDay.get(day) ?? { support: 0, oppose: 0, cantTell: 0, total: 0, last: comment.postedDate };
    if (comment.stance === 'Support') bucket.support++;
    else if (comment.stance === 'Oppose') bucket.oppose++;
    else bucket.cantTell++;
    bucket.total++;
    if (comment.postedDate > bucket.last) bucket.last = comment.postedDate;
    byDay.set(day, bucket);
  }

  let running = { support: 0, oppose: 0, cantTell: 0, total: 0 };
  return Array.from(byDay.keys())
    .sort()
    .map((day) => {
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

function updateHistory(summary: TrackerSummary, comments: CommentRecord[]): void {
  const existing = readHistoryFile();
  const existingPoints = existing.points || [];
  const reconstructed = buildHistoryFromComments(comments);

  // The daily reconstruction is the source of truth whenever the run saw the
  // whole docket. Any finer-grained snapshots recorded after the last comment
  // day are kept on top so the curve keeps extending between syncs.
  let points = existingPoints;
  let source: 'comments' | 'snapshots' = existing.source === 'comments' ? 'comments' : 'snapshots';

  if (reconstructed.length >= 2) {
    const lastDay = reconstructed[reconstructed.length - 1].t;
    const laterSnapshots = existingPoints.filter((point) => point.t > lastDay);
    points = [...reconstructed, ...laterSnapshots];
    source = 'comments';
    console.log(`Rebuilt ${reconstructed.length} daily points from comment posted dates.`);
  }

  const latest: HistoryPoint = {
    t: summary.lastSyncedAt,
    support: summary.counts.Support,
    oppose: summary.counts.Oppose,
    cantTell: summary.counts["Can't tell"],
    total: summary.totalPublishedOnDocket
  };

  const last = points[points.length - 1];
  const changed =
    !last ||
    last.total !== latest.total ||
    last.support !== latest.support ||
    last.oppose !== latest.oppose ||
    last.cantTell !== latest.cantTell;

  if (changed) points = [...points, latest];
  if (points.length > MAX_HISTORY_POINTS) points = points.slice(-MAX_HISTORY_POINTS);

  writeHistory(source, points);
}

async function main() {
  const existing: TrackerSummary = fs.existsSync(SUMMARY_PATH)
    ? (JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8')) as TrackerSummary)
    : {
        documentId: DOCUMENT_ID,
        docketId: DOCKET_ID,
        title: 'Eliminating the Discretionary 60-Day Grace Period',
        documentUrl: 'https://www.regulations.gov/document/USCIS-2026-0364-0001',
        commentsPageUrl: 'https://www.regulations.gov/document/USCIS-2026-0364-0001/comment',
        deadlineIso: '2026-11-11T04:59:59Z',
        deadlineDisplay: 'Nov 10, 2026 at 11:59 PM EST',
        lastSyncedAt: new Date().toISOString(),
        lastModifiedCursor: null,
        totalPublishedOnDocket: 26786,
        totalIndexedInTracker: 0,
        counts: { Support: 0, Oppose: 0, "Can't tell": 0 },
        campaigns: [],
        comments: []
      };

  if (!REGULATIONS_API_KEY) {
    console.log(
      'REGULATIONS_API_KEY not set in environment. Keeping existing docs/data/summary.json snapshot.'
    );
    return;
  }

  console.log('1. Fetching document objectId from Regulations.gov v4 API...');
  const docRes = await fetch(
    `https://api.regulations.gov/v4/documents/${DOCUMENT_ID}?api_key=${encodeURIComponent(REGULATIONS_API_KEY)}`
  );
  if (!docRes.ok) {
    throw new Error(`Failed to fetch document metadata: HTTP ${docRes.status}`);
  }
  const docJson = (await docRes.json()) as {
    data?: { attributes?: { objectId?: string; openForComment?: boolean } };
  };
  const objectId = docJson.data?.attributes?.objectId;
  if (!objectId) {
    throw new Error('Could not resolve document objectId from Regulations.gov API');
  }

  const commentMap = new Map<string, CommentRecord>();
  for (const c of existing.comments) {
    commentMap.set(c.id, c);
  }

  // Sliding window over lastModifiedDate to retrieve all >26,786 comments (bypassing the 20-page / 5,000-item limit per query)
  let windowGe = existing.lastModifiedCursor || '2026-09-11 00:00:00';
  let totalElementsReported = existing.totalPublishedOnDocket;
  let keepPagingWindows = true;
  let windowCount = 0;

  while (keepPagingWindows && windowCount < 12) {
    windowCount++;
    let lastDateInWindow: string | null = null;
    let itemsAddedInWindow = 0;

    for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
      const url = new URL('https://api.regulations.gov/v4/comments');
      url.searchParams.set('filter[commentOnId]', objectId);
      url.searchParams.set('filter[lastModifiedDate][ge]', windowGe);
      url.searchParams.set('page[size]', '250');
      url.searchParams.set('page[number]', String(pageNumber));
      url.searchParams.set('sort', 'lastModifiedDate,documentId');
      url.searchParams.set('api_key', REGULATIONS_API_KEY);

      const listRes = await fetch(url.toString());
      if (listRes.status === 429) {
        console.warn('Reached Regulations.gov API rate limit during list pagination; saving checkpoint.');
        keepPagingWindows = false;
        break;
      }
      if (!listRes.ok) {
        throw new Error(`Comments list HTTP ${listRes.status}`);
      }

      const listJson = (await listRes.json()) as {
        data?: Array<{
          id: string;
          attributes?: {
            title?: string;
            postedDate?: string;
            lastModifiedDate?: string;
            withdrawn?: boolean;
          };
        }>;
        meta?: { totalElements?: number; hasNextPage?: boolean };
      };

      if (windowCount === 1 && pageNumber === 1 && listJson.meta?.totalElements) {
        totalElementsReported = listJson.meta.totalElements;
      }

      const rows = listJson.data || [];
      if (rows.length === 0) {
        keepPagingWindows = false;
        break;
      }

      for (const row of rows) {
        if (row.attributes?.withdrawn) continue;
        const title = row.attributes?.title || `Comment ${row.id}`;
        const campaignId = detectCampaignId(title);
        if (!commentMap.has(row.id)) {
          const initial = classifyHeuristic('', title);
          commentMap.set(row.id, {
            id: row.id,
            title,
            submitterName: extractSubmitter(title),
            postedDate: row.attributes?.postedDate || '',
            lastModifiedDate: row.attributes?.lastModifiedDate || '',
            campaignId,
            commentText: '',
            stance: initial.stance,
            reason: initial.reason,
            classifiedBy: campaignId ? 'campaign-template' : 'heuristic',
            url: `https://www.regulations.gov/comment/${row.id}`
          });
          itemsAddedInWindow++;
        }
        if (row.attributes?.lastModifiedDate) {
          lastDateInWindow = row.attributes.lastModifiedDate;
        }
      }

      if (!listJson.meta?.hasNextPage || rows.length < 250) {
        keepPagingWindows = false;
        break;
      }
    }

    if (keepPagingWindows && lastDateInWindow && itemsAddedInWindow > 0) {
      windowGe = formatRegulationsDate(lastDateInWindow);
    } else {
      break;
    }
  }

  // Fetch comment details for 1 representative per mass campaign + unclassified individual comments
  const seenCampaignTemplates = new Set<string>();
  const toFetchDetails: CommentRecord[] = [];

  for (const record of commentMap.values()) {
    if (record.campaignId) {
      if (!seenCampaignTemplates.has(record.campaignId) && !record.commentText) {
        seenCampaignTemplates.add(record.campaignId);
        toFetchDetails.push(record);
      }
    } else if (!record.commentText) {
      toFetchDetails.push(record);
    }
    if (toFetchDetails.length >= MAX_DETAIL_FETCHES_PER_RUN) break;
  }

  console.log(`Fetching detailed comment text for ${toFetchDetails.length} representative/individual comments...`);
  const newlyDetailed: CommentRecord[] = [];

  for (const item of toFetchDetails) {
    const detailRes = await fetch(
      `https://api.regulations.gov/v4/comments/${item.id}?api_key=${encodeURIComponent(REGULATIONS_API_KEY)}`
    );
    if (detailRes.status === 429) {
      console.warn('Reached Regulations.gov rate limit on detail fetch; stopping detail pass.');
      break;
    }
    if (!detailRes.ok) continue;

    const detailJson = (await detailRes.json()) as {
      data?: {
        attributes?: {
          comment?: string;
          firstName?: string;
          lastName?: string;
          organization?: string;
        };
      };
    };
    const attr = detailJson.data?.attributes;
    item.commentText = (attr?.comment || '').trim();
    const fullName = [attr?.firstName, attr?.lastName].filter(Boolean).join(' ').trim();
    if (attr?.organization) {
      item.submitterName = attr.organization;
    } else if (fullName) {
      item.submitterName = fullName;
    }
    newlyDetailed.push(item);
  }

  // Classify in batches of 20 with Gemini
  for (let i = 0; i < newlyDetailed.length; i += 20) {
    const batch = newlyDetailed.slice(i, i + 20).map((c) => ({
      id: c.id,
      title: c.title,
      commentText: c.commentText
    }));
    const classified = await classifyBatchWithGemini(batch);
    for (const c of newlyDetailed.slice(i, i + 20)) {
      const res = classified.get(c.id);
      if (res) {
        c.stance = res.stance;
        c.reason = res.reason;
        c.classifiedBy = res.classifiedBy;
      }
    }
  }

  // Propagate campaign template classifications across all members of each mass campaign
  const campaignTemplateMap = new Map<string, CommentRecord>();
  for (const c of commentMap.values()) {
    if (c.campaignId && c.commentText && !campaignTemplateMap.has(c.campaignId)) {
      campaignTemplateMap.set(c.campaignId, c);
    }
  }
  for (const c of commentMap.values()) {
    if (c.campaignId && campaignTemplateMap.has(c.campaignId)) {
      const tpl = campaignTemplateMap.get(c.campaignId)!;
      c.stance = tpl.stance;
      c.reason = tpl.reason;
      if (!c.commentText) c.commentText = tpl.commentText;
      c.classifiedBy = 'campaign-template';
    }
  }

  const allComments = Array.from(commentMap.values()).sort((a, b) =>
    b.postedDate.localeCompare(a.postedDate)
  );

  const counts: Record<Stance, number> = { Support: 0, Oppose: 0, "Can't tell": 0 };
  for (const c of allComments) {
    counts[c.stance] = (counts[c.stance] || 0) + 1;
  }

  const updatedSummary: TrackerSummary = {
    ...existing,
    lastSyncedAt: new Date().toISOString(),
    lastModifiedCursor: windowGe,
    totalPublishedOnDocket: Math.max(totalElementsReported, allComments.length),
    totalIndexedInTracker: allComments.length,
    counts,
    comments: allComments.slice(0, 1000)
  };

  fs.mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(updatedSummary, null, 2), 'utf8');
  console.log(`Saved updated tracker data to ${SUMMARY_PATH}`);

  updateHistory(updatedSummary, allComments);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
