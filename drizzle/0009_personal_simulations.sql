-- One private what-if per account and campaign. It never feeds the election:
-- no foreign keys, so deleting campaigns or members needs no cascade, and a
-- stale row is discarded when it no longer replays.
CREATE TABLE `personal_simulations` (`owner_key` text NOT NULL, `campaign_id` text NOT NULL, `member_id` text NOT NULL, `json` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY(`owner_key`,`campaign_id`));
