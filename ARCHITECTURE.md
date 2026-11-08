# Architecture

## Cloudflare setup

```
browser ──► Worker "many-hands" (many-hands.egregore.fyi, also many-hands.egregore85.workers.dev)
              ├─ /api/*      → src/worker.js (JSON API) ──► D1 "shift-planner-db"
              └─ everything else → static assets from public/ (ASSETS binding)
```

| Piece | What / where |
|---|---|
| Account | `c43ee795740454fb0525da8e7a0f5970`, workers.dev subdomain `egregore85` (account-wide, shared by all Workers) |
| Worker | `many-hands` (was `shift-planner`), single file `src/worker.js`, no runtime deps |
| Static assets | `public/` via `[assets]`; `run_worker_first = ["/api/*"]` so only the API hits the Worker; SPA fallback to `index.html` |
| Database | D1 `shift-planner-db` (old name kept, D1 can't be renamed; `c4d9e25d-…`, WEUR), binding `DB` |
| Schema | `migrations/` applied with `wrangler d1 migrations apply` (tracked in `d1_migrations`) |
| Build | wrangler `[build]` runs `npm run build` before dev/deploy: Tailwind v4 CLI → `public/styles.css`, Inter woff2 → `public/fonts/` (both gitignored) |
| Versioning | `[version_metadata]` binding → every API response carries `x-app-version`; open tabs show a reload banner after a deploy |
| Logs | `[observability] enabled = true` (Workers Logs in the dashboard) |

Deploy: `npm run db:migrate:remote` (only if `migrations/` changed), then `npm run deploy`. Local: `npm run db:migrate:local && npm run dev`.

## Data model

`plans` (name, optional description, password hash + hint, archived_at) 1─n `shifts` 1─n `signups`, plus `plans` 1─n `versions` (full JSON snapshot of shifts + signups after every change, last 100 kept). `shifts.end_time` is optional (multi-hour cells in the overview).

## Design decisions

- **No accounts.** People type their name; anyone with the link can sign up or remove. Versioning is the safety net, and the organizer can restore any version.
- **Optional admin password per plan** (PBKDF2-SHA256, salted, 100k iterations, the Workers maximum) guards layout edits, restore, archive and delete only. Archive/unarchive/delete always re-ask it; delete also confirms twice. A masked hint (`l******2`) is stored next to the hash and shown after 3 wrong tries; older plans get one the first time the right password is entered. Copies never inherit the password; the copier sets a new one. A copy is either shifts only (fresh history) or shifts + sign-ups + version history; all shift/sign-up ids, also inside copied snapshots, are remapped so restoring in the copy never touches the original.
- **Archive = hidden from the list**, not locked: the plan still works via its link.
- **Capacity check is one SQL statement** (`INSERT … SELECT … WHERE count < capacity`), so concurrent sign-ups can't overfill a shift.
- **Snapshots over diffs.** Plans are small; a full snapshot per change is simple and restores exactly.
- **Layout save is a batch replace.** Shifts matched by id keep their sign-ups; removed shifts drop theirs (the UI warns first).
- **No framework, no runtime deps.** Vanilla JS with a tiny `h()` DOM helper, hash routing. Tailwind only at build time.
- **i18n in one file** (`public/i18n.js`, EN/DE, German uses "du"). The API sends an error `code` + `params` next to the English message; stored version descriptions stay English and are translated on display.
- **Built for older users.** 18px base text, 48px touch targets, AA contrast, text labels on buttons, one "your name" field instead of one per shift.
- **Role colors by first appearance**, not by name hash: the first roles in a plan always get clearly different colors.
- **Print = the overview**, zoomed to fit one A4 landscape page, or one page per day if that would go below 45%.
- **Self-hosted font** (no Google Fonts, GDPR).

## Gotchas learned

- Renaming a Worker = deploying under a new `name`: it creates a second Worker with a new URL; the old one keeps running until deleted. Both can share the same D1.

- Adding `routes` (e.g. a custom domain) silently turns off the workers.dev URL and preview URLs on the next deploy. Keep `workers_dev = true` and `preview_urls = true` in `wrangler.toml` or old links 404.
- Changing the workers.dev subdomain: no wrangler command, and the API can't rename in place. Use `DELETE` then `PUT /accounts/:id/workers/subdomain`, then redeploy. All old links die, and the new TLS cert can take a few minutes.
- Cloudflare's bot protection blocks the default `Python-urllib` user agent (error 1010). Set a user agent in scripts.
- Right after a deploy, the edge can serve the old asset for a few seconds.
- Hash routing never reloads the page, so open tabs keep running old code. Hence the `x-app-version` banner.
- `wrangler` OAuth tokens expire. Re-run `npx wrangler login` if D1 or deploy suddenly says "not logged in".
