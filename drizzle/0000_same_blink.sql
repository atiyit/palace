CREATE TABLE `palace_states` (
	`user_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`request_ids_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL
);
