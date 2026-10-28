-- RRHH's daily VA places for a year, loaded and corrected by CLI. A missing day has none.
CREATE TABLE `va_quotas` (`year` integer NOT NULL, `date` text NOT NULL, `places` integer NOT NULL, PRIMARY KEY(`year`, `date`));
--> statement-breakpoint
-- Provenance of the year's current calendar and its version for review tokens.
CREATE TABLE `va_quota_sources` (`year` integer PRIMARY KEY NOT NULL, `title` text NOT NULL, `sha256` text NOT NULL, `received_at` text NOT NULL, `version` integer NOT NULL DEFAULT 1, `updated_at` text NOT NULL);
