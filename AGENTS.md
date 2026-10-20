# Debug Mode repository

- `src/` is the source of truth. Keep plugin identity `debug-mode` and display name `Debug Mode`.
- Edit workflow rules in `src/workflow.mjs`; its generated skill and `plugins/` must be regenerated with `npm run build`.
- `plugins/` is intentionally committed as a self-contained Git marketplace payload. Do not edit generated files directly or commit node_modules, local logs, receiver configuration, session data, credentials, or personal paths.
- Version is owned by the root package.json. `npm run build` synchronizes manifests, runtime package metadata and the skill.
- Do not change the current debug workflow while fixing packaging. User confirmation means cleanup only: preserve effective fixes and unrelated changes; no extra reproduction/tests unless requested.
- npm ci only installs project build dependencies; never auto-install or upgrade Node, npm, Homebrew or unrelated software.
- `npm run check:package` performs static distribution checks. Functional regression commands are documented separately; do not claim checks you did not run.
