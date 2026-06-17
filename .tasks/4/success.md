Task is done when **`npm run eval`** produces **100% recall on `summary_drift_stop` gold cases** (stopped_with_todos antipattern correctly detected on first occurrence) AND **`npm test`** passes with zero regressions in **the local test runner**.

NOT done at: CI green / unit tests alone / "the prompt looks better" / code compiles.
