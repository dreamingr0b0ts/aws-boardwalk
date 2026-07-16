// Deterministic fictional City of Alpenglow catalog for the three service
// tables. Seeded PRNG → identical ids and records every run, so re-seeding is
// idempotent (PutItem overwrites in place) and never strands stale items.
// Run via `make seed` (env: PERMITS_TABLE, LICENSES_TABLE, FACILITIES_TABLE).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`missing env ${name}`); process.exit(1); }
  return v;
};
const PERMITS_TABLE = need('PERMITS_TABLE');
const LICENSES_TABLE = need('LICENSES_TABLE');
const FACILITIES_TABLE = need('FACILITIES_TABLE');

// mulberry32 — tiny deterministic PRNG
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260716);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const STREETS = ['Larkspur Ave', 'Alder Ct', 'Ridgeline Trail', 'Summit Way', 'Juniper Ln', 'Gold Creek Rd', 'Aspen Loop', 'Cirque St', 'Moraine Dr', 'Timberline Blvd', 'Kestrel Way', 'Tarn Pl'];
const addr = () => `${between(100, 4999)} ${pick(STREETS)}`;
const isoDate = () => {
  const start = Date.UTC(2024, 0, 2);
  const end = Date.UTC(2026, 5, 30);
  return new Date(start + Math.floor(rand() * (end - start))).toISOString().slice(0, 10);
};

// ---- permits (240) ----
const PERMIT_TYPES = ['building', 'electrical', 'plumbing', 'mechanical', 'sign', 'fence', 'solar', 'event'];
const PERMIT_STATUSES = ['submitted', 'under-review', 'approved', 'issued', 'denied', 'closed'];
const APPLICANTS = ['Alpenglow Builders LLC', 'Peak & Pine Electric', 'Bluebird Plumbing Co', 'Kestrel Mechanical', 'Cornice Signworks', 'High Line Fence Co', 'Tarn Solar', 'Snowmelt Landscaping', 'Gold Creek Construction', 'Cirque Renovations'];
const WORK = {
  building: ['single-family addition', 'detached garage', 'deck replacement', 'basement finish', 'accessory dwelling unit'],
  electrical: ['200A service upgrade', 'EV charger circuit', 'hot tub wiring', 'panel replacement'],
  plumbing: ['water heater replacement', 'sewer line repair', 'bathroom rough-in'],
  mechanical: ['furnace replacement', 'mini-split installation', 'radon mitigation system'],
  sign: ['storefront blade sign', 'monument sign', 'illuminated channel letters'],
  fence: ['6ft cedar privacy fence', 'wildlife-friendly split rail'],
  solar: ['8.2kW rooftop array', 'ground-mount array with battery'],
  event: ['street festival', 'farmers market season', 'trail race staging'],
};

const permits = [];
for (let i = 1; i <= 240; i++) {
  const id = `PRM-${2024 + Math.floor((i - 1) / 96)}-${String(i).padStart(4, '0')}`;
  const type = pick(PERMIT_TYPES);
  permits.push({
    PK: id, SK: 'META',
    id, type,
    status: pick(PERMIT_STATUSES),
    description: pick(WORK[type]),
    address: addr(),
    applicant: pick(APPLICANTS),
    valuation: between(8, 4200) * 100,
    submittedAt: isoDate(),
  });
}

// ---- licenses (160) ----
const CATEGORIES = ['food-service', 'retail', 'contractor', 'childcare', 'liquor', 'lodging', 'mobile-vendor'];
const NAMES = {
  'food-service': ['The Chairlift Café', 'Powderhound Coffee', 'Bluebird Bakery', 'Moraine Noodle House', 'First Light Diner', 'Switchback Pizza'],
  retail: ['Moraine Books', 'Gold Creek Outfitters', 'Alpenglow Toy Works', 'Cache Gear Rentals', 'Larkspur Market', 'Timberline Threads'],
  contractor: ['Alpenglow Builders LLC', 'Peak & Pine Electric', 'Bluebird Plumbing Co', 'Kestrel Mechanical', 'Gold Creek Construction'],
  childcare: ['Summit Sitters', 'Little Larks Early Learning', 'Trailhead Tots'],
  liquor: ['Tarn & Timber Brewing', 'Cirque Cellars', 'The Ptarmigan Taproom'],
  lodging: ['The Alpenglow Lodge', 'Moraine Motor Inn', 'Ridgeline Chalets'],
  'mobile-vendor': ['Yeti Yardsale Cart', 'Alpine Arepas Truck', 'Snowmelt Shave Ice'],
};

const licenses = [];
for (let i = 1; i <= 160; i++) {
  const category = pick(CATEGORIES);
  const issuedAt = isoDate();
  const years = between(1, 3);
  const expiresAt = `${Number(issuedAt.slice(0, 4)) + years}${issuedAt.slice(4)}`;
  const expired = expiresAt < '2026-07-16';
  licenses.push({
    id: `LIC-${String(i).padStart(4, '0')}`,
    businessName: pick(NAMES[category]),
    category,
    status: expired ? 'expired' : rand() < 0.04 ? 'suspended' : 'active',
    address: addr(),
    issuedAt, expiresAt,
  });
}

// ---- facilities (24) ----
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hours = (open, close, weekendClose) =>
  Object.fromEntries(DAYS.map((d) => [d, ['sat', 'sun'].includes(d) && weekendClose ? weekendClose : `${open}–${close}`]));
const dawnDusk = Object.fromEntries(DAYS.map((d) => [d, 'dawn–dusk']));

const facilities = [
  { id: 'FAC-001', name: 'Larkspur Park', kind: 'park', hours: dawnDusk },
  { id: 'FAC-002', name: 'Moraine Dog Park', kind: 'park', hours: dawnDusk },
  { id: 'FAC-003', name: 'Tarn Overlook', kind: 'park', hours: dawnDusk, seasonalNote: 'Access road closed after first snowfall.' },
  { id: 'FAC-004', name: 'Confluence Picnic Grounds', kind: 'park', hours: dawnDusk },
  { id: 'FAC-005', name: 'Ridgeline Trail', kind: 'trail', hours: dawnDusk },
  { id: 'FAC-006', name: 'Gold Creek Trailhead', kind: 'trail', hours: dawnDusk, seasonalNote: 'Upper loop closed May–June for elk calving.' },
  { id: 'FAC-007', name: 'Cirque Traverse', kind: 'trail', hours: dawnDusk },
  { id: 'FAC-008', name: 'Kestrel Ridge Trail', kind: 'trail', hours: dawnDusk },
  { id: 'FAC-009', name: 'Cirque Recreation Center', kind: 'rec-center', hours: hours('06:00', '21:00', '08:00–18:00') },
  { id: 'FAC-010', name: 'Alpenglow Community Hall', kind: 'rec-center', hours: hours('08:00', '22:00') },
  { id: 'FAC-011', name: 'Kestrel Skate Park', kind: 'rec-center', hours: dawnDusk },
  { id: 'FAC-012', name: 'Alpenglow Public Library', kind: 'library', hours: hours('09:00', '20:00', '10:00–17:00') },
  { id: 'FAC-013', name: 'Gold Creek Branch Library', kind: 'library', hours: hours('10:00', '18:00', 'closed') },
  { id: 'FAC-014', name: 'Snowmelt Aquatic Center', kind: 'pool', hours: hours('05:30', '21:00', '08:00–19:00') },
  { id: 'FAC-015', name: 'Larkspur Outdoor Pool', kind: 'pool', hours: hours('10:00', '19:00'), seasonalNote: 'Open Memorial Day through Labor Day.' },
  { id: 'FAC-016', name: 'Summit Way Ballfields', kind: 'sports-field', hours: dawnDusk },
  { id: 'FAC-017', name: 'Juniper Soccer Complex', kind: 'sports-field', hours: dawnDusk },
  { id: 'FAC-018', name: 'Moraine Softball Diamond', kind: 'sports-field', hours: dawnDusk },
  { id: 'FAC-019', name: 'Timberline Tennis Courts', kind: 'sports-field', hours: hours('07:00', '22:00') },
  { id: 'FAC-020', name: 'Aspen Loop Pump Track', kind: 'park', hours: dawnDusk },
  { id: 'FAC-021', name: 'Bluebird Meadow', kind: 'park', hours: dawnDusk },
  { id: 'FAC-022', name: 'Cache Climbing Boulders', kind: 'park', hours: dawnDusk },
  { id: 'FAC-023', name: 'First Light Amphitheater', kind: 'rec-center', hours: hours('08:00', '23:00') },
  { id: 'FAC-024', name: 'Ptarmigan Nordic Trails', kind: 'trail', hours: dawnDusk, seasonalNote: 'Groomed December–March; hiking rest of year.' },
].map((f) => ({ address: addr(), status: 'open', ...f }));

async function batchWrite(table, items) {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let req = { [table]: chunk.map((Item) => ({ PutRequest: { Item } })) };
    while (req[table]?.length) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: req }));
      req = res.UnprocessedItems ?? {};
      if (req[table]?.length) await new Promise((r) => setTimeout(r, 400));
    }
  }
  console.log(`${table}: ${items.length} items`);
}

await batchWrite(PERMITS_TABLE, permits);
await batchWrite(LICENSES_TABLE, licenses);
await batchWrite(FACILITIES_TABLE, facilities);
console.log('seed complete');
