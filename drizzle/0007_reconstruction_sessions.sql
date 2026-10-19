CREATE TABLE `reconstruction_sessions` (
  `campaign_id` text PRIMARY KEY NOT NULL REFERENCES `campaigns`(`id`),
  `json` text NOT NULL
);
