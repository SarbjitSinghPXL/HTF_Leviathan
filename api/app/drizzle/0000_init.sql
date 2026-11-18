CREATE TABLE `events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`voyage_id` int NOT NULL,
	`date` datetime NOT NULL,
	`location` varchar(255) NOT NULL,
	`latitude` double NOT NULL,
	`longitude` double NOT NULL,
	`activity` varchar(255) NOT NULL,
	`weather` varchar(255) DEFAULT '',
	`wind_direction` varchar(255) DEFAULT '',
	`course_direction` varchar(255) DEFAULT '',
	`ships_encountered` text DEFAULT (''),
	`whale_activity` text DEFAULT (''),
	`notes` text DEFAULT (''),
	`motivation_levels` int DEFAULT 0,
	`casualties` int DEFAULT 0,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ships` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ship_name` varchar(255) NOT NULL,
	`home_port` varchar(255),
	CONSTRAINT `ships_id` PRIMARY KEY(`id`),
	CONSTRAINT `ships_ship_name_unique` UNIQUE(`ship_name`)
);
--> statement-breakpoint
CREATE TABLE `voyages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ship_id` int NOT NULL,
	`starting_port` varchar(255),
	`destination_port` varchar(255),
	`captain_name` varchar(255) NOT NULL,
	`crew_count` int DEFAULT 0,
	`casualties` int DEFAULT 0,
	`start_date` datetime NOT NULL,
	CONSTRAINT `voyages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `events` ADD CONSTRAINT `events_voyage_id_voyages_id_fk` FOREIGN KEY (`voyage_id`) REFERENCES `voyages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voyages` ADD CONSTRAINT `voyages_ship_id_ships_id_fk` FOREIGN KEY (`ship_id`) REFERENCES `ships`(`id`) ON DELETE cascade ON UPDATE no action;