ALTER TABLE people ADD COLUMN controller_number INTEGER;
CREATE UNIQUE INDEX person_controller_number ON people(controller_number);
