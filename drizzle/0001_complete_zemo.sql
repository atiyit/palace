CREATE TABLE `provider_settings` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`model` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `kind`)
);
