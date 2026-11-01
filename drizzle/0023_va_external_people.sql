-- External VA people become people of the reserved team 'va' (ADR 0002, phase 2c).
-- Their ids, nicks, employee numbers and linked accounts are kept; the category is dropped (unused).
DROP TRIGGER va_external_number_insert;
--> statement-breakpoint
DROP TRIGGER va_external_number_update;
--> statement-breakpoint
DROP TRIGGER va_master_number_insert;
--> statement-breakpoint
DROP TRIGGER va_master_number_update;
--> statement-breakpoint
DROP TRIGGER va_external_account_insert;
--> statement-breakpoint
DROP TRIGGER va_external_account_update;
--> statement-breakpoint
DROP TRIGGER va_master_account_insert;
--> statement-breakpoint
DROP TRIGGER va_master_account_update;
--> statement-breakpoint
INSERT OR IGNORE INTO teams(id,name,version,kind)
  SELECT 'va','Vacaciones de antigüedad',1,'va' WHERE EXISTS(SELECT 1 FROM va_external_people);
--> statement-breakpoint
INSERT INTO people(id,team_id,code,label,position,seniority,active,version,controller_number)
  SELECT id,'va',code,label,0,seniority,active,version,controller_number FROM va_external_people;
--> statement-breakpoint
INSERT INTO controller_accounts(person_id,principal_key,version)
  SELECT person_id,principal_key,version FROM va_external_accounts;
--> statement-breakpoint
DROP TABLE va_external_accounts;
--> statement-breakpoint
DROP TABLE va_external_people;
