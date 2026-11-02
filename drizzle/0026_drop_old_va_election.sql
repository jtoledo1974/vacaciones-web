-- The old VA election (ADR 0002, phase 5): VA is a campaign of the team `va` on the common engine.
-- Guard: refuses to run while an old VA election remains. Move its participants to the common
-- campaign (docs/vacaciones-antiguedad/MIGRACION-FASE-5.md), then empty va_campaigns by hand.
CREATE TABLE migration_0026_guard (ok INTEGER NOT NULL CONSTRAINT old_va_election_still_present CHECK (ok = 1));
--> statement-breakpoint
INSERT INTO migration_0026_guard(ok) SELECT 0 WHERE EXISTS (SELECT 1 FROM va_campaigns);
--> statement-breakpoint
DROP TABLE migration_0026_guard;
--> statement-breakpoint
-- Children first; their backup_clock triggers go with the tables.
DROP TABLE IF EXISTS va_reconstructions;
--> statement-breakpoint
DROP TABLE IF EXISTS va_election_history;
--> statement-breakpoint
DROP TABLE IF EXISTS va_campaigns;
