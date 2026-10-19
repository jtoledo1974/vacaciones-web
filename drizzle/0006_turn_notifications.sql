CREATE TABLE `push_subscriptions` (`endpoint` text PRIMARY KEY NOT NULL, `owner_key` text NOT NULL, `p256dh` text NOT NULL, `auth` text NOT NULL, `created_at` text NOT NULL);--> statement-breakpoint
CREATE INDEX `push_subscription_owner` ON `push_subscriptions` (`owner_key`);--> statement-breakpoint
CREATE TABLE `turn_notifications` (`id` text PRIMARY KEY NOT NULL, `owner_key` text NOT NULL, `campaign_id` text NOT NULL, `member_id` text NOT NULL, `round` integer NOT NULL, `created_at` text NOT NULL, `push_status` text DEFAULT 'pending' NOT NULL);--> statement-breakpoint
CREATE INDEX `turn_notification_owner` ON `turn_notifications` (`owner_key`,`created_at`);
--> statement-breakpoint
CREATE TABLE `push_deliveries` (`event_id` text NOT NULL, `endpoint` text NOT NULL, `status` text DEFAULT 'pending' NOT NULL, `lease_token` text, `lease_expires_at` integer DEFAULT 0 NOT NULL, `attempts` integer DEFAULT 0 NOT NULL, PRIMARY KEY(`event_id`,`endpoint`));--> statement-breakpoint
CREATE INDEX `push_delivery_status` ON `push_deliveries` (`status`,`lease_expires_at`);
