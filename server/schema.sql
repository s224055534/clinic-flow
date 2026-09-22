CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP TABLE IF EXISTS audit_logs;
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

CREATE TABLE audit_logs (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  action_type text NOT NULL CHECK (action_type IN (
    'appointment.created',
    'appointment.status_changed',
    'appointment.cancelled',
    'appointment.rescheduled',
    'patient.created'
  )),
  entity_type text NOT NULL CHECK (entity_type IN ('appointment', 'patient')),
  entity_id integer NOT NULL,
  old_values jsonb,
  new_values jsonb,
  actor_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_logs_entity_timeline_idx
  ON audit_logs (entity_type, entity_id, created_at DESC);

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

CREATE INDEX appointments_starts_at_idx ON appointments (starts_at);
CREATE INDEX appointments_staff_starts_at_idx ON appointments (staff_id, starts_at);

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

CREATE OR REPLACE FUNCTION audit_actor_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_role', true), ''), 'System')
$$;

CREATE OR REPLACE FUNCTION audit_patient_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_logs (action_type, entity_type, entity_id, old_values, new_values, actor_role)
  VALUES (
    'patient.created',
    'patient',
    NEW.id,
    NULL,
    jsonb_build_object(
      'fullName', NEW.full_name,
      'phone', NEW.phone,
      'dateOfBirth', NEW.date_of_birth
    ),
    audit_actor_role()
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION audit_appointment_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action text;
  old_snapshot jsonb;
  new_snapshot jsonb;
BEGIN
  new_snapshot := jsonb_build_object(
    'patientId', NEW.patient_id,
    'staffId', NEW.staff_id,
    'startsAt', to_char(NEW.starts_at, 'YYYY-MM-DD"T"HH24:MI'),
    'endsAt', to_char(NEW.ends_at, 'YYYY-MM-DD"T"HH24:MI'),
    'status', NEW.status,
    'reason', NEW.reason
  );

  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (action_type, entity_type, entity_id, old_values, new_values, actor_role)
    VALUES ('appointment.created', 'appointment', NEW.id, NULL, new_snapshot, audit_actor_role());
    RETURN NEW;
  END IF;

  IF NEW.staff_id IS DISTINCT FROM OLD.staff_id
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    action := 'appointment.rescheduled';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    action := CASE WHEN NEW.status = 'Cancelled'
      THEN 'appointment.cancelled'
      ELSE 'appointment.status_changed'
    END;
  ELSE
    RETURN NEW;
  END IF;

  old_snapshot := jsonb_build_object(
    'patientId', OLD.patient_id,
    'staffId', OLD.staff_id,
    'startsAt', to_char(OLD.starts_at, 'YYYY-MM-DD"T"HH24:MI'),
    'endsAt', to_char(OLD.ends_at, 'YYYY-MM-DD"T"HH24:MI'),
    'status', OLD.status,
    'reason', OLD.reason
  );

  INSERT INTO audit_logs (action_type, entity_type, entity_id, old_values, new_values, actor_role)
  VALUES (action, 'appointment', NEW.id, old_snapshot, new_snapshot, audit_actor_role());
  RETURN NEW;
END;
$$;

CREATE TRIGGER patients_audit_insert
AFTER INSERT ON patients
FOR EACH ROW EXECUTE FUNCTION audit_patient_change();

CREATE TRIGGER appointments_audit_change
AFTER INSERT OR UPDATE ON appointments
FOR EACH ROW EXECUTE FUNCTION audit_appointment_change();
