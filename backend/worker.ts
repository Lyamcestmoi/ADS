import { holdDeadline, rentalDates, rentalPrice, swissToday, validDate, weekendRate, type Rental } from '../src/lib/booking-rules.ts';
import { loadAvailability, type AvailabilityData } from '../src/lib/availability.ts';

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
export interface Env {
  DB: Database;
  SITE_ORIGIN: string;
  ADMIN_TOKEN: string;
  MEMBER_SECRET: string;
  TWINT_PAYMENT_URL?: string;
}

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
function fail(status: number, code: string): never { throw new ApiError(status, code); }
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const clean = (value: unknown, limit = 200) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const normalizedName = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr-CH');
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
const hash = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
async function keyedHash(env: Env, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.MEMBER_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function equalSecret(actual: string, expected: string) {
  const [left, right] = await Promise.all([hash(actual), hash(expected)]);
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}
async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'invalid_request');
  const text = await request.text();
  if (text.length > 180_000) fail(413, 'invalid_request');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request');
    return value as Record<string, unknown>;
  } catch { return fail(400, 'invalid_request'); }
}
async function limit(request: Request, env: Env, kind: string, maximum: number) {
  const bucket = Math.floor(Date.now() / 900_000);
  const address = request.headers.get('CF-Connecting-IP') ?? 'local';
  const key = await keyedHash(env, `${kind}:${bucket}:${address}`);
  await env.DB.prepare('INSERT INTO rate_limits(key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1').bind(key, (bucket + 2) * 900_000).run();
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first<{ count: number }>();
  if (!row || row.count > maximum) fail(429, 'rate_limited');
}

export async function expireOptions(env: Env, now = new Date()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reservation_dates WHERE reservation_id IN (SELECT id FROM reservations WHERE status = 'held' AND expires_at <= ?)").bind(now.toISOString()),
    env.DB.prepare("UPDATE reservations SET status = 'expired' WHERE status = 'held' AND expires_at <= ?").bind(now.toISOString()),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now.getTime()),
  ]);
}

async function verifyMember(env: Env, email: string, name: string, code: string) {
  if (!email || !name || code.length < 12 || code.length > 100) return false;
  const member = await env.DB.prepare('SELECT full_name, code_hash, active FROM members WHERE email = ?').bind(email).first<{ full_name: string; code_hash: string; active: number }>();
  const submitted = await keyedHash(env, `member:${email}:${code}`);
  // Same public error for a wrong name, code, email or inactive entry.
  return Boolean(member?.active && normalizedName(member.full_name) === normalizedName(name) && await equalSecret(submitted, member.code_hash));
}

type StoredReservation = {
  id: string; receipt_hash: string; request_hash: string; amount_cents: number; status: string;
  expires_at: string; payment_method: string;
};
const publicReceipt = (row: StoredReservation) => ({ id: row.id, amountCents: row.amount_cents, status: row.status, expiresAt: row.expires_at, paymentMethod: row.payment_method });

export async function handleRequest(request: Request, env: Env, calendarLoader: () => Promise<AvailabilityData> = () => loadAvailability(true)): Promise<Response> {
  const origin = request.headers.get('Origin');
  const allowed = env.SITE_ORIGIN;
  if (origin && origin !== allowed) return reply({ error: 'forbidden' }, 403);
  const cors = (response: Response) => {
    if (origin === allowed) response.headers.set('Access-Control-Allow-Origin', allowed);
    response.headers.set('Vary', 'Origin');
    return response;
  };
  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  } }));
  try {
    if (!env.DB || !env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !env.MEMBER_SECRET || env.MEMBER_SECRET.length < 32) fail(503, 'service_unavailable');
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const now = new Date();
    if (path.startsWith('/admin/')) {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (!token || !await equalSecret(token, env.ADMIN_TOKEN)) fail(401, 'unauthorized');
    }
    if (path === '/config' && request.method === 'GET') {
      const twint = env.TWINT_PAYMENT_URL && /^https:\/\//.test(env.TWINT_PAYMENT_URL) ? env.TWINT_PAYMENT_URL : null;
      return cors(reply({ twintPaymentUrl: twint, holdDays: 7 }));
    }
    if (path === '/members/verify' && request.method === 'POST') {
      await limit(request, env, 'member', 12);
      const input = await body(request);
      const email = clean(input.email).toLowerCase();
      if (!await verifyMember(env, email, clean(input.name), clean(input.code, 100))) fail(403, 'member_invalid');
      return cors(reply({ verified: true }));
    }
    if (path === '/availability' && request.method === 'GET') {
      const calendar = await calendarLoader();
      if (!calendar.available) fail(503, 'calendar_unavailable');
      const rows = await env.DB.prepare("SELECT d.rental_date, r.status FROM reservation_dates d JOIN reservations r ON r.id = d.reservation_id WHERE r.status = 'confirmed' OR (r.status = 'held' AND r.expires_at > ?)").bind(now.toISOString()).all<{ rental_date: string; status: string }>();
      const confirmed = rows.results.filter((row) => row.status === 'confirmed').map((row) => row.rental_date);
      const held = rows.results.filter((row) => row.status === 'held').map((row) => row.rental_date);
      return cors(reply({ bookedDates: [...new Set([...calendar.bookedDates, ...confirmed])], heldDates: held, available: true }));
    }
    if (path === '/reservations' && request.method === 'POST') {
      await limit(request, env, 'booking', 5);
      const input = await body(request);
      const tenant = input.tenant as Record<string, unknown> | undefined;
      if (!tenant || typeof tenant !== 'object') fail(400, 'invalid_request');
      const email = clean(tenant.email).toLowerCase();
      const firstName = clean(tenant.firstName, 100), lastName = clean(tenant.lastName, 100);
      const name = `${firstName} ${lastName}`;
      const contract = {
        firstName, lastName, email, address: clean(tenant.address), postal: clean(tenant.postal, 12),
        city: clean(tenant.city), phone: clean(tenant.phone, 50), iban: clean(tenant.iban, 50), remarks: clean(tenant.remarks, 2000),
      };
      const rental = input.rental as Rental;
      if (!rental || !validDate(rental.date) || rental.date <= swissToday(now)
        || Number(rental.date.slice(0, 4)) > now.getUTCFullYear() + 3
        || !['journee', 'soiree', 'complet', 'consecutif'].includes(rental.period)
        || !Number.isInteger(rental.people) || rental.people < 1 || rental.people > 70
        || !Number.isInteger(rental.days) || rental.days < 1 || rental.days > 30
        || (rental.period === 'consecutif' && rental.days < 3)
        || (rental.period !== 'consecutif' && rental.days !== 1)
        || (weekendRate(rental.date) && ['journee', 'soiree'].includes(rental.period))
        || !['pizza', 'wood', 'cleaning'].every((key) => typeof rental[key as keyof Rental] === 'boolean')
        || !firstName || !lastName || !contract.address || !contract.postal || !contract.city || !contract.phone
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || !['ebanking', 'twint'].includes(String(input.paymentMethod)) || input.accepted !== true) fail(400, 'invalid_request');
      const signatureText = clean(input.signatureText, 200);
      const signatureImage = clean(input.signatureImage, 140_000);
      if (!signatureText && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureImage)) fail(400, 'signature_required');
      const memberCode = clean(input.memberCode, 100);
      const member = memberCode ? await verifyMember(env, email, name, memberCode) : false;
      if (memberCode && !member) fail(403, 'member_invalid');
      if (!member && !contract.iban) fail(400, 'iban_required');
      const requestId = clean(input.requestId, 80), receiptToken = clean(input.receiptToken, 100);
      if (!/^[a-f0-9-]{36}$/.test(requestId) || !/^[a-f0-9-]{36}$/.test(receiptToken)) fail(400, 'invalid_request');
      const receiptHash = await hash(receiptToken);
      const requestHash = await hash(JSON.stringify({ contract, rental, signatureText, signatureImage, member, paymentMethod: input.paymentMethod }));
      await expireOptions(env, now);
      const previous = await env.DB.prepare('SELECT * FROM reservations WHERE request_id = ?').bind(requestId).first<StoredReservation>();
      if (previous) {
        if (!await equalSecret(previous.receipt_hash, receiptHash) || previous.request_hash !== requestHash) fail(409, 'conflict');
        return cors(reply(publicReceipt(previous)));
      }
      const calendar = await calendarLoader();
      if (!calendar.available) fail(503, 'calendar_unavailable');
      const dates = rentalDates(rental);
      if (dates.some((date) => calendar.bookedDates.includes(date))) fail(409, 'conflict');
      const price = rentalPrice(rental, member);
      const id = crypto.randomUUID();
      const expires = holdDeadline(now, rental.date, rental.period);
      const statements = [env.DB.prepare("INSERT INTO reservations(id, request_id, receipt_hash, request_hash, created_at, expires_at, status, start_date, period, days, amount_cents, payment_method, member, contract_json) VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, requestId, receiptHash, requestHash, now.toISOString(), expires, rental.date, rental.period, rental.days, price.total, input.paymentMethod, member ? 1 : 0, JSON.stringify({ tenant: contract, rental, signatureText, signatureImage, acceptedAt: now.toISOString() })),
        ...dates.map((date) => env.DB.prepare('INSERT INTO reservation_dates(rental_date, reservation_id) VALUES (?, ?)').bind(date, id)),
      ];
      try { await env.DB.batch(statements); } catch { fail(409, 'conflict'); }
      return cors(reply({ id, expiresAt: expires, status: 'held', amountCents: price.total, paymentMethod: input.paymentMethod }, 201));
    }
    const receiptMatch = path.match(/^\/reservations\/([a-f0-9-]{36})$/);
    if (receiptMatch && request.method === 'GET') {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      const row = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(receiptMatch[1]).first<StoredReservation>();
      if (!row || !await equalSecret(await hash(token), row.receipt_hash)) fail(404, 'not_found');
      const result = publicReceipt(row);
      if (result.status === 'held' && result.expiresAt <= now.toISOString()) result.status = 'expired';
      return cors(reply(result));
    }
    if (path === '/admin/members' && request.method === 'GET') {
      const rows = await env.DB.prepare('SELECT email, full_name, active FROM members ORDER BY full_name').all();
      return cors(reply(rows.results));
    }
    if (path === '/admin/members' && request.method === 'PUT') {
      const input = await body(request);
      const email = clean(input.email).toLowerCase(), fullName = clean(input.name);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName || typeof input.active !== 'boolean') fail(400, 'invalid_request');
      const existing = await env.DB.prepare('SELECT email FROM members WHERE email = ?').bind(email).first();
      // Regenerating a code invalidates the old one. Codes are never readable from the database.
      const code = input.resetCode === true || !existing ? crypto.randomUUID().replaceAll('-', '') : null;
      if (code) {
        const codeHash = await keyedHash(env, `member:${email}:${code}`);
        await env.DB.prepare('INSERT INTO members(email, full_name, code_hash, active) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET full_name = excluded.full_name, code_hash = excluded.code_hash, active = excluded.active').bind(email, fullName, codeHash, input.active ? 1 : 0).run();
      } else {
        await env.DB.prepare('UPDATE members SET full_name = ?, active = ? WHERE email = ?').bind(fullName, input.active ? 1 : 0, email).run();
      }
      return cors(reply({ saved: true, code }));
    }
    if (path === '/admin/reservations' && request.method === 'GET') {
      await expireOptions(env, now);
      const rows = await env.DB.prepare('SELECT id, created_at, expires_at, status, start_date, period, days, amount_cents, payment_method, member, contract_json, paid_at, payment_reference FROM reservations ORDER BY created_at DESC LIMIT 200').all();
      return cors(reply(rows.results));
    }
    const paymentMatch = path.match(/^\/admin\/reservations\/([a-f0-9-]{36})\/payment$/);
    if (paymentMatch && request.method === 'POST') {
      const input = await body(request);
      const row = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(paymentMatch[1]).first<StoredReservation>();
      if (!row) fail(404, 'not_found');
      if (input.amountCents !== row.amount_cents || clean(input.paymentReference, 150).length < 3) fail(400, 'payment_mismatch');
      // This protected action records a payment checked by management. It is NOT a bank webhook.
      if (row.status === 'confirmed') return cors(reply(publicReceipt(row)));
      if (row.status !== 'held' || row.expires_at <= now.toISOString()) fail(409, 'expired');
      try {
        const update = await env.DB.prepare("UPDATE reservations SET status = 'confirmed', paid_at = ?, payment_reference = ? WHERE id = ? AND status = 'held' AND expires_at > ?")
          .bind(now.toISOString(), clean(input.paymentReference, 150), row.id, now.toISOString()).run();
        if (update.meta.changes !== 1) fail(409, 'expired');
      } catch (error) { if (error instanceof ApiError) throw error; fail(409, 'payment_reference_used'); }
      return cors(reply({ ...publicReceipt(row), status: 'confirmed' }));
    }
    return cors(reply({ error: 'not_found' }, 404));
  } catch (error) {
    return cors(reply({ error: error instanceof ApiError ? error.code : 'service_unavailable' }, error instanceof ApiError ? error.status : 503));
  }
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
  scheduled: (_event: unknown, env: Env) => expireOptions(env),
};
