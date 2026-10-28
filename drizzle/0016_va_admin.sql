-- Global VA administrator, added to the user's team role rather than replacing it.
ALTER TABLE users ADD COLUMN va_admin INTEGER NOT NULL DEFAULT 0;
