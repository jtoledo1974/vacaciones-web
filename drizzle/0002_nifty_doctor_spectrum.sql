ALTER TABLE `campaigns` ADD `data_kind` text DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaign_members` ADD `label` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaign_members` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `label` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `position` integer DEFAULT 0 NOT NULL;