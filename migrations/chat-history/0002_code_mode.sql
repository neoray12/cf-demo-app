-- Code Mode comparison: which runs used Code Mode and which experiment they belong to.
ALTER TABLE turns ADD COLUMN code_mode INTEGER;
ALTER TABLE turns ADD COLUMN experiment TEXT;
