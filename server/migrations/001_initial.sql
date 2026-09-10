-- The whole schema. Three tables, and none of them is a photo table by
-- accident: per-photo detail lives in the gallery's manifest.json, written once
-- by the worker and read once per page. The database is the index -- which
-- galleries exist, who may open one, when it dies -- and that is all.

CREATE TABLE galleries (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- The public URL segment, and also the directory name under STORAGE_ROOT,
  -- which is why server/storage.js insists on this character set.
  slug          VARCHAR(24)  NOT NULL,
  -- What she calls the session: often a couple, sometimes "Chrzciny Zosi".
  -- The client's name only when that is what the session is.
  session_name  VARCHAR(120) NOT NULL,
  shoot_date    DATE         NULL,
  password_hash VARCHAR(255) NOT NULL,
  status        ENUM('preparing', 'ready', 'failed', 'zip_unavailable')
                NOT NULL DEFAULT 'preparing',
  photo_count   INT UNSIGNED NOT NULL DEFAULT 0,
  -- Originals plus derivatives plus archive. Summed across live galleries to
  -- enforce DISK_BUDGET_GB, because df reports the shared pool and never the
  -- account's quota.
  bytes_total   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at    DATETIME     NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at    DATETIME     NULL,
  UNIQUE KEY uniq_slug (slug),
  -- The nightly sweep asks one question: what is past its expiry and not yet
  -- deleted. This index is that question.
  KEY idx_expiry (deleted_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Failed password attempts, in the database rather than in memory because
-- Passenger runs several processes: a per-process counter would let anyone
-- reconnect their way around it.
CREATE TABLE access_attempts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- Which gallery was being guessed at. Not a foreign key: attempts against a
  -- slug that does not exist are exactly what a scan looks like, and those are
  -- worth counting too.
  slug        VARCHAR(24) NOT NULL,
  -- A truncated HMAC of the address, never the address itself. Enough to count
  -- repeats from one source; not a record of who visited which gallery, which
  -- is not something this application has any reason to keep.
  ip_hash     CHAR(32)    NOT NULL,
  attempted_at DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_recent (slug, ip_hash, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
