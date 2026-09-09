-- When a photo last landed for this gallery.
--
-- The worker used to finish the moment it found files, which raced every upload
-- of more than one photo: the first file completed, the worker processed it and
-- marked the gallery ready, and every later file was ignored because the worker
-- only ever looked at galleries still marked preparing.
--
-- With this, the worker can tell "she has stopped uploading" from "the next file
-- is still on its way", and only finalises once things have been quiet.
ALTER TABLE galleries
  ADD COLUMN last_upload_at DATETIME NULL AFTER bytes_total;
