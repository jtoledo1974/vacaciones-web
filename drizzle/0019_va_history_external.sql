CREATE TABLE va_election_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL REFERENCES va_campaigns(year),
  action TEXT NOT NULL,
  actor TEXT,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX va_history_year ON va_election_history(year,id);
CREATE TABLE va_reconstructions (
  year INTEGER PRIMARY KEY REFERENCES va_campaigns(year),
  working_json TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
-- People outside the eight ordinary teams have their own VA master record.
-- No artificial team or ordinary campaign is created for them.
CREATE TABLE va_external_people (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  seniority TEXT NOT NULL,
  controller_number INTEGER NOT NULL UNIQUE,
  category TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE va_external_accounts (
  person_id TEXT PRIMARY KEY NOT NULL REFERENCES va_external_people(id),
  principal_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TRIGGER va_external_number_insert BEFORE INSERT ON va_external_people
WHEN EXISTS(SELECT 1 FROM people WHERE controller_number=NEW.controller_number)
BEGIN SELECT RAISE(ABORT,'va_duplicate_controller_number'); END;
CREATE TRIGGER va_external_number_update BEFORE UPDATE OF controller_number ON va_external_people
WHEN EXISTS(SELECT 1 FROM people WHERE controller_number=NEW.controller_number)
BEGIN SELECT RAISE(ABORT,'va_duplicate_controller_number'); END;
CREATE TRIGGER va_master_number_insert BEFORE INSERT ON people
WHEN EXISTS(SELECT 1 FROM va_external_people WHERE controller_number=NEW.controller_number)
BEGIN SELECT RAISE(ABORT,'va_duplicate_controller_number'); END;
CREATE TRIGGER va_master_number_update BEFORE UPDATE OF controller_number ON people
WHEN EXISTS(SELECT 1 FROM va_external_people WHERE controller_number=NEW.controller_number)
BEGIN SELECT RAISE(ABORT,'va_duplicate_controller_number'); END;
CREATE TRIGGER va_external_account_insert BEFORE INSERT ON va_external_accounts
WHEN EXISTS(SELECT 1 FROM controller_accounts WHERE principal_key=NEW.principal_key)
BEGIN SELECT RAISE(ABORT,'va_duplicate_account'); END;
CREATE TRIGGER va_external_account_update BEFORE UPDATE OF principal_key ON va_external_accounts
WHEN EXISTS(SELECT 1 FROM controller_accounts WHERE principal_key=NEW.principal_key)
BEGIN SELECT RAISE(ABORT,'va_duplicate_account'); END;
CREATE TRIGGER va_master_account_insert BEFORE INSERT ON controller_accounts
WHEN EXISTS(SELECT 1 FROM va_external_accounts WHERE principal_key=NEW.principal_key)
BEGIN SELECT RAISE(ABORT,'va_duplicate_account'); END;
CREATE TRIGGER va_master_account_update BEFORE UPDATE OF principal_key ON controller_accounts
WHEN EXISTS(SELECT 1 FROM va_external_accounts WHERE principal_key=NEW.principal_key)
BEGIN SELECT RAISE(ABORT,'va_duplicate_account'); END;
