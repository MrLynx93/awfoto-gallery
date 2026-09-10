-- The gallery password, kept in a form the panel can read back.
--
-- Until now only the scrypt hash was stored, so a password existed for exactly
-- one screen: created, shown once, and after that unrecoverable. Reopening the
-- panel a day later left her with a gallery she could not tell the client how
-- to open, and the only remedy on offer was issuing a new password -- which
-- silently breaks the code she already sent.
--
-- password_hash stays the authority for the client's attempt at the gate. This
-- column is display only: AES-256-GCM under a key derived from SESSION_SECRET,
-- so a database dump without .env reveals nothing, and a rotated secret costs
-- the display of old passwords rather than access to any gallery. See
-- server/passwords.js, seal()/unseal(). NULL for every gallery created before
-- this migration -- those keep the old "set a new password" path.
ALTER TABLE galleries
  ADD COLUMN password_enc VARCHAR(255) NULL AFTER password_hash;
