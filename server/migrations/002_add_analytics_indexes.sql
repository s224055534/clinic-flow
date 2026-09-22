CREATE INDEX IF NOT EXISTS appointments_starts_at_idx ON appointments (starts_at);
CREATE INDEX IF NOT EXISTS appointments_staff_starts_at_idx ON appointments (staff_id, starts_at);
