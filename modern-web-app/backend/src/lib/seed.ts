import type { AppStatus, PermitType } from './db.js';

// ---------------------------------------------------------------------------
// Deterministic demo data. Same seed → same records every reset, so
// screenshots stay stable and the nightly reset is invisible to visitors.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PERMIT_TYPES: PermitType[] = [
  { slug: 'solar-residential', name: 'Residential Solar Installation', category: 'Building', fee: 185, processingDays: 14, active: true, description: 'Rooftop or ground-mount photovoltaic systems on residential property, up to 25kW.' },
  { slug: 'deck-addition', name: 'Deck & Patio Construction', category: 'Building', fee: 210, processingDays: 14, active: true, description: 'New decks, patios, and porch additions over 30 inches above grade or 200 sq ft.' },
  { slug: 'food-truck', name: 'Mobile Food Vendor License', category: 'Business', fee: 250, processingDays: 10, active: true, description: 'Annual license to operate a mobile food unit within city limits, including health inspection.' },
  { slug: 'sign-permit', name: 'Commercial Sign Permit', category: 'Business', fee: 120, processingDays: 7, active: true, description: 'Wall, monument, and projecting signs for commercial storefronts.' },
  { slug: 'home-business', name: 'Home Occupation Permit', category: 'Business', fee: 65, processingDays: 5, active: true, description: 'Operate a low-impact business from a residential address.' },
  { slug: 'special-event', name: 'Special Event Permit', category: 'Events', fee: 95, processingDays: 21, active: true, description: 'Festivals, races, markets, and gatherings of 75+ people on public property.' },
  { slug: 'film-permit', name: 'Film & Photography Permit', category: 'Events', fee: 150, processingDays: 10, active: true, description: 'Commercial filming or photography on city property or requiring street closures.' },
  { slug: 'short-term-rental', name: 'Short-Term Rental License', category: 'Housing', fee: 340, processingDays: 30, active: true, description: 'Annual license to rent a dwelling for stays under 30 days.' },
];

const FIRST = ['Jordan', 'Riley', 'Casey', 'Avery', 'Quinn', 'Morgan', 'Rowan', 'Sage', 'Elena', 'Marcus', 'Priya', 'Dana', 'Felix', 'Iris', 'Hugo', 'Naomi', 'Leo', 'Wren', 'Omar', 'Tessa', 'Silas', 'June', 'Cole', 'Vera'];
const LAST = ['Rivera', 'Chen', 'Okafor', 'Larsen', 'Vasquez', 'Kim', 'Bennett', 'Iwu', 'Novak', 'Marsh', 'Delgado', 'Frost', 'Abara', 'Holt', 'Reyes', 'Lindqvist', 'Park', 'Calloway', 'Singh', 'Moreau'];
const STREETS = ['Alpenglow Way', 'Larkspur Lane', 'Timberline Court', 'Cache Creek Road', 'Bristlecone Drive', 'Silverthorn Avenue', 'Marmot Ridge', 'Aspen Hollow', 'Granite Falls Street', 'Kestrel Loop'];

const NOTES_APPROVE = [
  'Plans meet code. Approved as submitted.',
  'Approved with standard conditions; see attached inspection schedule.',
  'Site review complete — approved.',
  'Approved. Display permit visibly on premises.',
];
const NOTES_DENY = [
  'Setback requirements not met; resubmit with revised site plan.',
  'Incomplete structural drawings. Denied without prejudice — please reapply.',
  'Zoning conflict with district overlay; variance required first.',
  'Insurance documentation expired. Reapply with current certificate.',
];
const APP_DESCRIPTIONS: Record<string, string[]> = {
  'solar-residential': ['6.4kW rooftop array, 16 panels, south-facing', '8.2kW system with battery backup on detached garage'],
  'deck-addition': ['320 sq ft cedar deck off rear kitchen entrance', 'Composite deck with pergola, 280 sq ft'],
  'food-truck': ['Wood-fired pizza trailer, propane + generator', 'Coffee and pastry van, weekday mornings downtown'],
  'sign-permit': ['Backlit channel letters, 18 sq ft storefront sign', 'Monument sign at parking entrance, 6 ft'],
  'home-business': ['Freelance graphic design studio, no client visits', 'Small-batch candle making, online sales only'],
  'special-event': ['Saturday farmers market, June–September, ~400 attendees', '5k charity trail run with two street crossings'],
  'film-permit': ['Documentary b-roll at Riverside Park, 3-person crew', 'Commercial shoot on Main St, half-day lane closure'],
  'short-term-rental': ['2BR basement apartment, owner-occupied home', 'Detached carriage house, max 4 guests'],
};

export interface SeedRecords {
  items: Record<string, unknown>[];
  summary: { types: number; applications: number; events: number; months: number };
}

interface DemoCitizen {
  sub: string;
  email: string;
  name: string;
}

export function buildSeed(now: Date, demoCitizen: DemoCitizen): SeedRecords {
  const rand = mulberry32(20260713);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

  const items: Record<string, unknown>[] = [];

  for (const t of PERMIT_TYPES) {
    items.push({ PK: 'CATALOG', SK: `TYPE#${t.slug}`, entity: 'PermitType', ...t });
  }

  // --- live applications -------------------------------------------------
  const statusPlan: AppStatus[] = [
    ...Array<AppStatus>(9).fill('submitted'),
    ...Array<AppStatus>(7).fill('under_review'),
    ...Array<AppStatus>(17).fill('approved'),
    ...Array<AppStatus>(7).fill('denied'),
  ];

  // A few of the citizen demo account's "own" applications, one per bucket,
  // so its dashboard is never empty.
  const citizenOwned = new Set([0, 9, 16, 33]);

  let eventCount = 0;
  const counts: Record<AppStatus, number> = { submitted: 0, under_review: 0, approved: 0, denied: 0 };
  let processingSum = 0;
  let processingN = 0;

  statusPlan.forEach((status, i) => {
    const type = PERMIT_TYPES[i % PERMIT_TYPES.length]!;
    const daysAgo = between(2, 88);
    const submitted = new Date(now.getTime() - daysAgo * 86400_000 - between(0, 86_399_000));
    const submittedAt = submitted.toISOString();
    const id = `APP-${submitted.getTime().toString(36).toUpperCase()}${i.toString(36).toUpperCase()}`;

    const own = citizenOwned.has(i);
    const name = own ? demoCitizen.name : `${pick(FIRST)} ${pick(LAST)}`;
    const email = own ? demoCitizen.email : `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
    const sub = own ? demoCitizen.sub : `seed-${i.toString(36)}`;

    const app: Record<string, unknown> = {
      PK: `APP#${id}`,
      SK: 'META',
      entity: 'Application',
      id,
      typeSlug: type.slug,
      typeName: type.name,
      category: type.category,
      applicantSub: sub,
      applicantName: name,
      applicantEmail: email,
      address: `${between(11, 4999)} ${pick(STREETS)}, Alpenglow, CO`,
      description: pick(APP_DESCRIPTIONS[type.slug] ?? ['—']),
      status,
      submittedAt,
      GSI1PK: `USER#${sub}`,
      GSI1SK: submittedAt,
      GSI2PK: `STATUS#${status}`,
      GSI2SK: submittedAt,
    };

    const events: Record<string, unknown>[] = [
      { PK: `APP#${id}`, SK: `EVENT#${submittedAt}#0`, entity: 'Event', status: 'submitted', at: submittedAt, actor: 'system', note: 'Application received' },
    ];

    if (status !== 'submitted') {
      const reviewAt = new Date(submitted.getTime() + between(1, 3) * 86400_000).toISOString();
      events.push({ PK: `APP#${id}`, SK: `EVENT#${reviewAt}#1`, entity: 'Event', status: 'under_review', at: reviewAt, actor: 'staff@alpenglow.gov', note: 'Assigned for review' });
    }
    if (status === 'approved' || status === 'denied') {
      const procDays = Math.min(between(3, type.processingDays + 6), daysAgo);
      const decidedAt = new Date(submitted.getTime() + procDays * 86400_000).toISOString();
      const note = status === 'approved' ? pick(NOTES_APPROVE) : pick(NOTES_DENY);
      app.decidedAt = decidedAt;
      app.decisionNote = note;
      events.push({ PK: `APP#${id}`, SK: `EVENT#${decidedAt}#2`, entity: 'Event', status, at: decidedAt, actor: 'staff@alpenglow.gov', note });
      processingSum += procDays;
      processingN += 1;
    }

    counts[status] += 1;
    eventCount += events.length;
    items.push(app, ...events);
  });

  // --- monthly aggregates (12 months ending now) --------------------------
  const months: string[] = [];
  for (let m = 11; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  months.forEach((ym, idx) => {
    const growth = 1 + idx * 0.055; // steady adoption story
    const received = Math.round(between(16, 22) * growth);
    const approved = Math.round(received * (0.58 + rand() * 0.14));
    const denied = Math.round(received * (0.08 + rand() * 0.07));
    const byType: Record<string, number> = {};
    let remaining = received;
    PERMIT_TYPES.forEach((t, ti) => {
      const share = ti === PERMIT_TYPES.length - 1 ? remaining : Math.min(remaining, Math.round(received * (0.06 + rand() * 0.16)));
      byType[t.slug] = share;
      remaining -= share;
    });
    items.push({
      PK: 'STATS',
      SK: `MONTH#${ym}`,
      entity: 'MonthStats',
      month: ym,
      received,
      approved,
      denied,
      avgProcessingDays: Math.round((15.5 - idx * 0.6 + rand() * 2) * 10) / 10, // improving over time
      byType,
    });
  });

  items.push({
    PK: 'STATS',
    SK: 'CURRENT',
    entity: 'CurrentStats',
    counts,
    total: statusPlan.length,
    avgProcessingDays: processingN ? Math.round((processingSum / processingN) * 10) / 10 : 0,
    updatedAt: now.toISOString(),
  });

  return {
    items,
    summary: {
      types: PERMIT_TYPES.length,
      applications: statusPlan.length,
      events: eventCount,
      months: months.length,
    },
  };
}
