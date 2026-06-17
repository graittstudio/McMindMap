# McMindMap tests

Two layers:

* `backend/` — PHP+curl integration tests against the live `api/index.php`.
  Runs in CI on every push (stage `test`, job `backend-test`).
* `e2e/` — Playwright smoke tests that drive Chromium through the real
  login / drawer / share flows. **Manual** in CI because the mbappe shell
  runner has no Chromium; click *Run* in the GitLab UI once a docker
  runner is attached, or run them locally.

## Run locally

```sh
sh tests/backend/run.sh       # ~3 sec
sh tests/e2e/run.sh            # ~25 sec; needs node + php on PATH
```

Both scripts start a fresh PHP server on `127.0.0.1:8765` against a
throw-away SQLite DB at `/tmp/test-mindmap.db` (or
`/tmp/test-mindmap-e2e.db`) and tear it down on exit. They seed two
users:

| username | password   | display name |
| -------- | ---------- | ------------ |
| `alice`  | `alice123` | Alice        |
| `bob`    | `bob1234`  | Bob          |

## Adding tests

* Backend: append to `tests/backend/cases.php`. Use `describe()`, `it()`,
  `eq()`, `truthy()`, `reset_session()`, and `api($method, $action, $body)`.
* E2E: drop a new `*.spec.js` into `tests/e2e/specs/`. The Playwright
  config disables parallelism so tests can share the seeded DB.
