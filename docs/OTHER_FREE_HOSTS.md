# Alternative free hosts (Nov 2026)

## Koyeb Free + Neon Free

Koyeb offers one free Web Service per organization: 512 MB RAM, 0.1 vCPU, 2 GB non-persistent storage, deploy from a GitHub repo or Docker image, scale-to-zero after ~1 hour idle. Sign-up may require additional validation. It is not suitable for a reliable always-on service.

1. Push this repo to GitHub.
2. Sign in at https://app.koyeb.com and create a new Web Service.
3. Choose a GitHub repository and Dockerfile as build method, or use the prebuilt Docker Hub image.
4. Choose the `free` service instance, if available to your account/region.
5. Set `DATABASE_URL` (Neon pooled), `DIRECT_URL` (Neon direct), `INGEST_API_KEY` (long random secret), `NODE_ENV=production`, `PORT=3000` (unless the host provides PORT) and `CORS_ORIGINS` as applicable.
6. Set exposed HTTP port 3000 / use host-provided PORT, deploy, and check `/health`.

Koyeb free Postgres allowance is very small (5 active hours), so use Neon for PostgreSQL.

Official: https://www.koyeb.com/docs/reference/instances and https://www.koyeb.com/docs/faqs/pricing

## Supabase Free as alternative database

Supabase Free provides a normal PostgreSQL connection string, with a 500 MB DB quota and pausing after inactivity. Useful if Neon is unavailable. Keep runtime/migration URLs distinct as required by the Supabase pooler configuration.

Official: https://supabase.com/pricing and https://supabase.com/docs/guides/platform/free-project-pausing

## Not drop-in hosts

Cloudflare Workers/D1 is not a drop-in NestJS Docker server or PostgreSQL database. Requires rewriting or an adapted edge deployment architecture.

Oracle Cloud Always Free can offer VMs and managed infrastructure, but availability, account onboarding and verification can be difficult. Do not make it a critical dependency for this MVP.
