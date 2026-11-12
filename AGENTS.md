# Chrome History Cleaner

## Scope

Local Manifest V3 Chrome extension. Keep behavior understandable: literal keyword and domain rules, keep-rule precedence, local storage, preview before manual removal, optional schedule.

## Development

- Run `npm test` after changes. Add meaningful regression coverage for bugs.
- Keep source dependency-free. Never introduce remote scripts, tracking or data uploads.
- Use isolated browser profiles and synthetic history for integration tests. Never clean real browsing history as a development check.
- Preserve default-off automation and import's automatic-off behavior.
- Never silently truncate a history scan or delete before a complete scan succeeds.
- Never log URLs, titles, keywords, browser history, credentials or other personal content.
- Update README for changes to deletion semantics, permissions or schedule behavior.

## Known pitfalls

- `history.deleteUrl` deletes every visit to a URL. Do not advertise per-visit or age-based deletion.
- Alarm delivery is approximate and can be delayed by sleep. Restore missing alarms on worker startup.
- Service workers can stop unexpectedly. Cleanup must be safe to retry; don't claim an interrupted run completed.
- Keep rules always override remove rules; domain matching must use hostname boundaries.
- Use textContent for untrusted page titles and URLs. Never render history as HTML.
- An import must validate completely before replacing settings and must disable automatic cleanup.

- Save settings only with the revision read by the caller. Reject stale or missing revisions.
- Stop must cancel pending deletion work before waiting in the operation queue.
- Preview authorization expires after ten minutes. Store only URLs within the session-memory budget.
- Keep outbound network connections blocked by CSP. External support links open only on user action.

- Automatic runs evaluate only due removal rules plus all enabled Protect rules.
- Persist per-rule deadlines across worker restarts. Reset them when settings are saved.
- Missing rule intervals inherit the global default for older settings and imports.
