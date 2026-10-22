import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { bernHolidays, holidayForDate, rentalPrice, holdDeadline, addDays, swissToday } from '../src/lib/booking-rules.ts';
import { handleRequest, expireOptions } from '../backend/worker.ts';

class TestDatabase {
  raw = new DatabaseSync(':memory:');
  constructor() { this.raw.exec(readFileSync(new URL('../backend/migrations/0001_reservations.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const db = this;
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() { return db.raw.prepare(sql).get(...this.values) ?? null; },
      async all() { return { results: db.raw.prepare(sql).all(...this.values) }; },
      execute() { const result = db.raw.prepare(sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; },
      async run() { return this.execute(); },
    };
  }
  async batch(statements) {
    this.raw.exec('BEGIN');
    try { const results = statements.map((statement) => statement.execute()); this.raw.exec('COMMIT'); return results; }
    catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
}
const calendar = async () => ({ available: true, bookedDates: [], syncedAt: new Date().toISOString() });
const setup = () => ({ DB: new TestDatabase(), SITE_ORIGIN: 'https://ads.example.test', ADMIN_TOKEN: 'admin-test-only-'.repeat(4), MEMBER_SECRET: 'member-test-only-'.repeat(4) });
const payload = () => ({
  requestId: crypto.randomUUID(), receiptToken: crypto.randomUUID(),
  tenant: { firstName: 'Test', lastName: 'Locataire', email: 'tenant@example.test', address: 'Rue Exemple 1', postal: '2515', city: 'Prêles', phone: '0000000000', iban: 'CH0000000000000000000' },
  rental: { date: addDays(swissToday(), 30), period: 'complet', days: 1, people: 20, pizza: false, wood: false, cleaning: true },
  paymentMethod: 'ebanking', accepted: true, signatureText: 'Test Locataire',
});
const request = (path, method = 'GET', value, token) => new Request(`https://api.example.test${path}`, {
  method, headers: { Origin: 'https://ads.example.test', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: value === undefined ? undefined : JSON.stringify(value),
});
const call = (env, path, method, value, token) => handleRequest(request(path, method, value, token), env, calendar);

test('Bern holidays include movable dates for 2026 and 2027, not administrative half-days', () => {
  const holidays = new Set(bernHolidays(2026).map((holiday) => holiday.date));
  for (const date of ['2026-01-01', '2026-01-02', '2026-04-03', '2026-04-05', '2026-04-06', '2026-05-14', '2026-05-24', '2026-05-25', '2026-08-01', '2026-09-20', '2026-12-25', '2026-12-26']) assert.equal(holidays.has(date), true, date);
  for (const date of ['2027-03-26', '2027-03-28', '2027-03-29', '2027-05-06', '2027-05-17']) assert.ok(holidayForDate(date), date);
  for (const date of ['2026-05-01', '2026-12-24', '2026-12-31', '2026-02-30']) assert.equal(holidayForDate(date), undefined, date);
  assert.equal(swissToday(new Date('2026-01-01T23:30:00Z')), '2026-01-02');
  assert.equal(swissToday(new Date('2026-06-01T22:30:00Z')), '2026-06-02');
});

test('holiday and membership rates are calculated in cents; discount excludes deposit and options', () => {
  const rental = { ...payload().rental, date: '2026-04-06' };
  assert.deepEqual(rentalPrice(rental, false), { base: 19000, discount: 0, deposit: 15000, options: 15000, total: 34000 });
  assert.equal(rentalPrice({ ...rental, pizza: true, wood: true }, true).total, 23200);
  assert.equal(rentalPrice({ ...rental, period: 'consecutif', days: 3 }, false).total, 63000);
  assert.equal(rentalPrice({ ...rental, date: '2026-10-23' }, false).total, 34000); // Friday follows the published weekend rate.
  assert.equal(holdDeadline(new Date('2026-10-22T12:00:00Z'), '2026-12-01'), '2026-10-29T12:00:00.000Z');
  assert.equal(holdDeadline(new Date('2026-10-22T12:00:00Z'), '2026-10-25'), '2026-10-25T09:00:00.000Z');
  assert.equal(holdDeadline(new Date('2026-06-01T12:00:00Z'), '2026-06-02', 'soiree'), '2026-06-02T16:00:00.000Z');
});

test('a hold reserves all requested days, lasts seven days and expires without payment', async () => {
  const env = setup(), input = payload(); input.rental.period = 'consecutif'; input.rental.days = 3;
  const response = await call(env, '/reservations', 'POST', input); assert.equal(response.status, 201);
  const receipt = await response.json(); assert.equal(receipt.status, 'held');
  assert.ok(Math.abs(new Date(receipt.expiresAt) - Date.now() - 7 * 86400000) < 3000);
  const availability = await (await call(env, '/availability')).json(); assert.equal(availability.heldDates.length, 3);
  assert.deepEqual(availability.bookedDates, []);
  await expireOptions(env, new Date(Date.now() + 8 * 86400000));
  const released = await (await call(env, '/availability')).json(); assert.equal(released.heldDates.length, 0);
  assert.equal(env.DB.raw.prepare('SELECT status FROM reservations WHERE id = ?').get(receipt.id).status, 'expired');
});

test('simultaneous requests cannot reserve the same date twice', async () => {
  const env = setup();
  const responses = await Promise.all([call(env, '/reservations', 'POST', payload()), call(env, '/reservations', 'POST', payload())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
});

test('multi-day conflict rolls back every inserted date and reservation', async () => {
  const env = setup(), initial = payload(); initial.rental.date = addDays(initial.rental.date, 1);
  assert.equal((await call(env, '/reservations', 'POST', initial)).status, 201);
  const multiple = payload(); multiple.rental.period = 'consecutif'; multiple.rental.days = 3;
  assert.equal((await call(env, '/reservations', 'POST', multiple)).status, 409);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM reservation_dates').get().count, 1);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
});

test('retries are idempotent but a changed contract or receipt secret is rejected', async () => {
  const env = setup(), input = payload();
  const original = await (await call(env, '/reservations', 'POST', input)).json();
  const repeated = await (await call(env, '/reservations', 'POST', input)).json(); assert.equal(repeated.id, original.id);
  const tampered = structuredClone(input); tampered.tenant.city = 'Different';
  assert.equal((await call(env, '/reservations', 'POST', tampered)).status, 409);
  const stolen = { ...input, receiptToken: crypto.randomUUID() };
  assert.equal((await call(env, '/reservations', 'POST', stolen)).status, 409);
});

test('membership roster is private and a valid member code is required for benefits', async () => {
  const env = setup();
  assert.equal((await call(env, '/admin/members')).status, 401);
  const saved = await (await call(env, '/admin/members', 'PUT', { email: 'tenant@example.test', name: 'Test Locataire', active: true }, env.ADMIN_TOKEN)).json();
  assert.equal(saved.code.length, 32);
  const list = await (await call(env, '/admin/members', 'GET', undefined, env.ADMIN_TOKEN)).json(); assert.equal('code_hash' in list[0], false);
  const input = payload(); input.memberCode = 'made-up-invalid-code';
  assert.equal((await call(env, '/reservations', 'POST', input)).status, 403);
  input.memberCode = saved.code; input.amountCents = 1; input.member = true;
  const response = await call(env, '/reservations', 'POST', input); assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.amountCents, rentalPrice(input.rental, true).total);
  const row = env.DB.raw.prepare('SELECT member, contract_json FROM reservations WHERE id = ?').get(receipt.id); assert.equal(row.member, 1); assert.equal(row.contract_json.includes(saved.code), false);
  await call(env, '/admin/members', 'PUT', { email: 'tenant@example.test', name: 'Test Locataire', active: false }, env.ADMIN_TOKEN);
  assert.equal((await call(env, '/members/verify', 'POST', { email: 'tenant@example.test', name: 'Test Locataire', code: saved.code })).status, 403);
});

test('client-supplied amounts and member flags never determine the amount due', async () => {
  const env = setup(), input = payload(); input.member = true; input.amountCents = 1;
  const response = await call(env, '/reservations', 'POST', input); assert.equal(response.status, 201);
  assert.equal((await response.json()).amountCents, rentalPrice(input.rental, false).total);
});

test('only management can confirm an exact payment; confirmed bookings never expire', async () => {
  const env = setup(), input = payload();
  const receipt = await (await call(env, '/reservations', 'POST', input)).json();
  const payment = { amountCents: receipt.amountCents, paymentReference: 'BANK-TEST-123' };
  assert.equal((await call(env, `/admin/reservations/${receipt.id}/payment`, 'POST', payment)).status, 401);
  assert.equal((await call(env, `/admin/reservations/${receipt.id}/payment`, 'POST', { ...payment, amountCents: 1 }, env.ADMIN_TOKEN)).status, 400);
  assert.equal((await call(env, `/admin/reservations/${receipt.id}/payment`, 'POST', payment, env.ADMIN_TOKEN)).status, 200);
  await expireOptions(env, new Date(Date.now() + 8 * 86400000));
  const availability = await (await call(env, '/availability')).json(); assert.ok(availability.bookedDates.includes(input.rental.date));
  assert.equal(availability.heldDates.length, 0);
});

test('a late payment does not silently confirm an expired option', async () => {
  const env = setup(), input = payload();
  const receipt = await (await call(env, '/reservations', 'POST', input)).json();
  await expireOptions(env, new Date(Date.now() + 8 * 86400000));
  const response = await call(env, `/admin/reservations/${receipt.id}/payment`, 'POST', { amountCents: receipt.amountCents, paymentReference: 'LATE-TEST' }, env.ADMIN_TOKEN);
  assert.equal(response.status, 409);
});

test('receipt access needs the private receipt token and never exposes contact details', async () => {
  const env = setup(), input = payload();
  const receipt = await (await call(env, '/reservations', 'POST', input)).json();
  assert.equal((await call(env, `/reservations/${receipt.id}`)).status, 404);
  const response = await call(env, `/reservations/${receipt.id}`, 'GET', undefined, input.receiptToken);
  assert.equal(response.status, 200); assert.equal((await response.text()).includes(input.tenant.email), false);
});

test('calendar failures and conflicting existing Google dates prevent new holds', async () => {
  const env = setup(), input = payload();
  const unavailable = await handleRequest(request('/reservations', 'POST', input), env, async () => ({ available: false, bookedDates: [], syncedAt: null })); assert.equal(unavailable.status, 503);
  const conflict = await handleRequest(request('/reservations', 'POST', input), env, async () => ({ available: true, bookedDates: [input.rental.date], syncedAt: new Date().toISOString() })); assert.equal(conflict.status, 409);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 0);
});

test('unexpected origins and incomplete deployment credentials fail closed', async () => {
  const env = setup();
  const wrongOrigin = new Request('https://api.example.test/admin/members', { headers: { Origin: 'https://other.example.test', Authorization: `Bearer ${env.ADMIN_TOKEN}` } });
  assert.equal((await handleRequest(wrongOrigin, env, calendar)).status, 403);
  assert.equal((await call({ ...env, ADMIN_TOKEN: '' }, '/availability')).status, 503);
});

test('member-code guessing is rate limited without disclosing whether an email is registered', async () => {
  const env = setup();
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await call(env, '/members/verify', 'POST', { email: `unknown-${attempt}@example.test`, name: 'Unknown Member', code: 'invalid-member-code' });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'member_invalid' });
  }
  assert.equal((await call(env, '/members/verify', 'POST', { email: 'unknown@example.test', name: 'Unknown Member', code: 'invalid-member-code' })).status, 429);
});
