-- One row per install: a hash of the random ID Lunchbox makes on first launch, its system and the
-- version it last ran. Nothing else about the person.
CREATE TABLE installs (
	hash TEXT PRIMARY KEY,
	first_day TEXT NOT NULL,
	last_day TEXT NOT NULL,
	os TEXT NOT NULL,
	arch TEXT NOT NULL,
	version TEXT NOT NULL
);
CREATE INDEX installs_first_day ON installs (first_day);
CREATE INDEX installs_last_day ON installs (last_day);

-- Which installs were opened on which day, and on which version, so an update's reach shows day by day.
CREATE TABLE active (
	day TEXT NOT NULL,
	hash TEXT NOT NULL,
	version TEXT NOT NULL,
	PRIMARY KEY (day, hash)
);
CREATE INDEX active_day_version ON active (day, version);

-- Per network limits on new installs. The key is a hash of the IP address salted with the day and a
-- server secret, so the address itself is never stored and the hash means nothing the next day.
CREATE TABLE ip_limits (
	kind TEXT NOT NULL,
	period TEXT NOT NULL,
	hash TEXT NOT NULL,
	n INTEGER NOT NULL,
	PRIMARY KEY (kind, period, hash)
);
