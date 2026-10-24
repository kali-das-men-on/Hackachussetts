// Government dashboard: how reports are ranked, what "valid" and "serious" mean, and rough budgets.
// Pure functions, no I/O. Used by gov.js; the same text is shown in the dashboard's "Criteria" panel.
//
// Sources (checked 2026-10-24):
//   M.G.L. c.84 §15   town liable for injury/damage from a defect in a public way it had reasonable
//                     notice of and could have fixed; damages capped at $5,000.
//                     https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXIV/Chapter84/Section15
//   521 CMR 22        MA Architectural Access Board, walkways: no level change > 1/4 in (22.4),
//                     36 in clear path (22.2). https://www.mass.gov/doc/521-cmr-2200-walkways-2006-pdf/download
//   M.G.L. c.270 §16  dumping on a public way or public land: fine up to $5,500 (first offense).
//                     https://malegislature.gov/Laws/GeneralLaws/PartIV/TitleI/Chapter270/Section16
//   Boston CityScore  311 on-time targets (80% of cases): pothole 1 business day, streetlight
//                     10 business days, graffiti 45 business days, dumped trash 24 h, parks 5 business
//                     days, signals 24 h. https://www.boston.gov/departments/analytics-team/cityscore
//   State highways are MassDOT's (857-368-4636), not the town's (boston.gov, "How we protect and fix
//   Boston's streets"). DCR parkways go to DCR.
//
// Budgets are rough planning ranges for one job, not quotes. Replace them with your DPW's unit prices.
// The sidewalk range uses the 2026 Boston average for sidewalk repair ($606-$2,451, Angi).

const DONE = ['resolved', 'rejected'];

// Severity tiers follow the anchors in backend/prompts.py.
const TIERS = [
  { id: 'P1', min: 80, label: 'Urgent', respond: 'within 24 hours', hours: 24 },
  { id: 'P2', min: 60, label: 'High', respond: 'within 2 business days', hours: 48 },
  { id: 'P3', min: 40, label: 'Medium', respond: 'within 10 business days', hours: 240 },
  { id: 'P4', min: 0, label: 'Low', respond: 'with routine scheduled work', hours: null },
];

const VALID_RULES = [
  { check: 'photo_shows_issue', label: 'Photo shows the problem', rule: 'A clear photo of a real defect matching the text. Blurry, unrelated or contradicting photos fail.' },
  { check: 'in_service_area', label: 'Inside town limits', rule: 'The location is in the town. State highways go to MassDOT (857-368-4636); DCR parkways go to DCR.' },
  { check: 'in_scope', label: 'Town responsibility', rule: 'Public way, sidewalk, streetlight, park or public property. Private property goes to the owner or code enforcement.' },
];

// Per category: what makes it serious (MA rule + target), and budget ranges by severity band:
// [severity < 40, 40-79, 80+].
const CATEGORY = {
  pothole: {
    serious: 'Defect in a public way: the town is liable for damage once it has notice (M.G.L. c.84 §15, up to $5,000 per claim). Worse in a travel or bike lane, deep, or near a crossing.',
    target: 'Boston target: fixed within 1 business day',
    targetHours: 24,
    budget: [[100, 300, 'cold patch, one crew visit'], [300, 1500, 'hot-mix patch with saw-cut edges'], [5000, 25000, 'section mill and overlay']],
  },
  sidewalk: {
    serious: 'Walkways may not have level changes over 1/4 in and need a 36 in clear path (521 CMR 22). Trip edges are also road defects under M.G.L. c.84 §15.',
    target: 'Make safe (cone, grind or patch) quickly; panel replacement goes on the sidewalk program',
    targetHours: 48,
    budget: [[100, 500, 'grind or patch a trip edge'], [600, 2500, 'replace concrete panels'], [3000, 10000, 'rebuild curb ramp or long stretch']],
  },
  streetlight: {
    serious: 'Dark crossings, bus stops and school routes first. A broken pedestrian signal is a signal outage.',
    target: 'Boston target: outage fixed within 10 business days (signals: 24 h)',
    targetHours: 240,
    budget: [[150, 400, 'lamp or photocell'], [500, 1500, 'LED fixture'], [3000, 10000, 'pole or underground wiring']],
  },
  trash: {
    serious: 'Dumping on a public way or public land is an offense (M.G.L. c.270 §16, fine up to $5,500). Health risk if food waste or sharps.',
    target: 'Boston target: dumped trash collected within 24 hours',
    targetHours: 24,
    budget: [[50, 150, 'empty bin, pick up bags'], [200, 800, 'bulky-item removal'], [1000, 5000, 'large dump or hazardous waste disposal']],
  },
  graffiti: {
    serious: 'Usually cosmetic. Higher if offensive or hate speech, or if it covers signs or signals.',
    target: 'Boston target: removed within 45 business days (offensive content: right away)',
    targetHours: 45 * 24,
    budget: [[100, 400, 'small tag, wash or paint'], [400, 1500, 'pressure wash or repaint a wall'], [1500, 5000, 'large area or glass replacement']],
  },
  other: {
    serious: 'Judge by risk of injury and who is affected. A blocked sidewalk breaks the 36 in clear path (521 CMR 22); public trees are the tree warden\'s (M.G.L. c.87).',
    target: 'Parks requests: Boston target 5 business days',
    targetHours: 120,
    budget: [[200, 800, 'small crew job'], [800, 3000, 'tree crew or equipment'], [3000, 10000, 'contractor work']],
  },
};

// The agent's taxonomy can change (e.g. amherst-2026-10.2 says "damaged_road_surface", "roads_traffic").
// Map names this file doesn't know to the nearest rule set by keyword; unknown stays "other".
const CATEGORY_WORDS = [
  ['sidewalk', /sidewalk|curb|ramp|walkway|crosswalk/],
  ['pothole', /pothole|road|pavement|asphalt|street_surface/],
  ['streetlight', /light|lamp|signal/],
  ['trash', /trash|litter|dump|garbage|bin|waste|recycl/],
  ['graffiti', /graffiti|vandal|tag/],
];
function ruleCategory(cat) {
  if (!cat) return 'other';
  if (CATEGORY[cat]) return cat;
  const hit = CATEGORY_WORDS.find(([, re]) => re.test(cat));
  return hit ? hit[0] : 'other';
}

function tierFor(score) {
  return TIERS.find((t) => score >= t.min);
}

function money(n) {
  return '$' + n.toLocaleString('en-US');
}

// The score staff see: their own override, else the merged problem's (highest AI score plus a
// bonus for separate reporters), else the AI's. null if none exists.
function severityOf(r) {
  const s = r.gov.severity_score ?? r.problem?.severity_score ?? r.ai?.severity_score;
  return s == null || s === '' ? null : Number(s);
}

function budgetFor(category, score) {
  const c = CATEGORY[category] || CATEGORY.other;
  const band = score >= 80 ? 2 : score >= 40 ? 1 : 0; // P1 / P2-P3 / P4
  const [lo, hi, what] = c.budget[band];
  return { low: lo, high: hi, text: `${money(lo)}-${money(hi)}`, basis: what };
}

// Rank = severity, plus up to 15 points for days open, plus 10 if past the category target.
// Reports the AI marked invalid sink (x0.4); reports the AI has not seen yet count as 30.
function assess(r, now = Date.now()) {
  const ai = r.ai;
  const category = ai?.category || r.user.category || 'other'; // shown to staff as the AI wrote it
  const rules = ruleCategory(category);
  const c = CATEGORY[rules];
  const severity = severityOf(r);
  const base = severity ?? 30;
  const open = !DONE.includes(r.gov.status);
  const ageH = Math.max(0, (now - Date.parse(r.created_at)) / 3600e3);
  const dueAt = new Date(Date.parse(r.created_at) + c.targetHours * 3600e3).toISOString();
  const overdue = open && ageH > c.targetHours;
  const ageBonus = open ? Math.min(15, (ageH / 24) * 1.5) : 0;
  const invalid = ai && ai.valid === false;
  let rank = (base + ageBonus + (overdue ? 10 : 0)) * (invalid ? 0.4 : 1);
  rank = Math.round(rank * 10) / 10;

  const why = [severity == null ? 'not analyzed yet (counted as 30)' : `severity ${severity}`];
  if (r.problem?.report_count > 1 && r.gov.severity_score == null) why[0] += ` (${r.problem.severity_note})`;
  const days = Math.floor(ageH / 24);
  if (ageBonus >= 1) why.push(`+${Math.round(ageBonus)} for ${days} day${days === 1 ? '' : 's'} open`);
  if (overdue) why.push('+10 past target');
  if (invalid) why.push('x0.4 AI says not valid');

  const tier = tierFor(base);
  return {
    rank,
    rank_reason: why.join(', '),
    category,
    priority: { ...tier },
    suggested_department: ai?.department || null,
    budget: budgetFor(rules, base),
    criteria: {
      serious: c.serious,
      target: c.target,
      valid: VALID_RULES.map((v) => ({ ...v, result: ai?.valid_checks ? ai.valid_checks[v.check] ?? null : null })),
    },
    due_at: open ? dueAt : null,
    overdue,
  };
}

module.exports = { DONE, TIERS, VALID_RULES, CATEGORY, ruleCategory, assess, severityOf, budgetFor, tierFor };
