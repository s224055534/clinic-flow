import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "./socket.js";

// Keep the demonstration fixed to one fictional clinic day
const DEMO_DATE = "2026-09-16";
const emptyPatient = { fullName: "", phone: "", dateOfBirth: "" };
const emptyBooking = {
  patientId: "",
  staffId: "",
  startsAt: `${DEMO_DATE}T09:00`,
  endsAt: `${DEMO_DATE}T09:30`,
  reason: "",
};
const auditActionLabels = {
  "appointment.created": "Appointment created",
  "appointment.status_changed": "Status changed",
  "appointment.cancelled": "Appointment cancelled",
  "appointment.rescheduled": "Appointment rescheduled",
};

function formatTimeRange(snapshot) {
  if (!snapshot?.startsAt || !snapshot?.endsAt) return "an unknown time";
  return `${snapshot.startsAt.slice(11)}–${snapshot.endsAt.slice(11)}`;
}

function describeAuditEvent(log) {
  const oldValues = log.oldValues;
  const newValues = log.newValues;
  const oldPatient = log.oldPatientName || "Unknown patient";
  const newPatient = log.newPatientName || oldPatient;
  const oldStaff = log.oldStaffName || "Unknown clinician";
  const newStaff = log.newStaffName || oldStaff;

  switch (log.actionType) {
    case "appointment.created":
      return `Appointment booked for ${newPatient} with ${newStaff} (${formatTimeRange(newValues)}).`;
    case "appointment.rescheduled":
      return `Appointment rescheduled from ${oldStaff} (${formatTimeRange(oldValues)}) to ${newStaff} (${formatTimeRange(newValues)}).`;
    case "appointment.status_changed":
      return `Appointment status changed from ${oldValues?.status || "Unknown"} to ${newValues?.status || "Unknown"}.`;
    case "appointment.cancelled":
      return `Appointment for ${newPatient} with ${newStaff} was cancelled.`;
    default:
      return auditActionLabels[log.actionType] || log.actionType;
  }
}

export default function App() {
  // Hold the temporary dashboard data and form values in browser memory
  const [role, setRole] = useState("Receptionist");
  const [date, setDate] = useState(DEMO_DATE);
  const [search, setSearch] = useState("");
  const [data, setData] = useState({
    patients: [],
    staff: [],
    appointments: [],
  });
  const [patient, setPatient] = useState(emptyPatient);
  const [booking, setBooking] = useState(emptyBooking);
  const [reschedule, setReschedule] = useState(null);
  const [message, setMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [historyAppointment, setHistoryAppointment] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const selectedDateRef = useRef(date);

  useEffect(() => {
    selectedDateRef.current = date;
  }, [date]);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const response = await fetch(
          `/api/data?date=${encodeURIComponent(date)}&q=${encodeURIComponent(search)}`,
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        if (active) setData(body);
      } catch (error) {
        if (active) setMessage(error.message || "Could not load ClinicFlow.");
      }
    }

    loadData();
    return () => {
      active = false;
    };
  }, [date, search, refreshKey]);

  async function request(path, options) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-demo-role": role,
        ...(socket.id ? { "x-socket-id": socket.id } : {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Request failed.");
    return body;
  }

  const refresh = useCallback((successMessage) => {
    if (successMessage) setMessage(successMessage);
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    function refreshScheduleIfVisible({ affectedDates = [] } = {}) {
      if (!affectedDates.length || affectedDates.includes(selectedDateRef.current)) {
        refresh();
      }
    }

    socket.on("appointment:created", refreshScheduleIfVisible);
    socket.on("appointment:rescheduled", refreshScheduleIfVisible);
    socket.on("appointment:status-changed", refreshScheduleIfVisible);
    socket.on("appointment:cancelled", refreshScheduleIfVisible);
    socket.on("patient:created", refresh);
    socket.connect();

    return () => {
      socket.off("appointment:created", refreshScheduleIfVisible);
      socket.off("appointment:rescheduled", refreshScheduleIfVisible);
      socket.off("appointment:status-changed", refreshScheduleIfVisible);
      socket.off("appointment:cancelled", refreshScheduleIfVisible);
      socket.off("patient:created", refresh);
      socket.disconnect();
    };
  }, [refresh]);

  useEffect(() => {
    if (!historyAppointment) return undefined;

    let active = true;
    setHistoryLoading(true);

    request(`/api/appointments/${historyAppointment.id}/audit-logs`, {
      method: "GET",
    })
      .then((logs) => {
        if (active) setAuditLogs(logs);
      })
      .catch((error) => {
        if (active) setMessage(error.message || "Could not load appointment history.");
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });

    return () => {
      active = false;
    };
  }, [historyAppointment, refreshKey, role]);

  async function submitPatient(event) {
    event.preventDefault();
    try {
      await request("/api/patients", {
        method: "POST",
        body: JSON.stringify(patient),
      });
      setPatient(emptyPatient);
      refresh("Fictional patient added.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function submitBooking(event) {
    event.preventDefault();
    try {
      await request("/api/appointments", {
        method: "POST",
        body: JSON.stringify(booking),
      });
      setBooking((current) => ({ ...current, reason: "" }));
      refresh("Appointment booked.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function updateStatus(id, status) {
    try {
      await request(`/api/appointments/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      refresh(`Appointment marked ${status}.`);
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function submitReschedule(event) {
    event.preventDefault();
    try {
      await request(`/api/appointments/${reschedule.id}/reschedule`, {
        method: "PATCH",
        body: JSON.stringify(reschedule),
        "x-demo-role": role,
      });
      setReschedule(null);
      refresh("Appointment rescheduled.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  // Derive the visible patient list and daily summary counts
  const patientMatches = data.patients.filter((item) => {
    const term = search.toLowerCase();
    return (
      item.fullName.toLowerCase().includes(term) || item.phone.includes(term)
    );
  });

  const scheduled = data.appointments.filter(
    (item) => item.status === "Scheduled",
  ).length;

  const waiting = data.appointments.filter(
    (item) => item.status === "Arrived",
  ).length;

  const completed = data.appointments.filter(
    (item) => item.status === "Completed",
  ).length;

  // Render every dashboard control from the temporary state
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Fictional data only</p>
          <h1>ClinicFlow</h1>
          <p>
            Daily appointments, patient lookup, and a safer booking workflow.
          </p>
        </div>
        <label className="role-picker">
          Demo role
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option>Receptionist</option>
            <option>Clinician</option>
          </select>
        </label>
      </header>

      <p className="notice">
        This learning prototype is not production authentication and must not
        contain real patient data.
      </p>
      {message && (
        <p className="message" aria-live="polite">
          {message}
        </p>
      )}
      <section className="toolbar card">
        <label>
          Schedule date
          <input
            type="date"
            value={date}
            onChange={(event) => {
              const nextDate = event.target.value;
              setDate(nextDate);
              setBooking((current) => ({
                ...current,
                startsAt: `${nextDate}T09:00`,
                endsAt: `${nextDate}T09:30`,
              }));
            }}
          />
        </label>
        <label>
          Search patients or appointments
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, phone, clinician, or reason"
          />
        </label>
      </section>
      <section className="metrics">
        <article className="card">
          <strong>{data.appointments.length}</strong>
          <span>Total today</span>
        </article>
        <article className="card">
          <strong>{scheduled}</strong>
          <span>Scheduled</span>
        </article>
        <article className="card">
          <strong>{waiting}</strong>
          <span>Waiting</span>
        </article>
        <article className="card">
          <strong>{completed}</strong>
          <span>Completed</span>
        </article>
      </section>
      <section className="card">
        <h2>Daily staff calendar</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Patient</th>
                <th>Clinician</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.appointments
                .filter(
                  (item) =>
                    item.startsAt.startsWith(date) &&
                    `${item.patientName} ${item.phone} ${item.staffName} ${item.reason}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                )
                .map((appointment) => (
                  <tr key={appointment.id}>
                    <td>
                      {appointment.startTime} to {appointment.endTime}
                    </td>
                    <td>
                      {appointment.patientName}
                      <small>{appointment.phone}</small>
                    </td>
                    <td>{appointment.staffName}</td>
                    <td>{appointment.reason}</td>
                    <td>
                      <span
                        className={`badge ${appointment.status.toLowerCase().replaceAll(" ", "-")}`}
                      >
                        {appointment.status}
                      </span>
                    </td>
                    <td className="actions">
                      {role === "Receptionist" ? (
                        <>
                          <button
                            onClick={() =>
                              updateStatus(appointment.id, "Arrived")
                            }
                          >
                            Arrived
                          </button>
                          <button
                            onClick={() =>
                              setReschedule({
                                id: appointment.id,
                                staffId: String(appointment.staffId),
                                startsAt: appointment.startsAt,
                                endsAt: appointment.endsAt,
                              })
                            }
                          >
                            Reschedule
                          </button>
                          <button
                            className="danger"
                            onClick={() =>
                              updateStatus(appointment.id, "Cancelled")
                            }
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() =>
                              updateStatus(appointment.id, "In Consultation")
                            }
                          >
                            Start visit
                          </button>
                          <button
                            onClick={() =>
                              updateStatus(appointment.id, "Completed")
                            }
                          >
                            Complete
                          </button>
                        </>
                      )}
                      <button onClick={() => setHistoryAppointment(appointment)}>
                        History
                      </button>
                    </td>
                  </tr>
                ))}
              {!data.appointments.length && (
                <tr>
                  <td colSpan="6">No matching appointments.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {role === "Receptionist" ? (
        <section className="two-column">
          <form className="card" onSubmit={submitBooking}>
            <h2>Book appointment</h2>
            <label>
              Patient
              <select
                required
                value={booking.patientId}
                onChange={(event) =>
                  setBooking({ ...booking, patientId: event.target.value })
                }
              >
                <option value="">Choose a patient</option>
                {data.patients.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Clinician
              <select
                required
                value={booking.staffId}
                onChange={(event) =>
                  setBooking({ ...booking, staffId: event.target.value })
                }
              >
                <option value="">Choose a clinician</option>
                {data.staff.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Starts
              <input
                required
                type="datetime-local"
                value={booking.startsAt}
                onChange={(event) =>
                  setBooking({ ...booking, startsAt: event.target.value })
                }
              />
            </label>
            <label>
              Ends
              <input
                required
                type="datetime-local"
                value={booking.endsAt}
                onChange={(event) =>
                  setBooking({ ...booking, endsAt: event.target.value })
                }
              />
            </label>
            <label>
              Reason
              <input
                required
                value={booking.reason}
                onChange={(event) =>
                  setBooking({ ...booking, reason: event.target.value })
                }
              />
            </label>
            <button className="primary" type="submit">
              Confirm booking
            </button>
          </form>
          <form className="card" onSubmit={submitPatient}>
            <h2>Add fictional patient</h2>
            <label>
              Full name
              <input
                required
                value={patient.fullName}
                onChange={(event) =>
                  setPatient({ ...patient, fullName: event.target.value })
                }
              />
            </label>
            <label>
              Phone
              <input
                required
                value={patient.phone}
                onChange={(event) =>
                  setPatient({ ...patient, phone: event.target.value })
                }
              />
            </label>
            <label>
              Date of birth
              <input
                required
                type="date"
                value={patient.dateOfBirth}
                onChange={(event) =>
                  setPatient({ ...patient, dateOfBirth: event.target.value })
                }
              />
            </label>
            <button className="primary" type="submit">
              Add patient
            </button>
          </form>
        </section>
      ) : (
        <section className="card">
          <p>
            Clinicians can update clinical statuses but cannot create patients,
            book, reschedule, or cancel appointments.
          </p>
        </section>
      )}
      {role === "Receptionist" && reschedule && (
        <form className="card" onSubmit={submitReschedule}>
          <h2>Reschedule appointment #{reschedule.id}</h2>
          <div className="form-grid">
            <label>
              Clinician
              <select
                required
                value={reschedule.staffId}
                onChange={(event) =>
                  setReschedule({ ...reschedule, staffId: event.target.value })
                }
              >
                {data.staff.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Starts
              <input
                required
                type="datetime-local"
                value={reschedule.startsAt}
                onChange={(event) =>
                  setReschedule({ ...reschedule, startsAt: event.target.value })
                }
              />
            </label>
            <label>
              Ends
              <input
                required
                type="datetime-local"
                value={reschedule.endsAt}
                onChange={(event) =>
                  setReschedule({ ...reschedule, endsAt: event.target.value })
                }
              />
            </label>
          </div>
          <div className="actions">
            <button className="primary" type="submit">
              Save new time
            </button>
            <button type="button" onClick={() => setReschedule(null)}>
              Close
            </button>
          </div>
        </form>
      )}
      {historyAppointment && (
        <section className="card appointment-history">
          <div className="section-heading">
            <div>
              <h2>Appointment history</h2>
              <p>
                {historyAppointment.patientName} with {historyAppointment.staffName}
              </p>
            </div>
            <button type="button" onClick={() => setHistoryAppointment(null)}>
              Close history
            </button>
          </div>
          {historyLoading ? (
            <p>Loading history…</p>
          ) : (
            <ol className="timeline">
              {auditLogs.map((log) => (
                <li key={log.id}>
                  <div className="timeline-marker" aria-hidden="true" />
                  <article>
                    <div className="timeline-heading">
                      <strong>{auditActionLabels[log.actionType] || log.actionType}</strong>
                      <time dateTime={log.createdAt}>
                        {new Date(log.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <p>Performed by: {log.actorRole}</p>
                    <p className="timeline-summary">{describeAuditEvent(log)}</p>
                  </article>
                </li>
              ))}
              {!auditLogs.length && <li>No audit history is available yet.</li>}
            </ol>
          )}
        </section>
      )}
      <section className="card">
        <h2>Patient records</h2>
        <div className="patient-list">
          {patientMatches.map((item) => (
            <article key={item.id}>
              <strong>{item.fullName}</strong>
              <span>{item.phone}</span>
              <span>DOB: {item.dateOfBirth}</span>
            </article>
          ))}
          {!patientMatches.length && <p>No matching fictional patients.</p>}
        </div>
      </section>
    </main>
  );
}
