CREATE TABLE `seed_history` (
	`name` varchar(255) NOT NULL,
	`checksum` varchar(64) NOT NULL,
	`applied_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `seed_history_name` PRIMARY KEY(`name`)
);
