-- Units a member must take, frozen when they join (VA days, ADR 0002). NULL in ordinary campaigns.
ALTER TABLE campaign_members ADD COLUMN entitlement INTEGER;
