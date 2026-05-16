import { BoundQuery } from 'surrealdb';

// Carrier signatures matched against the From header. Order matters when a
// sender domain mentions multiple carriers (e.g., a tracking aggregator).
const CARRIERS = [
  { name: 'UPS', re: /\bups\b|@ups\.com/i },
  { name: 'FedEx', re: /\bfedex\b|@fedex\.com/i },
  { name: 'USPS', re: /\busps\b|@usps\.com|@email\.usps\.com|@informeddelivery/i },
  { name: 'DHL', re: /\bdhl\b|@dhl\.com/i },
  {
    name: 'Amazon',
    re: /amazon\.com|order-update@amazon|auto-confirm@amazon|shipment-tracking@amazon/i,
  },
  { name: 'B&H', re: /bhphotovideo|@bhphoto/i },
  { name: 'Apple', re: /apple\.com.*order/i },
  { name: 'Etsy', re: /etsy\.com/i },
  { name: 'Shopify', re: /shopify\.com|@shop\.app/i },
  { name: 'Generic tracking', re: /tracking@|noreply.*ship|shipment|delivery/i },
];

// Status keywords scanned in the Subject (then snippet as fallback).
const STATUS_PATTERNS = [
  { status: 'delivered', re: /\bdelivered\b|has been delivered|was delivered/i },
  { status: 'out_for_delivery', re: /out for delivery/i },
  { status: 'arriving_today', re: /arriving today|will arrive today|delivery today/i },
  { status: 'arriving_tomorrow', re: /arriving tomorrow|will arrive tomorrow|delivery tomorrow/i },
  {
    status: 'arriving_soon',
    re: /arriving (mon|tue|wed|thu|fri|sat|sun)|will arrive (mon|tue|wed|thu|fri|sat|sun)|arriving on|expected delivery/i,
  },
  { status: 'shipped', re: /\bshipped\b|on its way|on the way|has shipped|in transit/i },
  { status: 'ordered', re: /order confirm|thanks for your order|order received|order placed/i },
];

function extractCarrier(from) {
  for (const c of CARRIERS) {
    if (c.re.test(from)) return c.name;
  }
  return 'Unknown';
}

function extractStatus(subject, snippet) {
  const haystack = `${subject} ${snippet}`;
  for (const s of STATUS_PATTERNS) {
    if (s.re.test(haystack)) return s.status;
  }
  return null;
}

function isShipmentLike(subject, from) {
  const subjLower = subject.toLowerCase();
  // Strong signal: a carrier-recognized sender.
  for (const c of CARRIERS) {
    if (c.re.test(from)) return true;
  }
  // Fallback: subject keywords.
  return (
    /tracking|ship|deliver|arriv|order|package/i.test(subjLower) &&
    !/promo|sale|discount|coupon|% off/i.test(subjLower)
  );
}

// Extract a short "item proxy" from the subject — usually the order number
// or product name. We don't try to parse free-form item names; we just shorten
// the subject for display.
function itemProxy(subject) {
  const stripped = subject
    .replace(/^(re:|fwd:)\s*/i, '')
    .replace(/\s+\(?#?\d{6,}\)?/g, ' #order') // collapse long order #s
    .trim();
  return stripped.length > 60 ? `${stripped.slice(0, 57)}…` : stripped;
}

export function parseGmailContent(content) {
  // content format: `Subject: <s> | From: <f>\n<snippet>`
  const match = content.match(/^Subject:\s*(.*?)\s*\|\s*From:\s*(.*?)\n([\s\S]*)$/);
  if (!match) return { subject: '', from: '', snippet: content };
  return { subject: match[1] ?? '', from: match[2] ?? '', snippet: match[3] ?? '' };
}

export function classifyShipment(event, { todayStr, yesterdayStr }) {
  const { subject, from, snippet } = parseGmailContent(event.content ?? '');
  if (!isShipmentLike(subject, from)) return null;
  const carrier = extractCarrier(from);
  const status = extractStatus(subject, snippet);
  if (!status) return null;
  const eventDate = new Date(event.ts).toISOString().slice(0, 10);
  let bucket = null;
  if (status === 'delivered' && eventDate === yesterdayStr) bucket = 'arrived_yesterday';
  else if (status === 'delivered' && eventDate === todayStr) bucket = 'arrived_today';
  else if (status === 'out_for_delivery' || status === 'arriving_today') bucket = 'arriving_today';
  else if (status === 'arriving_tomorrow') bucket = 'arriving_tomorrow';
  else if (status === 'shipped' || status === 'arriving_soon') bucket = 'in_transit';
  if (!bucket) return null;
  return {
    bucket,
    carrier,
    status,
    item: itemProxy(subject),
    ts: event.ts,
    gmail_id: event.meta?.gmail_id,
  };
}

function todayStrInTz() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDay(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function createGmailShipmentsTool({ db }) {
  return {
    name: 'gmail_shipments',
    description:
      'Parse captured Gmail events for shipment activity. Returns shipments bucketed by status: arrived_yesterday, arrived_today, arriving_today, arriving_tomorrow, in_transit. Subject/From are paraphrased; only summarized fields exposed. Uses subject + sender heuristics on the last `days_back` days of captured mail.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          default: 7,
          description: 'How many days of captured Gmail to scan.',
        },
      },
    },
    handler: async (args = {}) => {
      const daysBack = args.days_back ?? 7;
      const since = new Date(Date.now() - daysBack * 86400_000).toISOString();
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'gmail' AND ts >= $since ORDER BY ts DESC LIMIT 500`;
      const [rows] = await db.query(new BoundQuery(sql, { since })).collect();
      const todayStr = todayStrInTz();
      const yesterdayStr = shiftDay(todayStr, -1);
      const buckets = {
        arrived_yesterday: [],
        arrived_today: [],
        arriving_today: [],
        arriving_tomorrow: [],
        in_transit: [],
      };
      for (const r of rows) {
        const classified = classifyShipment(r, { todayStr, yesterdayStr });
        if (!classified) continue;
        buckets[classified.bucket].push(classified);
      }
      // Dedupe by (carrier, item) per bucket, keeping latest.
      for (const k of Object.keys(buckets)) {
        const seen = new Map();
        for (const s of buckets[k]) {
          const key = `${s.carrier}|${s.item}`;
          if (!seen.has(key)) seen.set(key, s);
        }
        buckets[k] = [...seen.values()];
      }
      return buckets;
    },
  };
}
