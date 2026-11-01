-- ADR 0002: the reserved team 'va' holds the yearly VA campaign; every other team is ordinary.
-- The 'va' row is created on first use (INSERT OR IGNORE), never here, so restores stay clean.
ALTER TABLE teams ADD COLUMN kind TEXT NOT NULL DEFAULT 'ordinary' CHECK (kind IN ('ordinary', 'va'));
