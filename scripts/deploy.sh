#!/usr/bin/env bash
set -euo pipefail

# One-shot production deployment for AgentsRE.
#
# 1. Fill in deploy.env (copy from deploy.env.example, never commit it).
# 2. Run: ./scripts/deploy.sh
#
# The script deploys the 5 workers (resources like D1/KV/R2/Queues are
# auto-provisioned on first deploy — ids are omitted in wrangler.jsonc),
# applies migrations remotely, and sets all secrets from the env file.
# Custom domains / DNS are configured in the Cloudflare dashboard.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy.env"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE — copy scripts/deploy.env.example and fill it in"; exit 1; }
set -a; source "$ENV_FILE"; set +a

require() { [[ -n "${!1:-}" ]] || { echo "deploy.env is missing $1"; exit 1; }; }
put_secret() { # put_secret <worker-dir> <secret-name>
  local dir="$1" name="$2"
  local value="${!name:-}"
  [[ -n "$value" ]] || return 0
  echo "  secret $name"
  (cd "$ROOT/workers/$dir" && printf '%s' "$value" | npx wrangler secret put "$name")
}

echo "==> Deploying workers (resources auto-provision on first deploy)"
for w in scheduler ingest api alerts docs; do
  echo "  agentsre-$w"
  (cd "$ROOT/workers/$w" && npx wrangler deploy)
done

echo "==> Applying D1 migrations (remote)"
(cd "$ROOT/workers/scheduler" && npx wrangler d1 migrations apply agentsre --remote)

echo "==> Setting scheduler secrets"
require KEYS_ENC_KEY
require ADMIN_TOKEN
put_secret scheduler KEYS_ENC_KEY
put_secret scheduler ADMIN_TOKEN
put_secret scheduler OPERATOR_CHANNEL
put_secret scheduler OPERATOR_ORG

echo "==> Setting api secrets"
put_secret api KEYS_ENC_KEY
put_secret api ADMIN_TOKEN
put_secret api BOOTSTRAP_KEY
put_secret api CLERK_WEBHOOK_SECRET
put_secret api STRIPE_SECRET_KEY
put_secret api STRIPE_WEBHOOK_SECRET

echo "==> Setting alerts secrets (optional)"
put_secret alerts RESEND_API_KEY

echo
echo "Done. Remaining manual steps:"
echo "  1. Clerk dashboard: create instance, copy keys into deploy.env (CLERK_JWKS_URL),"
echo "     add a webhook -> https://<api-host>/v1/auth/clerk-webhook (organization.created +"
echo "     organizationMembership.created/deleted)."
echo "  2. Stripe dashboard: create the 3 price ids, set STRIPE_PRICE_* in deploy.env,"
echo "     add the webhook -> https://<api-host>/v1/billing/webhook (checkout.session.completed,"
echo "     customer.subscription.updated/deleted)."
echo "  3. Point CLERK_JWKS_URL / STRIPE_API_URL / OPENAI_BASE_URL at the real endpoints."
echo "  4. Bootstrap the first org:"
echo "     curl -X POST https://<api-host>/v1/setup -H 'x-bootstrap-token: <BOOTSTRAP_KEY>' \\"
echo "       -d '{\"orgName\":\"My Org\",\"plan\":\"indie\"}'"
echo "  5. Add CORS_ORIGIN (https://<web-host>) and optionally custom routes for /v1/*."
