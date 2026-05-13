CREATE TABLE `draw_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`prize_name` text DEFAULT '' NOT NULL,
	`winner_count` integer NOT NULL,
	`rules` text NOT NULL,
	`seed` text NOT NULL,
	`commit_hash` text NOT NULL,
	`candidate_ids` text NOT NULL,
	`selected_ids` text NOT NULL,
	`confirmed_ids` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`drawn_at` integer NOT NULL,
	`confirmed_at` integer,
	`redraw_audit` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rounds_post` ON `draw_rounds` (`post_id`);--> statement-breakpoint
CREATE INDEX `idx_rounds_confirmed_at` ON `draw_rounds` (`confirmed_at`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_nickname` text DEFAULT '' NOT NULL,
	`user_avatar` text DEFAULT '' NOT NULL,
	`user_follows_count` integer,
	`user_fans_count` integer,
	`followed_blogger` integer DEFAULT false NOT NULL,
	`types` text NOT NULL,
	`comment_text` text,
	`comment_created_at` integer,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_interactions_post_user` ON `interactions` (`post_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_interactions_post` ON `interactions` (`post_id`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`xsec_token` text NOT NULL,
	`xsec_source` text DEFAULT 'pc_feed' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`imported_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_fetched_at` integer,
	`raw_url` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `win_history` (
	`user_id` text NOT NULL,
	`round_id` text NOT NULL,
	`post_id` text NOT NULL,
	`prize_name` text,
	`won_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `round_id`),
	FOREIGN KEY (`round_id`) REFERENCES `draw_rounds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_win_history_user_won_at` ON `win_history` (`user_id`,`won_at`);--> statement-breakpoint
CREATE INDEX `idx_win_history_won_at` ON `win_history` (`won_at`);