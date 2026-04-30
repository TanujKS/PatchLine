# CLAUDE.md - rules for the Patchline website agent

This repo is an SMB website managed by **patchline-worker**. A coding agent is
invoked when a maintainer adds either `approve-for-claude` or
`approve-for-codex` to an issue created by the worker. The issue body is the
source of truth for what to change.

## Hard rules

- Make the **smallest possible diff** to satisfy the issue. One PR, one
  logical change.
- Edit content data, not Vue components, whenever possible. The site renders
  from structured data files. If you find yourself editing a `.vue` template
  to change a phone number, you are doing it wrong - update the matching
  content file instead.
- Never modify any of:
  - `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
  - anything under `.github/`
  - `wrangler.*`, `vite.config.*`, `.env*`
  - `public/_redirects`, `public/_headers`
  - `.claude/`, `CLAUDE.md`
- Do **not** add, upgrade, or remove dependencies.
- Do **not** run shell commands (Bash is denied in `.claude/settings.json`).

## Where editable content lives

> Customize this list per repo so Claude looks in the right places.

- `src/content/site.json` - phone, email, address, business hours
- `src/content/services.json` - list of services
- `src/content/menu.json` - menu items (for hospitality sites)
- `src/content/team.json` - team members
- `src/content/pages/*.json` - per-page copy
- `public/images/` - replaceable hero/photo assets
- `public/files/` - replaceable PDFs / downloads (menus, brochures)

If the requested change does not have an obvious home in any of the above:

1. Search the repo (`Glob`, `Grep`) to confirm.
2. If still ambiguous, **stop**. Add a comment to the issue describing what
   you can't determine and what input you need. Do not guess.

## Attachments

The issue body may contain presigned download URLs for attachments. If the
change requires using one of them:

1. Open the URL via `Read` (Claude Code supports HTTP fetches via Read where
   enabled) or note the URL in the PR description for the human to download.
2. Save assets under `public/images/` or `public/files/` with a descriptive
   filename. Reference them from the relevant content JSON file.

## PR conventions

- Title: `[client-request] <short summary>`
- Body must include: `Closes #<issue-number>`
- Body should list:
  - The original request (one sentence)
  - The files changed and what changed in each
  - Anything that was ambiguous and how you resolved it
  - A note that a Cloudflare Pages preview will appear when CI completes

## When in doubt

Ask the issue author. Comment on the issue with a specific question. Do not
ship a guess.
