-- How a saved list is used when its owner's turn arrives: 'immediate' applies it
-- at once (the previous behaviour), 'wait' after wait_minutes from the start of
-- the turn, 'manual' never (the list is only a note for the controller).
ALTER TABLE `preferences` ADD `mode` text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `wait_minutes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Optional names the controller gives to listed cycles («Eclipse», «Semana Santa»): {cycle date: label}.
ALTER TABLE `preferences` ADD `labels_json` text DEFAULT '{}' NOT NULL;
