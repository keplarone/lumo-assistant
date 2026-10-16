# candle-core 0.11.0, moved to zip 9

The crates.io source of candle-core 0.11.0 (Apache-2.0 OR MIT, see LICENSE), with only these changes:

- `Cargo.toml`: `zip` 8.6.0 → 9.0.4 (zip 8 has RUSTSEC-2026-0367, -0368 and -0369); examples, tests and
  benches dropped, since their files aren't vendored.
- `src/npy.rs`, `src/pickle.rs`: zip 9 returns entry names as a `Result`, so three call sites add `?`.

Delete this folder and the `[patch.crates-io]` entry in `apps/desktop/src-tauri/Cargo.toml` once a
candle-core release depends on zip 9 or later.
