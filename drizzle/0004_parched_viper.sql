DROP INDEX `campaign_team_year`;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `scope_key` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `simulation_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_team_year_scope` ON `campaigns` (`team_id`,`year`,`scope_key`);