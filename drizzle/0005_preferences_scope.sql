ALTER TABLE `preferences` ADD `persistent` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `active` integer DEFAULT 1 NOT NULL;
