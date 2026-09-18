CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS staff;
DROP TABLE IF EXISTS patients;

CREATE TABLE patients (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  full_name text NOT NULL,
  phone text NOT NULL UNIQUE,
  date_of_birth date NOT NULL
);

CREATE TABLE staff (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role = 'Clinician')
);

CREATE TABLE appointments (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  patient_id integer NOT NULL REFERENCES patients(id),
  staff_id integer NOT NULL REFERENCES staff(id),
  starts_at timestamp NOT NULL,
  ends_at timestamp NOT NULL,
  status text NOT NULL DEFAULT 'Scheduled'
    CHECK (status IN ('Scheduled', 'Arrived', 'In Consultation', 'Completed', 'Cancelled')),
  reason text NOT NULL,
  CHECK (ends_at > starts_at),
  CONSTRAINT no_staff_overlap EXCLUDE USING gist (
    staff_id WITH =,
    tsrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status <> 'Cancelled')
);

INSERT INTO patients (full_name, phone, date_of_birth) VALUES
  ('Maya Chen', '555-0101', '1992-04-14'),
  ('Omar Rivera', '555-0102', '1985-11-03'),
  ('Priya Nair', '555-0103', '2001-07-22');

INSERT INTO staff (full_name, role) VALUES
  ('Dr. Lena Ortiz', 'Clinician'),
  ('Dr. Noah Williams', 'Clinician');

INSERT INTO appointments (patient_id, staff_id, starts_at, ends_at, status, reason)
SELECT p.id, s.id, '2026-09-16 09:00', '2026-09-16 09:30', 'Scheduled', 'Routine consultation'
FROM patients p, staff s
WHERE p.full_name = 'Maya Chen' AND s.full_name = 'Dr. Lena Ortiz';

INSERT INTO appointments (patient_id, staff_id, starts_at, ends_at, status, reason)
SELECT p.id, s.id, '2026-09-16 10:00', '2026-09-16 10:30', 'Arrived', 'Follow-up visit'
FROM patients p, staff s
WHERE p.full_name = 'Omar Rivera' AND s.full_name = 'Dr. Noah Williams';