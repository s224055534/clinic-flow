import { createServer } from "node:http";
import express from "express";
import pg from "pg";
import { Server } from "socket.io";
import cors from "cors";

const { Pool } = pg;
const app = express();
app.use(cors({
  origin: ["https://clinic-flow-1.onrender.com"],
  methods: ["GET", "POST", "PATCH"],
  credentials: true,
}));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ["https://clinic-flow-1.onrender.com"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});
const port = Number(process.env.PORT ?? 3000);
const receptionistStatuses = ["Scheduled", "Arrived", "Cancelled"];
const clinicianStatuses = ["In Consultation", "Completed"];

app.use(express.json());

function emitToOtherClients(req, event, payload) {
  const socketId = req.get("x-socket-id");
  const broadcaster = socketId ? io.except(socketId) : io;
  broadcaster.emit(event, payload);
}

io.on("connection", (socket) => {
  console.log(`ClinicFlow client connected: ${socket.id}`);
});

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function allowRoles(...allowedRoles) {
  return (req, res, next) => {
    const role = req.get("x-demo-role");
    if (!allowedRoles.includes(role)) {
      return res
        .status(403)
        .json({ error: "This demo role cannot perform that action." });
    }
    next();
  };
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validCalendarDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    validDate(value) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function analyticsFilters(req) {
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  const staffIdValue = String(req.query.staffId ?? "");
  const staffId = staffIdValue ? Number(staffIdValue) : null;

  if (!validCalendarDate(from) || !validCalendarDate(to) || from > to) {
    throw requestError(400, "Use a valid date range in YYYY-MM-DD format.");
  }
  if (staffIdValue && (!Number.isInteger(staffId) || staffId < 1)) {
    throw requestError(400, "Use a valid clinician ID.");
  }

  return [from, to, staffId];
}

function validWindow(startsAt, endsAt) {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function withActorTransaction(role, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_role', $1, true)", [role]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function findOverlap(db, staffId, startsAt, endsAt, ignoredId = 0) {
  return db.query(
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
  '/api/health',
  asyncRoute(async (_req, res) => {
    const result = await pool.query("SELECT 1 AS ok");
    res.json({ ok: result.rows[0].ok === 1 });
  }),
);

app.get(
  '/api/data',
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

app.get(
  '/api/appointments/:id/audit-logs',
  allowRoles("Receptionist", "Clinician"),
  asyncRoute(async (req, res) => {
    const appointmentId = Number(req.params.id);
    if (!appointmentId) {
      return res.status(400).json({ error: "Use a valid appointment ID." });
    }

    const result = await pool.query(
      `SELECT a.id,
              a.action_type AS "actionType",
              a.entity_type AS "entityType",
              a.entity_id AS "entityId",
              a.old_values AS "oldValues",
              a.new_values AS "newValues",
              a.actor_role AS "actorRole",
              a.created_at AS "createdAt",
              old_patient.full_name AS "oldPatientName",
              new_patient.full_name AS "newPatientName",
              old_staff.full_name AS "oldStaffName",
              new_staff.full_name AS "newStaffName"
       FROM audit_logs a
       LEFT JOIN patients old_patient
         ON old_patient.id = (a.old_values ->> 'patientId')::integer
       LEFT JOIN patients new_patient
         ON new_patient.id = (a.new_values ->> 'patientId')::integer
       LEFT JOIN staff old_staff
         ON old_staff.id = (a.old_values ->> 'staffId')::integer
       LEFT JOIN staff new_staff
         ON new_staff.id = (a.new_values ->> 'staffId')::integer
       WHERE a.entity_type = 'appointment' AND a.entity_id = $1
       ORDER BY a.created_at DESC, a.id DESC`,
      [appointmentId],
    );

    res.json(result.rows);
  }),
);

app.get(
  '/api/analytics/summary',
  allowRoles("Receptionist", "Clinician"),
  asyncRoute(async (req, res) => {
    const filters = analyticsFilters(req);
    const result = await pool.query(
      `WITH filtered AS (
         SELECT starts_at::date AS appointment_date,
                status,
                EXTRACT(EPOCH FROM (ends_at - starts_at)) / 3600 AS booked_hours
         FROM appointments
         WHERE starts_at >= $1::date
           AND starts_at < ($2::date + INTERVAL '1 day')
           AND ($3::integer IS NULL OR staff_id = $3)
       ), daily AS (
         SELECT appointment_date, COUNT(*)::integer AS appointment_count
         FROM filtered
         GROUP BY appointment_date
       )
       SELECT COUNT(*)::integer AS "totalAppointments",
              COUNT(*) FILTER (WHERE status = 'Cancelled')::integer AS "cancelledAppointments",
              COALESCE(ROUND(
                100.0 * COUNT(*) FILTER (WHERE status = 'Cancelled') / NULLIF(COUNT(*), 0),
                1
              ), 0) AS "cancellationRate",
              COALESCE(ROUND(
                (SUM(booked_hours) FILTER (WHERE status <> 'Cancelled'))::numeric,
                1
              ), 0) AS "bookedHours",
              COALESCE((
                SELECT json_build_object(
                  'date', to_char(appointment_date, 'YYYY-MM-DD'),
                  'count', appointment_count
                )
                FROM daily
                ORDER BY appointment_count DESC, appointment_date ASC
                LIMIT 1
              ), json_build_object('date', NULL, 'count', 0)) AS "busiestDay"
       FROM filtered`,
      filters,
    );
    res.json(result.rows[0]);
  }),
);

app.get(
  '/api/analytics/trends',
  allowRoles("Receptionist", "Clinician"),
  asyncRoute(async (req, res) => {
    const filters = analyticsFilters(req);
    const [daily, weekly, monthly, cancellations] = await Promise.all([
      pool.query(
        `SELECT to_char(starts_at::date, 'YYYY-MM-DD') AS label, COUNT(*)::integer AS count
         FROM appointments
         WHERE starts_at >= $1::date
           AND starts_at < ($2::date + INTERVAL '1 day')
           AND ($3::integer IS NULL OR staff_id = $3)
         GROUP BY starts_at::date
         ORDER BY starts_at::date`,
        filters,
      ),
      pool.query(
        `SELECT to_char(date_trunc('week', starts_at), 'IYYY-"W"IW') AS label,
                COUNT(*)::integer AS count
         FROM appointments
         WHERE starts_at >= $1::date
           AND starts_at < ($2::date + INTERVAL '1 day')
           AND ($3::integer IS NULL OR staff_id = $3)
         GROUP BY date_trunc('week', starts_at)
         ORDER BY date_trunc('week', starts_at)`,
        filters,
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', starts_at), 'YYYY-MM') AS label,
                COUNT(*)::integer AS count
         FROM appointments
         WHERE starts_at >= $1::date
           AND starts_at < ($2::date + INTERVAL '1 day')
           AND ($3::integer IS NULL OR staff_id = $3)
         GROUP BY date_trunc('month', starts_at)
         ORDER BY date_trunc('month', starts_at)`,
        filters,
      ),
      pool.query(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS label, COUNT(*)::integer AS count
         FROM audit_logs
         WHERE action_type = 'appointment.cancelled'
           AND created_at >= $1::date
           AND created_at < ($2::date + INTERVAL '1 day')
           AND ($3::integer IS NULL OR (new_values ->> 'staffId')::integer = $3)
         GROUP BY created_at::date
         ORDER BY created_at::date`,
        filters,
      ),
    ]);

    res.json({
      daily: daily.rows,
      weekly: weekly.rows,
      monthly: monthly.rows,
      cancellations: cancellations.rows,
    });
  }),
);

app.get(
  '/api/analytics/clinicians',
  allowRoles("Receptionist", "Clinician"),
  asyncRoute(async (req, res) => {
    const filters = analyticsFilters(req);
    const result = await pool.query(
      `WITH clinician_metrics AS (
         SELECT s.id,
                s.full_name AS "fullName",
                COUNT(a.id) FILTER (WHERE a.status <> 'Cancelled')::integer AS "appointmentCount",
                COALESCE(ROUND((SUM(
                  EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 3600
                ) FILTER (WHERE a.status <> 'Cancelled'))::numeric, 1), 0) AS "bookedHours"
         FROM staff s
         LEFT JOIN appointments a
           ON a.staff_id = s.id
          AND a.starts_at >= $1::date
          AND a.starts_at < ($2::date + INTERVAL '1 day')
         WHERE s.role = 'Clinician'
           AND ($3::integer IS NULL OR s.id = $3)
         GROUP BY s.id, s.full_name
       )
       SELECT *, COALESCE(ROUND(
         100.0 * "appointmentCount" / NULLIF(SUM("appointmentCount") OVER (), 0),
         1
       ), 0) AS "workloadPercentage"
       FROM clinician_metrics
       ORDER BY "appointmentCount" DESC, "fullName"`,
      filters,
    );
    res.json(result.rows);
  }),
);

app.get(
  '/api/analytics/status-distribution',
  allowRoles("Receptionist", "Clinician"),
  asyncRoute(async (req, res) => {
    const filters = analyticsFilters(req);
    const result = await pool.query(
      `SELECT status AS label, COUNT(*)::integer AS count
       FROM appointments
       WHERE starts_at >= $1::date
         AND starts_at < ($2::date + INTERVAL '1 day')
         AND ($3::integer IS NULL OR staff_id = $3)
       GROUP BY status
       ORDER BY CASE status
         WHEN 'Scheduled' THEN 1
         WHEN 'Arrived' THEN 2
         WHEN 'In Consultation' THEN 3
         WHEN 'Completed' THEN 4
         WHEN 'Cancelled' THEN 5
       END`,
      filters,
    );
    res.json(result.rows);
  }),
);

app.post(
  '/api/patients',
  allowRoles("Receptionist"),
  asyncRoute(async (req, res) => {
    const fullName = String(req.body.fullName ?? "").trim();
    const phone = String(req.body.phone ?? "").trim();
    const dateOfBirth = String(req.body.dateOfBirth ?? "");

    if (!fullName || !phone || !validDate(dateOfBirth)) {
      return res
        .status(400)
        .json({ error: "Name, phone, and date of birth are required." });
    }

    const patient = await withActorTransaction(
      req.get("x-demo-role"),
      async (client) => {
        const existing = await client.query(
          "SELECT id FROM patients WHERE phone = $1",
          [phone],
        );
        if (existing.rows.length) {
          throw requestError(
            409,
            "A fictional patient already uses that phone number.",
          );
        }

        const result = await client.query(
          `INSERT INTO patients (full_name, phone, date_of_birth)
       VALUES ($1, $2, $3)
       RETURNING id`,
          [fullName, phone, dateOfBirth],
        );
        return result.rows[0];
      },
    );

    emitToOtherClients(req, "patient:created", { patientId: patient.id });
    res.status(201).json(patient);
  }),
);

app.post(
  '/api/appointments',
  allowRoles("Receptionist"),
  asyncRoute(async (req, res) => {
    const patientId = Number(req.body.patientId);
    const staffId = Number(req.body.staffId);
    const startsAt = String(req.body.startsAt ?? "");
    const endsAt = String(req.body.endsAt ?? "");
    const reason = String(req.body.reason ?? "").trim();

    if (!patientId || !staffId || !reason || !validWindow(startsAt, endsAt)) {
      return res
        .status(400)
        .json({
          error: "Complete every booking field with a valid time range.",
        });
    }

    const appointment = await withActorTransaction(
      req.get("x-demo-role"),
      async (client) => {
        const overlap = await findOverlap(client, staffId, startsAt, endsAt);
        if (overlap.rows.length) {
          throw requestError(
            409,
            "That clinician already has an overlapping appointment.",
          );
        }

        const result = await client.query(
          `INSERT INTO appointments
         (patient_id, staff_id, starts_at, ends_at, status, reason)
       VALUES ($1, $2, $3, $4, 'Scheduled', $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
          [patientId, staffId, startsAt, endsAt, reason],
        );

        if (!result.rows.length) {
          throw requestError(
            409,
            "That clinician already has an overlapping appointment.",
          );
        }
        return result.rows[0];
      },
    );

    emitToOtherClients(req, "appointment:created", {
      appointmentId: appointment.id,
      affectedDates: [startsAt.slice(0, 10)],
    });
    res.status(201).json(appointment);
  }),
);

app.patch(
  '/api/appointments/:id/status',
  allowRoles("Receptionist", "Clinician"),
  asyncRoute(async (req, res) => {
    const role = req.get("x-demo-role");
    const status = String(req.body.status ?? "");
    const allowedStatuses =
      role === "Receptionist" ? receptionistStatuses : clinicianStatuses;

    if (!allowedStatuses.includes(status)) {
      return res
        .status(403)
        .json({ error: `${role} cannot set status to ${status}.` });
    }

    const appointment = await withActorTransaction(role, async (client) => {
      const result = await client.query(
        `UPDATE appointments
         SET status = $1
         WHERE id = $2
         RETURNING id,
                   to_char(starts_at, 'YYYY-MM-DD') AS "date"`,
        [status, Number(req.params.id)],
      );

      if (!result.rows.length) {
        throw requestError(404, "Appointment not found.");
      }
      return result.rows[0];
    });
    const event =
      status === "Cancelled"
        ? "appointment:cancelled"
        : "appointment:status-changed";
    emitToOtherClients(req, event, {
      appointmentId: appointment.id,
      status,
      affectedDates: [appointment.date],
    });
    res.json({ id: appointment.id });
  }),
);

app.patch(
  '/api/appointments/:id/reschedule',
  allowRoles("Receptionist"),
  asyncRoute(async (req, res) => {
    const appointmentId = Number(req.params.id);
    const staffId = Number(req.body.staffId);
    const startsAt = String(req.body.startsAt ?? "");
    const endsAt = String(req.body.endsAt ?? "");

    if (!appointmentId || !staffId || !validWindow(startsAt, endsAt)) {
      return res
        .status(400)
        .json({ error: "Choose a valid clinician and time range." });
    }

    const { appointment, previousDate } = await withActorTransaction(
      req.get("x-demo-role"),
      async (client) => {
        const existingAppointment = await client.query(
          `SELECT to_char(starts_at, 'YYYY-MM-DD') AS "date"
           FROM appointments
           WHERE id = $1`,
          [appointmentId],
        );

        if (!existingAppointment.rows.length) {
          throw requestError(404, "Appointment not found.");
        }

        const overlap = await findOverlap(
          client,
          staffId,
          startsAt,
          endsAt,
          appointmentId,
        );
        if (overlap.rows.length) {
          throw requestError(
            409,
            "That clinician already has an overlapping appointment.",
          );
        }

        const result = await client.query(
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
          throw requestError(404, "Appointment not found.");
        }

        return {
          appointment: result.rows[0],
          previousDate: existingAppointment.rows[0].date,
        };
      },
    );

    emitToOtherClients(req, "appointment:rescheduled", {
      appointmentId: appointment.id,
      affectedDates: [...new Set([previousDate, startsAt.slice(0, 10)])],
    });
    res.json(appointment);
  }),
);

app.use((error, _req, res, _next) => {
  if (error.status) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error.code === "23P01") {
    return res
      .status(409)
      .json({ error: "The database rejected that overlapping time range." });
  }
  console.error(error);
  res.status(500).json({ error: "Unexpected server error." });
});

httpServer.listen(port, () => {
  console.log(`ClinicFlow API running at http://localhost:${port}`);
});
