CREATE TABLE IF NOT EXISTS audit_logs (
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

CREATE INDEX IF NOT EXISTS audit_logs_entity_timeline_idx
  ON audit_logs (entity_type, entity_id, created_at DESC);

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
    'patient.created', 'patient', NEW.id, NULL,
    jsonb_build_object('fullName', NEW.full_name, 'phone', NEW.phone, 'dateOfBirth', NEW.date_of_birth),
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
    'patientId', NEW.patient_id, 'staffId', NEW.staff_id,
    'startsAt', to_char(NEW.starts_at, 'YYYY-MM-DD"T"HH24:MI'),
    'endsAt', to_char(NEW.ends_at, 'YYYY-MM-DD"T"HH24:MI'),
    'status', NEW.status, 'reason', NEW.reason
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
    'patientId', OLD.patient_id, 'staffId', OLD.staff_id,
    'startsAt', to_char(OLD.starts_at, 'YYYY-MM-DD"T"HH24:MI'),
    'endsAt', to_char(OLD.ends_at, 'YYYY-MM-DD"T"HH24:MI'),
    'status', OLD.status, 'reason', OLD.reason
  );

  INSERT INTO audit_logs (action_type, entity_type, entity_id, old_values, new_values, actor_role)
  VALUES (action, 'appointment', NEW.id, old_snapshot, new_snapshot, audit_actor_role());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patients_audit_insert ON patients;
CREATE TRIGGER patients_audit_insert
AFTER INSERT ON patients
FOR EACH ROW EXECUTE FUNCTION audit_patient_change();

DROP TRIGGER IF EXISTS appointments_audit_change ON appointments;
CREATE TRIGGER appointments_audit_change
AFTER INSERT OR UPDATE ON appointments
FOR EACH ROW EXECUTE FUNCTION audit_appointment_change();
