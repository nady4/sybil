# Helicone migration

Helicone is in maintenance mode; export your project's requests (Requests
tab -> export, JSONL or CSV) and replay them into AgentsRE as production
runs. Baselines and correlation survive the migration.

```bash
agentsre import-helicone export.jsonl --feature support
```

- Deduplicates by request id; concurrent (8 workers); progress printed
- Every imported row becomes a production Run with model, tokens, latency,
  cost, and status preserved
- The ingest path enforces your daily cap — large exports may take several
  passes over the day

Then export from your agent runtime via the envelope or Langfuse-compat
endpoint so production keeps flowing.
