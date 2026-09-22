import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const statusColors = ["#147d75", "#f2a93b", "#4d8fce", "#7b61a8", "#c85b5b"];

export function ChartCard({ title, children }) {
  return (
    <section className="card chart-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function TrendLineChart({ data, color = "#147d75" }) {
  if (!data.length) return <p className="chart-empty">No appointments in this range.</p>;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
        <CartesianGrid stroke="#e1e8ec" strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Line dataKey="count" name="Appointments" stroke={color} strokeWidth={3} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ClinicianBarChart({ data }) {
  if (!data.length) return <p className="chart-empty">No clinician workload in this range.</p>;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 12, left: 28, bottom: 0 }}>
        <CartesianGrid stroke="#e1e8ec" strokeDasharray="3 3" />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="fullName" width={115} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="appointmentCount" name="Appointments" fill="#147d75" radius={[0, 5, 5, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function StatusPieChart({ data }) {
  if (!data.length) return <p className="chart-empty">No appointment statuses in this range.</p>;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie data={data} dataKey="count" nameKey="label" outerRadius={90} label>
          {data.map((item, index) => (
            <Cell key={item.label} fill={statusColors[index % statusColors.length]} />
          ))}
        </Pie>
        <Tooltip />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}
