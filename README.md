# csv-reader-speed-01-run-20261121

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/mochilkity-cmyk/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/mochilkity-cmyk/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0, make.fun's own CSV reader. It returns
exactly csv-reader's answer — `{columns, rows, errors}` — for every input,
including its broken-row policy (stray CRs, junk after a closing quote,
quotes that never close, short and long rows), and reads the text much
faster than the reference's character-at-a-time loop.

## How it is faster

- A record with no quote before its line feed holds no quoted field, so it
  is split on commas in one native pass (CRLF files: the trailing CR is the
  line break, not a field).
- A quoted field is found with `indexOf` and sliced out whole; only a field
  holding a doubled quote, or a line break inside its quotes, takes the
  normalising path.
- An unquoted field in a record that does hold quotes is found with one
  regex scan for the next delimiter instead of three `indexOf` scans.
- Only broken rows take the slow path, and the slow path reads exactly as
  csv-reader does, so the errors come out in the same order.

## Layout

- `solve.js` — the entry: `run(input)` returns csv-reader's answer.
  Dependency-free ES module, stdlib only, deterministic, no network.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.

## Practice grade

6/6 cases identical to csv-reader 1.0.0 on the kit's practice set (kit
`grade-local --driver process`: `passed 1`, L1 regrade reproduced byte for
byte), determinism verified (two runs byte-identical), and a differential
fuzz of 35,108 random and edge-case inputs against the reference with 0
mismatches. Parse-only on the practice set: ~162 ms median vs ~528 ms for
the baseline (~3.3x); full run ~0.62–0.84 s vs ~1.34–1.72 s.
