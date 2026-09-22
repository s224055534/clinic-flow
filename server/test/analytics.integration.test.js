import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { after, before, test } from 'node:test';
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

before(async () => {
  if (!pool) return;
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
});

after(async () => {
  await pool?.end();
});

test('computes appointment volume, utilization, and status distribution from stored appointments', { skip }, async () => {
  const daily = await pool.query(
    `SELECT to_char(starts_at::date, 'YYYY-MM-DD') AS label, COUNT(*)::integer AS count
     FROM appointments
     WHERE starts_at >= '2026-09-01'::date AND starts_at < '2026-10-01'::date
     GROUP BY starts_at::date`,
  );
  assert.deepEqual(daily.rows, [{ label: '2026-09-16', count: 2 }]);

  const utilization = await pool.query(
    `SELECT s.full_name AS "fullName",
            COUNT(a.id) FILTER (WHERE a.status <> 'Cancelled')::integer AS "appointmentCount",
            COALESCE(ROUND((SUM(EXTRACT(EPOCH FROM a.ends_at - a.starts_at) / 3600)
              FILTER (WHERE a.status <> 'Cancelled'))::numeric, 1), 0) AS "bookedHours"
     FROM staff s
     LEFT JOIN appointments a ON a.staff_id = s.id
     GROUP BY s.id, s.full_name
     ORDER BY s.full_name`,
  );
  assert.deepEqual(utilization.rows, [
    { fullName: 'Dr. Lena Ortiz', appointmentCount: 1, bookedHours: '0.5' },
    { fullName: 'Dr. Noah Williams', appointmentCount: 1, bookedHours: '0.5' },
  ]);

  const statuses = await pool.query(
    `SELECT status AS label, COUNT(*)::integer AS count
     FROM appointments
     GROUP BY status
     ORDER BY status`,
  );
  assert.deepEqual(statuses.rows, [
    { label: 'Arrived', count: 1 },
    { label: 'Scheduled', count: 1 },
  ]);
});

test('records cancellation trends from audit events', { skip }, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_role', 'Receptionist', true)");
    await client.query("UPDATE appointments SET status = 'Cancelled' WHERE id = 1");
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const cancellations = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM audit_logs
     WHERE action_type = 'appointment.cancelled'`,
  );
  assert.equal(cancellations.rows[0].count, 1);
});
