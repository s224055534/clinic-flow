import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { before, after, test } from 'node:test';
import pg from 'pg';

loadEnvFile();

const { Pool } = pg;
const database = process.env.TEST_PGDATABASE;
const skip = !database;
const pool = database
  ? new Pool({
      host: process.env.TEST_PGHOST ?? process.env.PGHOST,
      port: Number(process.env.TEST_PGPORT ?? process.env.PGPORT ?? 5432),
      user: process.env.TEST_PGUSER ?? process.env.PGUSER,
      password: process.env.TEST_PGPASSWORD ?? process.env.PGPASSWORD,
      database,
    })
  : null;

async function asRole(role, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_role', $1, true)", [role]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function latestAudit(entityType, entityId) {
  const result = await pool.query(
    `SELECT action_type, old_values, new_values, actor_role
     FROM audit_logs
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY id DESC
     LIMIT 1`,
    [entityType, entityId],
  );
  return result.rows[0];
}

before(async () => {
  if (!pool) return;
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
});

after(async () => {
  await pool?.end();
});

test('records an appointment creation with a structured snapshot and actor role', { skip }, async () => {
  const appointmentId = await asRole('Receptionist', async (client) => {
    const result = await client.query(
      `INSERT INTO appointments (patient_id, staff_id, starts_at, ends_at, reason)
       VALUES (1, 1, '2026-09-16 11:00', '2026-09-16 11:30', 'Audit test')
       RETURNING id`,
    );
    return result.rows[0].id;
  });

  const audit = await latestAudit('appointment', appointmentId);
  assert.equal(audit.action_type, 'appointment.created');
  assert.equal(audit.actor_role, 'Receptionist');
  assert.equal(audit.old_values, null);
  assert.deepEqual(audit.new_values, {
    patientId: 1,
    staffId: 1,
    startsAt: '2026-09-16T11:00',
    endsAt: '2026-09-16T11:30',
    status: 'Scheduled',
    reason: 'Audit test',
  });
});

test('distinguishes status changes, cancellations, and reschedules', { skip }, async () => {
  await asRole('Clinician', (client) =>
    client.query("UPDATE appointments SET status = 'In Consultation' WHERE id = 2"),
  );
  let audit = await latestAudit('appointment', 2);
  assert.equal(audit.action_type, 'appointment.status_changed');
  assert.equal(audit.actor_role, 'Clinician');
  assert.equal(audit.old_values.status, 'Arrived');
  assert.equal(audit.new_values.status, 'In Consultation');

  await asRole('Receptionist', (client) =>
    client.query("UPDATE appointments SET status = 'Cancelled' WHERE id = 2"),
  );
  audit = await latestAudit('appointment', 2);
  assert.equal(audit.action_type, 'appointment.cancelled');
  assert.equal(audit.new_values.status, 'Cancelled');

  await asRole('Receptionist', (client) =>
    client.query(
      `UPDATE appointments
       SET starts_at = '2026-09-16 12:00', ends_at = '2026-09-16 12:30', status = 'Scheduled'
       WHERE id = 2`,
    ),
  );
  audit = await latestAudit('appointment', 2);
  assert.equal(audit.action_type, 'appointment.rescheduled');
  assert.equal(audit.old_values.startsAt, '2026-09-16T10:00');
  assert.equal(audit.new_values.startsAt, '2026-09-16T12:00');
});

test('records patient creation with a structured snapshot', { skip }, async () => {
  const patientId = await asRole('Receptionist', async (client) => {
    const result = await client.query(
      `INSERT INTO patients (full_name, phone, date_of_birth)
       VALUES ('Audit Patient', '555-0199', '1990-01-01')
       RETURNING id`,
    );
    return result.rows[0].id;
  });

  const audit = await latestAudit('patient', patientId);
  assert.equal(audit.action_type, 'patient.created');
  assert.equal(audit.actor_role, 'Receptionist');
  assert.deepEqual(audit.new_values, {
    fullName: 'Audit Patient',
    phone: '555-0199',
    dateOfBirth: '1990-01-01',
  });
});
