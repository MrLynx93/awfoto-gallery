-- Renames galleries.shoot_date to session_date, matching session_name.
--
-- Same shape as 004: no data moves, CHANGE renames the column under the rows
-- it already has. And the same guard, for the same reason -- 001 was rewritten
-- in place to say session_date, so a database created since then already has
-- the new name and would fail on a bare rename, while one created before it
-- still has the old name and needs this.
SET @rename_shoot_date = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'galleries'
       AND COLUMN_NAME = 'shoot_date') > 0,
  'ALTER TABLE galleries CHANGE shoot_date session_date DATE NULL',
  'SELECT 1');
PREPARE rename_shoot_date FROM @rename_shoot_date;
EXECUTE rename_shoot_date;
DEALLOCATE PREPARE rename_shoot_date;
