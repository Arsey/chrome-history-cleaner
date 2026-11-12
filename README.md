# Chrome History Cleaner

Delete Chrome history entries by keyword or domain. Preview the matches, then remove them manually or schedule cleanup. History and rules are processed on your device.

## Install from source

1. In Chrome 120 or newer, open `chrome://extensions`.
2. Turn on **Developer mode** and click **Load unpacked**.
3. Select the folder that contains `manifest.json`.
4. Open **Chrome History Cleaner** from the extensions menu.
5. Add a rule, save it, and click **Preview matches**.

Automatic cleanup is off when you install the extension.

## Rules and cleanup

A **Remove** rule selects pages to delete. A **Protect** rule keeps matching pages even when a Remove rule also matches.

- Keywords can match the address, the page title, or both. The extension checks the original and decoded address. Matches ignore letter case unless you enable **Match letter case**.
- A domain rule matches the exact hostname and its subdomains. Enter a hostname such as `example.com`.
- Each removal rule can use the default interval or its own interval in minutes. Saving changes restarts the timers. A page can be removed as soon as any matching removal rule is due. Protect rules apply to every cleanup.
- **Stop automatic cleanup** turns off the schedule and stops pending deletions. Chrome may finish a deletion it has already started.
- **Export saved rules** downloads a JSON backup. Import replaces saved rules and turns automatic cleanup off. An invalid file leaves the saved rules intact.

## Before deleting

- Chrome removes **every visit to each matching address**. Deletion is permanent and can affect other devices if Chrome syncs your history.
- The preview displays up to 300 addresses and gives the full count. Confirming removal deletes the full preview set. Preview again if it expires, if another cleanup runs, or if you change your rules.
- A large preview can exceed the 4 MB storage limit. Narrow your rules and try again. Cleanup starts only after the history scan finishes.
- Chrome must be running for scheduled cleanup. Sleep can delay it. If Chrome interrupts a cleanup, some entries may already have been removed.

## Privacy and permissions

The extension needs `history` to find and remove entries, `storage` for local settings and temporary previews, `alarms` for the schedule, and `unlimitedStorage` for large rule sets. It uses no host permissions or content scripts. Network connections from extension pages are blocked. Support and Ko-fi open only when clicked.

Rule exports contain your keywords and domains. Keep personal exports out of public issues and commits. See the [privacy policy](https://arsey.github.io/arseyapps.github.io/chrome_history_cleaner_privacy.html) for details.

## Languages

Choose a language at the top of Settings or select **Same as Chrome**. The extension supports English, Ukrainian, Dutch, German, French, Spanish, Italian, Polish, Brazilian Portuguese, Japanese, and Korean. Chrome languages without a translation use English.

## Development

Run `npm test` with a recent Node.js version. The extension has no runtime dependencies.

Run `python3 tests/browser-smoke.py` with Python Playwright and Chrome for Testing. Set `CHROME_TEST_EXECUTABLE` if the script cannot find your test browser. The script starts a separate profile and adds synthetic history. It writes desktop and mobile screenshots to `tests/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull requests and [SECURITY.md](SECURITY.md) for private vulnerability reports. For help, use the [support form](https://docs.google.com/forms/d/e/1FAIpQLSfs9_6vbZzlLaJO2r20FfiTOpgwmDCH8UifT05wKkjZPyWcPw/viewform).

## License

Copyright © 2026 Arsey. The source is available under the [PolyForm Strict License 1.0.0](LICENSE.md), which permits noncommercial use. The [contribution terms](CONTRIBUTING.md) allow forks and local changes for pull requests to this repository.
