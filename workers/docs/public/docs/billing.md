# Billing

Plans: Hobby (free, 3 checks, 300 runs/day), Indie $39/mo (25 checks),
Team $149/mo (100 checks), Enterprise $499+ (1000 checks).

Metered usage: billed orgs report the prior day's run count to a Stripe
Billing Meter (`agent_runs`) every night at 03:00 UTC. Plan changes come
from Stripe webhooks (`checkout.session.completed`,
`customer.subscription.updated/deleted`) — signature-verified, env-gated.
