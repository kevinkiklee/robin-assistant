import { BoundQuery } from 'surrealdb';
import { parseGmailContent } from './gmail-shipments.js';
import { wrapUntrusted } from '../../../../cognition/discretion/wrap-untrusted.js';

const INFORMED_DELIVERY_SENDER_RE =
  /USPSInformedDelivery|@informeddelivery\.usps|@email\.informeddelivery\.usps|@usps\.com.*informed/i;
const INFORMED_DELIVERY_SUBJECT_RE = /informed delivery|daily digest|your mail today|usps.*today/i;
const PIECE_RE = /(\d+)\s*(?:mail\s*piece|mailpiece|piece|item)s?/i;
const PACKAGE_RE = /(\d+)\s*package/i;

export function classifyMailPreview(event) {
  const { subject, from, snippet } = parseGmailContent(event.content ?? '');
  const senderMatch = INFORMED_DELIVERY_SENDER_RE.test(from);
  const subjectMatch = INFORMED_DELIVERY_SUBJECT_RE.test(subject);
  if (!senderMatch && !subjectMatch) return null;
  const haystack = `${subject} ${snippet}`;
  const piecesM = haystack.match(PIECE_RE);
  const packagesM = haystack.match(PACKAGE_RE);
  const pieces = piecesM ? Number(piecesM[1]) : null;
  const packages = packagesM ? Number(packagesM[1]) : null;
  if (pieces === null && packages === null) return null;
  return {
    ts: event.ts,
    date: new Date(event.ts).toISOString().slice(0, 10),
    pieces,
    packages,
    subject,
    gmail_id: event.meta?.gmail_id,
  };
}

export function createGmailMailPreviewTool({ db }) {
  return {
    name: 'gmail_mail_preview',
    description:
      'Return USPS Informed Delivery digests captured in the last days_back days. Each entry shows the expected mail-piece and package count for that delivery day. USPS sends one digest per delivery day; weekends and holidays are skipped. Counts come from the email subject/snippet — envelope scans themselves are not extracted.',
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
      const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'gmail' AND ts >= $since ORDER BY ts DESC LIMIT 500`;
      const [rows] = await db.query(new BoundQuery(sql, { since })).collect();
      const byDate = new Map();
      for (const r of rows) {
        const c = classifyMailPreview(r);
        if (!c) continue;
        // USPS sends one digest per delivery day; keep the latest if duplicates arrive.
        const prior = byDate.get(c.date);
        if (!prior || new Date(c.ts) > new Date(prior.ts)) byDate.set(c.date, c);
      }
      const rawDays = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
      const days = rawDays.map((d) => ({
        ...d,
        subject: d.subject != null
          ? wrapUntrusted(d.subject, { source: 'gmail', trust: 'untrusted' })
          : d.subject,
      }));
      const totalPieces = days.reduce((s, d) => s + (d.pieces ?? 0), 0);
      const totalPackages = days.reduce((s, d) => s + (d.packages ?? 0), 0);
      const todayStr = new Date().toISOString().slice(0, 10);
      return {
        days,
        count: days.length,
        total_pieces: totalPieces,
        total_packages: totalPackages,
        today: days.find((d) => d.date === todayStr) ?? null,
        latest: days[0] ?? null,
      };
    },
  };
}
