-- 0006_target_headers.sql — optional encrypted per-check request headers.

ALTER TABLE checks ADD COLUMN target_headers TEXT;
