import { api } from "@/lib/api";
import BillingActions from "./billing-actions";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  let billing: { plan: string; stripeCustomerId?: string; limits: { maxChecks: number; maxRunsPerDay: number } };
  let error: string | null = null;
  try {
    billing = await api<typeof billing>("/v1/billing");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    billing = { plan: "hobby", limits: { maxChecks: 3, maxRunsPerDay: 300 } };
  }

  return (
    <div>
      <h1>Billing</h1>
      {error ? <div className="error">api: {error}</div> : null}
      <div className="cards" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="label">Plan</div>
          <div className="value">{billing.plan}</div>
        </div>
        <div className="card">
          <div className="label">Max checks</div>
          <div className="value">{billing.limits.maxChecks}</div>
        </div>
        <div className="card">
          <div className="label">Runs / day</div>
          <div className="value">{billing.limits.maxRunsPerDay}</div>
        </div>
      </div>
      <BillingActions currentPlan={billing.plan} />
    </div>
  );
}
