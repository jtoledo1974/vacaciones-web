-- One global VA election per year. Private preferences stay inside the stored
-- snapshot and are explicitly projected for the authenticated owner on reads.
CREATE TABLE va_campaigns (
  year INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  json TEXT NOT NULL
);
-- Empty outside a batch, like transaction_assertions. The named constraint lets
-- the API distinguish a real VA conflict from a stale ordinary campaign version.
CREATE TABLE va_integrity_assertions (
  id TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CONSTRAINT va_ordinary_overlap CHECK(valid=1)
);
