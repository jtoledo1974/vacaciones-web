-- RRHH's yearly workbook (macro .xlsm, base64) and each person's exact RRHH name.
CREATE TABLE `hr_templates` (`year` integer PRIMARY KEY NOT NULL, `data` text NOT NULL, `sha256` text NOT NULL, `uploaded_by` text NOT NULL, `uploaded_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `hr_names` (`year` integer NOT NULL, `person_id` text NOT NULL REFERENCES `people`(`id`), `hr_name` text NOT NULL, PRIMARY KEY(`year`, `person_id`));
