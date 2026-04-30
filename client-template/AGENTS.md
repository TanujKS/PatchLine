# AGENTS.md - Patchline coding agent rules

This repo is an SMB website managed by patchline-worker. A coding agent is
invoked when a maintainer adds either `approve-for-claude` or
`approve-for-codex` to a Patchline issue. The issue body is the source of truth.

## Hard Rules

- Make the smallest possible diff to satisfy the issue. One PR, one logical
  change.
- Prefer structured content files over component/template edits.
- Do not edit dependencies, lockfiles, CI, deployment config, secrets, or agent
  config unless the issue explicitly asks for a setup change.
- If the request is ambiguous, comment on the issue asking for clarification
  instead of guessing.

## Editable Areas

Customize this list per repo:

- `src/content/**` - site-wide copy, phone, email, address, hours
- `src/data/**` - structured lists and records
- `src/pages/**` - page-level content files, if used
- `public/images/**` - images
- `public/files/**` - PDFs and downloads

## PR Conventions

- Title: `[client-request] <short summary>`
- Body must include `Closes #<issue-number>`
- Include a short summary of changed files and any ambiguity encountered.
