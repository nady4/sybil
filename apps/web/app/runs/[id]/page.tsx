import { api, fmtUsd } from "@/lib/api";

export const dynamic = "force-dynamic";

interface ToolCall {
  name: string;
  input: unknown;
  output: unknown;
  latencyMs?: number;
  error?: string;
}

interface Step {
  index: number;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
  costUsd?: number;
  toolCalls: ToolCall[];
  refused: boolean;
  content?: string;
}

interface RunRow {
  id: string;
  org_id: string;
  feature_id: string;
  source: "synthetic" | "production";
  model?: string;
  status: string;
  error_type?: string;
  eval_score?: number;
  eval_score_components?: string;
  cost_usd?: number;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  guardrail_tripped: number;
  steps_json?: string;
  meta_json?: string;
  started_at: string;
  completed_at: string;
  tool_call_count?: number;
}

function pretty(v: unknown): string {
  if (v === undefined || v === null) return "-";
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  try {
    const s = JSON.stringify(v, null, 1);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(v);
  }
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let run: RunRow | undefined;
  let error: string | null = null;
  try {
    const data = await api<{ run: RunRow }>(`/v1/runs/${id}`);
    run = data.run;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !run) {
    return (
      <div>
        <h1>Run {id}</h1>
        <div className="error">api: {error ?? "not found"}</div>
      </div>
    );
  }

  const steps = run.steps_json ? (JSON.parse(run.steps_json) as Step[]) : [];
  const components = run.eval_score_components ? (JSON.parse(run.eval_score_components) as Record<string, number>) : {};
  const meta = run.meta_json ? (JSON.parse(run.meta_json) as Record<string, unknown>) : {};

  return (
    <div>
      <h1>
        Run <span className="mono">{run.id}</span>
      </h1>
      <div className="cards" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="label">Status</div>
          <div className="value">
            <span className={`pill ${run.status}`}>{run.status}</span>
          </div>
        </div>
        <div className="card">
          <div className="label">Source</div>
          <div className="value">
            <span className={`pill ${run.source}`}>{run.source}</span>
          </div>
        </div>
        <div className="card">
          <div className="label">Eval score</div>
          <div className="value">{run.eval_score !== undefined && run.eval_score !== null ? run.eval_score.toFixed(2) : "-"}</div>
        </div>
        <div className="card">
          <div className="label">Cost</div>
          <div className="value">{fmtUsd(run.cost_usd)}</div>
        </div>
      </div>

      <h2>Summary</h2>
      <table>
        <tbody>
          {[
            ["Feature", run.feature_id],
            ["Model", run.model ?? "-"],
            ["Latency", run.latency_ms !== undefined && run.latency_ms !== null ? `${run.latency_ms}ms` : "-"],
            ["Tokens in / out", `${run.input_tokens ?? 0} / ${run.output_tokens ?? 0}`],
            ["Guardrail tripped", run.guardrail_tripped ? "yes" : "no"],
            ["Started", run.started_at],
            ["Completed", run.completed_at],
            ["Stop reason", String(meta.stopReason ?? "-")],
            ...(run.error_type ? [["Error", run.error_type] as [string, string]] : []),
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: 180 }}>{k}</td>
              <td className="mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {Object.keys(components).length > 0 ? (
        <>
          <h2>Eval components</h2>
          <table>
            <tbody>
              {Object.entries(components).map(([name, score]) => (
                <tr key={name}>
                  <td style={{ width: 180 }}>{name}</td>
                  <td>{score.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <h2>Steps ({steps.length})</h2>
      {steps.length === 0 ? (
        <div className="empty">No step-level data for this run.</div>
      ) : (
        steps.map((s) => (
          <div key={s.index} style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
              <span className="muted">step {s.index}</span>
              <span className="mono">{s.model}</span>
              <span className="muted">{s.latencyMs}ms</span>
              <span className="muted">
                {s.usage.inputTokens} in / {s.usage.outputTokens} out
              </span>
              {s.costUsd !== undefined ? <span className="muted">{fmtUsd(s.costUsd)}</span> : null}
              {s.refused ? <span className="pill refused">refused</span> : null}
            </div>
            {s.content ? <div className="mono" style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{s.content}</div> : null}
            {s.toolCalls.length > 0
              ? s.toolCalls.map((tc, i) => (
                  <div key={i} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
                    <div className="mono" style={{ color: "var(--accent)" }}>
                      {tc.name}
                      {tc.error ? <span style={{ color: "var(--red)" }}> — error: {tc.error}</span> : null}
                    </div>
                    {tc.input !== undefined && tc.input !== null ? (
                      <pre className="mono" style={{ overflowX: "auto" }}>{pretty(tc.input)}</pre>
                    ) : null}
                    {tc.output !== undefined && tc.output !== null ? (
                      <pre className="mono" style={{ overflowX: "auto", color: "var(--muted)" }}>{pretty(tc.output)}</pre>
                    ) : null}
                  </div>
                ))
              : null}
          </div>
        ))
      )}
    </div>
  );
}
