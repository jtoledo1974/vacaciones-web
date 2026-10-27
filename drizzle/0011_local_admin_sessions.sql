-- Local admin sessions and login attempts leave the audit table: they expire and
-- are revoked, while audit only grows. Neither table is part of backups.
CREATE TABLE `local_admin_sessions` (`id` text PRIMARY KEY NOT NULL, `actor` text NOT NULL, `created_at` text NOT NULL, `expires_at` integer NOT NULL, `revoked_at` text);
--> statement-breakpoint
CREATE TABLE `local_admin_attempts` (`id` text PRIMARY KEY NOT NULL, `attempt_key` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `local_admin_attempt_key` ON `local_admin_attempts` (`attempt_key`,`created_at`);
--> statement-breakpoint
-- Open sessions survive the move; revoked sessions and attempts are dropped.
INSERT INTO `local_admin_sessions`(`id`,`actor`,`created_at`,`expires_at`) SELECT `id`,`actor`,`created_at`,CAST(json_extract(`after_json`,'$.expires') AS integer) FROM `audit` WHERE `action`='local_admin_session' AND json_extract(`after_json`,'$.expires') IS NOT NULL;
--> statement-breakpoint
DELETE FROM `audit` WHERE `action` IN ('local_admin_session','local_admin_session_revoked','local_admin_login_attempt');
