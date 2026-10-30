import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** render_ui Chart (recharts). Loaded on first use; colors are the theme's `--chart-*` tokens. */
export type ChartProps = {
  type: "bar" | "line" | "area" | "pie";
  data: Record<string, unknown>[];
  x: string;
  series: { key: string; label?: string }[];
  stacked?: boolean;
  height?: number;
};

const color = (i: number) => `var(--chart-${(i % 5) + 1})`;
const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = {
  contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" },
  cursor: { fill: "var(--muted)", opacity: 0.4 },
} as const;

export default function UiChart({ type, data, x, series, stacked, height = 220 }: ChartProps) {
  const name = (s: { key: string; label?: string }) => s.label ?? s.key;
  const legend = series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />;
  const body =
    type === "pie" ? (
      <PieChart>
        <Pie data={data} dataKey={series[0]!.key} nameKey={x} innerRadius="45%" outerRadius="80%" stroke="var(--background)">
          {data.map((_, i) => <Cell key={i} fill={color(i)} />)}
        </Pie>
        <Tooltip {...tip} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    ) : type === "line" ? (
      <LineChart data={data}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey={x} {...axis} />
        <YAxis {...axis} width={40} />
        <Tooltip {...tip} />
        {legend}
        {series.map((s, i) => <Line key={s.key} dataKey={s.key} name={name(s)} stroke={color(i)} strokeWidth={2} dot={false} />)}
      </LineChart>
    ) : type === "area" ? (
      <AreaChart data={data}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey={x} {...axis} />
        <YAxis {...axis} width={40} />
        <Tooltip {...tip} />
        {legend}
        {series.map((s, i) => <Area key={s.key} dataKey={s.key} name={name(s)} stroke={color(i)} fill={color(i)} fillOpacity={0.2} stackId={stacked ? "a" : undefined} />)}
      </AreaChart>
    ) : (
      <BarChart data={data}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey={x} {...axis} />
        <YAxis {...axis} width={40} />
        <Tooltip {...tip} />
        {legend}
        {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={name(s)} fill={color(i)} radius={[4, 4, 0, 0]} stackId={stacked ? "a" : undefined} />)}
      </BarChart>
    );
  return (
    <div style={{ height }} className="w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">{body}</ResponsiveContainer>
    </div>
  );
}
