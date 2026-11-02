-- One RRHH workbook per year and kind: ordinary vacations and VA (ADR 0002). Existing rows are ordinary.
CREATE TABLE hr_templates_new (
  year INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ordinary' CHECK (kind IN ('ordinary','va')),
  data TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY(year, kind)
);
--> statement-breakpoint
INSERT INTO hr_templates_new(year,kind,data,sha256,uploaded_by,uploaded_at)
  SELECT year,'ordinary',data,sha256,uploaded_by,uploaded_at FROM hr_templates;
--> statement-breakpoint
DROP TABLE hr_templates;
--> statement-breakpoint
ALTER TABLE hr_templates_new RENAME TO hr_templates;
--> statement-breakpoint
CREATE TRIGGER backup_clock_hr_templates_insert AFTER INSERT ON hr_templates BEGIN UPDATE backup_clock SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER backup_clock_hr_templates_update AFTER UPDATE ON hr_templates BEGIN UPDATE backup_clock SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER backup_clock_hr_templates_delete AFTER DELETE ON hr_templates BEGIN UPDATE backup_clock SET revision=revision+1 WHERE id='main'; END;
