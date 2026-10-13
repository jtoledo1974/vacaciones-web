CREATE TABLE `controller_accounts` (
	`person_id` text PRIMARY KEY NOT NULL,
	`principal_key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `controller_account_identity` ON `controller_accounts` (`principal_key`);--> statement-breakpoint
CREATE TABLE `election_states` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`member_id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`dates_json` text NOT NULL,
	`automatic` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `campaign_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
