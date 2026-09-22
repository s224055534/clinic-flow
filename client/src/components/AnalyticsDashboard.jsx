import { useEffect, useMemo, useState } from "react";
import { socket } from "../socket.js";
import {
  ChartCard,
  ClinicianBarChart,
  StatusPieChart,
  TrendLineChart,
} from "./AnalyticsCharts.jsx";

function monthBounds(date) {
  const [year, month] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${date.slice(0, 7)}-01`,
    to: `${date.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`,
  };
}

function MetricCard({ label, value, detail }) {
  return (
    <article className="card analytics-metric">
      <strong>{value}</strong>
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </article>
  );
}

export default function AnalyticsDashboard({
  staff,
  role,
  selectedDate,
  refreshKey,
}) {
  const initialBounds = useMemo(
    () => monthBounds(selectedDate),
    [selectedDate],
  );
  const [from, setFrom] = useState(initialBounds.from);
  const [to, setTo] = useState(initialBounds.to);
  const [staffId, setStaffId] = useState("");
  const [granularity, setGranularity] = useState("daily");
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const parameters = new URLSearchParams({
      from,
      to,
    });

    if (staffId) {
      parameters.set("staffId", staffId);
    }

    const options = {
      headers: {
        "x-demo-role": role,
        ...(socket.id ? { "x-socket-id": socket.id } : {}),
      },
    };

    let active = true;

    async function loadAnalytics() {
      setLoading(true);
      setError("");

      try {
        const queryString = parameters.toString();

        const paths = [
          "summary",
          "trends",
          "clinicians",
          "status-distribution",
        ];

        const responses = await Promise.all(
          paths.map((path) =>
            fetch(`${API_URL}/api/analytics/${path}?${queryString}`, options),
          ),
        );

        const bodies = await Promise.all(
          responses.map((response) => response.json()),
        );

        const failed = responses.findIndex((response) => !response.ok);

        if (failed >= 0) {
          throw new Error(bodies[failed].error || "Could not load analytics.");
        }

        if (!active) return;

        setAnalytics({
          summary: bodies[0],
          trends: bodies[1],
          clinicians: bodies[2].map((item) => ({
            ...item,
            appointmentCount: Number(item.appointmentCount),
            bookedHours: Number(item.bookedHours),
            workloadPercentage: Number(item.workloadPercentage),
          })),
          statusDistribution: bodies[3].map((item) => ({
            ...item,
            count: Number(item.count),
          })),
        });
      } catch (loadError) {
        if (active) {
          setError(loadError.message || "Could not load analytics.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadAnalytics();

    return () => {
      active = false;
    };
  }, [from, to, staffId, role, refreshKey]);

  const trendData = analytics?.trends[granularity] || [];
  const busiestDay = analytics?.summary.busiestDay;

  return (
    <section className="analytics-dashboard">
      <section className="card analytics-filters">
        <div>
          <h2>Analytics dashboard</h2>
          <p>Scheduling performance for the selected date range.</p>
        </div>
        <label>
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label>
          Clinician
          <select
            value={staffId}
            onChange={(event) => setStaffId(event.target.value)}
          >
            <option value="">All clinicians</option>
            {staff.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fullName}
              </option>
            ))}
          </select>
        </label>
      </section>
      {loading && <p className="message">Loading analytics…</p>}
      {error && <p className="notice">{error}</p>}
      {analytics && !loading && (
        <>
          <section className="analytics-metrics">
            <MetricCard
              label="Appointments"
              value={analytics.summary.totalAppointments}
            />
            <MetricCard
              label="Booked hours"
              value={Number(analytics.summary.bookedHours).toFixed(1)}
            />
            <MetricCard
              label="Cancellation rate"
              value={`${analytics.summary.cancellationRate}%`}
              detail={`${analytics.summary.cancelledAppointments} cancellations`}
            />
            <MetricCard
              label="Busiest day"
              value={busiestDay?.date || "No appointments"}
              detail={
                busiestDay?.count
                  ? `${busiestDay.count} appointments`
                  : undefined
              }
            />
          </section>
          <section className="analytics-grid">
            <ChartCard title="Appointment trends">
              <label className="chart-control">
                View by
                <select
                  value={granularity}
                  onChange={(event) => setGranularity(event.target.value)}
                >
                  <option value="daily">Day</option>
                  <option value="weekly">Week</option>
                  <option value="monthly">Month</option>
                </select>
              </label>
              <TrendLineChart data={trendData} />
            </ChartCard>
            <ChartCard title="Cancellation trend">
              <TrendLineChart
                data={analytics.trends.cancellations}
                color="#c85b5b"
              />
            </ChartCard>
            <ChartCard title="Clinician utilization">
              <ClinicianBarChart data={analytics.clinicians} />
              <div className="workload-list">
                {analytics.clinicians.map((item) => (
                  <p key={item.id}>
                    {item.fullName}: {item.bookedHours} hours (
                    {item.workloadPercentage}%)
                  </p>
                ))}
              </div>
            </ChartCard>
            <ChartCard title="Status distribution">
              <StatusPieChart data={analytics.statusDistribution} />
            </ChartCard>
          </section>
        </>
      )}
    </section>
  );
}
