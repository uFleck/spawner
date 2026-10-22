# Spawner

## Rules

- **Never use native dialogs in the desktop app.** No `ask`, `message`, `confirm` or `alert` from `@tauri-apps/plugin-dialog` or the browser. Confirmations, warnings and errors use the in-app `Dialog` (`src/components/ConcludeDialog.tsx`), styled like the rest of the UI. The `dialog:allow-message` capability is deliberately not granted. The folder picker (`open`) is the only native dialog allowed, since it has no in-app equivalent.
