PRAGMA foreign_keys = ON;

CREATE TABLE members (
  email TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  receipt_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'expired', 'cancelled')),
  start_date TEXT NOT NULL,
  period TEXT NOT NULL,
  days INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('ebanking', 'twint')),
  member INTEGER NOT NULL CHECK (member IN (0, 1)),
  contract_json TEXT NOT NULL,
  paid_at TEXT,
  payment_reference TEXT UNIQUE
);

-- One owner per rental date. Multi-day inserts run in the same transaction.
CREATE TABLE reservation_dates (
  rental_date TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id)
);
CREATE INDEX reservations_status_expiry ON reservations(status, expires_at);
CREATE INDEX reservation_dates_owner ON reservation_dates(reservation_id);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
