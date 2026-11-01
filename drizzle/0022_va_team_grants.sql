-- VA administrators become administrators of the reserved team 'va' (ADR 0002, phase 2b).
-- On an empty database (fresh install, offline restore) nothing is inserted.
INSERT OR IGNORE INTO teams(id,name,version,kind)
  SELECT 'va','Vacaciones de antigüedad',1,'va' WHERE EXISTS(SELECT 1 FROM users WHERE va_admin=1);
--> statement-breakpoint
INSERT OR IGNORE INTO grants(id,user_id,team_id,expires_at)
  SELECT lower(hex(randomblob(16))),id,'va',NULL FROM users WHERE va_admin=1;
--> statement-breakpoint
UPDATE users SET role='team_admin' WHERE va_admin=1;
--> statement-breakpoint
ALTER TABLE users DROP COLUMN va_admin;
