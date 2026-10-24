-- Secondary SQLite indexes retain rowid order for each campaign. Replay and
-- last-event reads can filter by campaign without scanning other campaigns.
CREATE INDEX `audit_campaign` ON `audit` (`campaign_id`);
