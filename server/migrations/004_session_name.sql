-- Renames galleries.client_name to session_name.
--
-- The column was called client_name because the field above it was "Imię
-- klienta". It has read "Sesja" for a while now: what she types is a session,
-- often a couple and sometimes "Chrzciny Zosi", and only sometimes anybody's
-- name. The code was renamed to match; this brings the column with it.
--
-- No data moves. CHANGE renames the column in place and the rows come along
-- untouched, so there is nothing to copy, verify or roll back.
--
-- The guard is here because the databases this has to run against are not in
-- the same state. 001 was rewritten in place to say session_name, so a database
-- created since then already has the new name and would fail on a bare rename,
-- while one created before it still has the old name and needs this. Asking
-- information_schema is what tells those two apart -- MySQL has no IF EXISTS
-- for CHANGE COLUMN (MariaDB's is an extension, and this file should not care
-- which of the two it is talking to).
SET @rename_client_name = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'galleries'
       AND COLUMN_NAME = 'client_name') > 0,
  'ALTER TABLE galleries CHANGE client_name session_name VARCHAR(120) NOT NULL',
  'SELECT 1');
PREPARE rename_client_name FROM @rename_client_name;
EXECUTE rename_client_name;
DEALLOCATE PREPARE rename_client_name;
