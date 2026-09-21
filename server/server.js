import { loadEnvFile } from "node:process";
import express from "express";
import pg from "pg";

loadEnvFile();

const { Pool } = pg;
const app = express();
const pool = new Pool();
const port = Number(process.env.PORT ?? 3000);
const receptionistStatuses = ['Scheduled', 'Arrived', 'Cancelled'];
const clinicianStatuses = ['In Consultation', 'Completed'];

app.use(express.json());

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function allowRoles(...allowedRoles) {
  return (req, res, next) => {
    const role = req.get('x-demo-role');
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ error: 'This demo role cannot perform that action.' });
    }
    next();
  };
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validWindow(startsAt, endsAt) {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

async function findOverlap(staffId, startsAt, endsAt, ignoredId = 0) {
  return pool.query(
    `SELECT id
     FROM appointments
     WHERE staff_id = $1
       AND id <> $4
       AND status <> 'Cancelled'
       AND tsrange(starts_at, ends_at, '[)') &&
           tsrange($2::timestamp, $3::timestamp, '[)')
     LIMIT 1`,
    [staffId, startsAt, endsAt, ignoredId],
  );
}

app.get(
  "/api/health",
  asyncRoute(async (_req, res) => {
    const result = await pool.query("SELECT 1 AS ok");
    res.json({ ok: result.rows[0].ok === 1 });
  }),
);

app.get(
  "/api/data",
  asyncRoute(async (req, res) => {
    const date = String(req.query.date ?? "");
    const search = `%${String(req.query.q ?? "").trim()}%`;

    if (!validDate(date)) {
      return res
        .status(400)
        .json({ error: "Use a date in YYYY-MM-DD format." });
    }

    const [patientsResult, staffResult, appointmentsResult] = await Promise.all(
      [
        pool.query(
          `SELECT id,
              full_name AS "fullName",
              phone,
              to_char(date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth"
       FROM patients
       ORDER BY full_name`,
        ),
        pool.query(
          `SELECT id, full_name AS "fullName"
       FROM staff
       WHERE role = 'Clinician'
       ORDER BY full_name`,
        ),
        pool.query(
          `SELECT a.id,
              a.patient_id AS "patientId",
              a.staff_id AS "staffId",
              p.full_name AS "patientName",
              p.phone,
              s.full_name AS "staffName",
              to_char(a.starts_at, 'YYYY-MM-DD"T"HH24:MI') AS "startsAt",
              to_char(a.ends_at, 'YYYY-MM-DD"T"HH24:MI') AS "endsAt",
              to_char(a.starts_at, 'HH24:MI') AS "startTime",
              to_char(a.ends_at, 'HH24:MI') AS "endTime",
              a.status,
              a.reason
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN staff s ON s.id = a.staff_id
       WHERE a.starts_at::date = $1::date
         AND (
           p.full_name ILIKE $2 OR
           p.phone ILIKE $2 OR
           s.full_name ILIKE $2 OR
           a.reason ILIKE $2
         )
       ORDER BY a.starts_at`,
          [date, search],
        ),
      ],
    );

    res.json({
      patients: patientsResult.rows,
      staff: staffResult.rows,
      appointments: appointmentsResult.rows,
    });
  }),
);

app.post('/api/patients', allowRoles('Receptionist'), asyncRoute(async (req, res) => {
  const fullName = String(req.body.fullName ?? '').trim();
  const phone = String(req.body.phone ?? '').trim();
  const dateOfBirth = String(req.body.dateOfBirth ?? '');

  if (!fullName || !phone || !validDate(dateOfBirth)) {
    return res.status(400).json({ error: 'Name, phone, and date of birth are required.' });
  }

  const existing = await pool.query('SELECT id FROM patients WHERE phone = $1', [phone]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'A fictional patient already uses that phone number.' });
  }

  const result = await pool.query(
    `INSERT INTO patients (full_name, phone, date_of_birth)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [fullName, phone, dateOfBirth],
  );

  res.status(201).json(result.rows[0]);
}));

app.post('/api/appointments', allowRoles('Receptionist'), asyncRoute(async (req, res) => {
  const patientId = Number(req.body.patientId);
  const staffId = Number(req.body.staffId);
  const startsAt = String(req.body.startsAt ?? '');
  const endsAt = String(req.body.endsAt ?? '');
  const reason = String(req.body.reason ?? '').trim();

  if (!patientId || !staffId || !reason || !validWindow(startsAt, endsAt)) {
    return res.status(400).json({ error: 'Complete every booking field with a valid time range.' });
  }

  const overlap = await findOverlap(staffId, startsAt, endsAt);
  if (overlap.rows.length) {
    return res.status(409).json({ error: 'That clinician already has an overlapping appointment.' });
  }
    const result = await pool.query(
    `INSERT INTO appointments
       (patient_id, staff_id, starts_at, ends_at, status, reason)
     VALUES ($1, $2, $3, $4, 'Scheduled', $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [patientId, staffId, startsAt, endsAt, reason],
  );

  if (!result.rows.length) {
    return res.status(409).json({ error: 'That clinician already has an overlapping appointment.' });
  }

  res.status(201).json(result.rows[0]);
}));

app.patch(
  '/api/appointments/:id/status',
  allowRoles('Receptionist', 'Clinician'),
  asyncRoute(async (req, res) => {
    const role = req.get('x-demo-role');
    const status = String(req.body.status ?? '');
    const allowedStatuses = role === 'Receptionist'
      ? receptionistStatuses
      : clinicianStatuses;

    if (!allowedStatuses.includes(status)) {
      return res.status(403).json({ error: `${role} cannot set status to ${status}.` });
    }

    const result = await pool.query(
      `UPDATE appointments
       SET status = $1
       WHERE id = $2
       RETURNING id`,
      [status, Number(req.params.id)],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }

    res.json(result.rows[0]);
  }),
);

app.patch(
  '/api/appointments/:id/reschedule',
  allowRoles('Receptionist'),
  asyncRoute(async (req, res) => {
    const appointmentId = Number(req.params.id);
    const staffId = Number(req.body.staffId);
    const startsAt = String(req.body.startsAt ?? '');
    const endsAt = String(req.body.endsAt ?? '');

    if (!appointmentId || !staffId || !validWindow(startsAt, endsAt)) {
      return res.status(400).json({ error: 'Choose a valid clinician and time range.' });
    }

    const overlap = await findOverlap(staffId, startsAt, endsAt, appointmentId);
    if (overlap.rows.length) {
      return res.status(409).json({ error: 'That clinician already has an overlapping appointment.' });
    }
        try {
      const result = await pool.query(
        `UPDATE appointments
         SET staff_id = $1,
             starts_at = $2,
             ends_at = $3,
             status = 'Scheduled'
         WHERE id = $4
         RETURNING id`,
        [staffId, startsAt, endsAt, appointmentId],
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Appointment not found.' });
      }

      res.json(result.rows[0]);
    } catch {
      res.status(409).json({ error: 'The database rejected that overlapping time range.' });
    }
  }),
);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`ClinicFlow API running at http://localhost:${port}`);
});