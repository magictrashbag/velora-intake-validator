# Velora Intake Validator (Part 1)

Turns the messy Velora intake (email thread + SKU CSV + artwork spec/manifest) into a
validated job spec production can trust, plus a defect report.

The case data pack itself is not committed here (it's the case authors' material);
place it next to this repo as `data-pack/` or pass its path as the first argument.
The generated `output/` from the real pack is committed, as the brief requires.

## Run it

```
python validate.py [path-to-data-pack]     # auto-finds ./data-pack or ../data-pack
python run_tests.py [path-to-data-pack]    # 37-check verification suite
```

Python 3.9+, **stdlib only** — no packages, no network, no API keys, fully deterministic.

Outputs land in `output/`:

- `job_spec.json` — one entry per SKU: normalized trade code / languages / size,
  twin classification (`new_master` / `recolor` / `reuse` / `blocked`) as it *should* be
  given the full email thread, resolved artwork (or the reason there isn't one), exact
  delivery filenames per channel, and the deadline each SKU must hit.
- `validation_report.json` — every defect, machine-readable: severity, code, message,
  evidence (which file/email says so), resolution (auto-fixed / needs client / needs internal).
- `validation_report.md` — the same, human-readable.

## Where the LLM is (and isn't)

The email thread is the one genuinely unstructured input. Its nine operative facts
(deadlines, the PET shape change, the matte switch, the late-artwork list, the reuse
policy…) were extracted **once** with LLM assistance, hand-verified, and frozen into
`email_facts.json` — each fact with its source email and an **anchor quote**.

At runtime `validate.py` re-verifies every anchor quote against `intake-emails.docx`
and aborts loudly if any quote no longer appears. That is the replay mode: the program
runs offline and deterministically, and the frozen facts cannot silently go stale if
someone swaps the thread. Everything else (CSV parsing, manifest cross-check, code/
language/size normalization, dieline graph checks, filename generation) is plain
deterministic code — exact-match validation must not hallucinate.

## Conventions chosen (the brief says pick one and state it)

- Dates: ISO `YYYY-MM-DD`; order year 2026 (thread subject "Range refresh 2026").
- Sizes: integer millilitres; `[size]` filename token is e.g. `250ml`.
- Trade codes: canonical `VLR-NNNN` upper-case; lower-cased inside filenames.
- `[range]`/`[variant]` tokens: lower-case, spaces→dashes; leading brand word dropped
  from the range ("Velora Men"→`men`) because the ecom/social patterns already carry
  `velora-`.
- Languages: ISO `EN/FR/DE/NL`; the artwork's language panels are ground truth for what
  can be rendered — CSV disagreements are normalized to the panels and flagged.
- Deadlines are channel-driven, not wave-driven: Nordmart outputs are due 2026-09-22
  (the Email 4 pull-in), every other channel 2026-10-15 (Email 1); a SKU's deadline is
  the earliest of its outputs. Wave is carried as information only — Email 1 ties early
  delivery to *retailer* reset dates, and the only retailer channel in the spec is
  Nordmart.
- Guessed identifiers never enter deliverables: sequence-inferred trade codes (e.g.
  VLR-2212 for VS-104) are reported as proposals only; the SKU stays delivery-blocked
  until the client confirms.

## What it correctly catches (verified by `run_tests.py`)

Golden checks against the real pack: the v2/v3 masterdata mismatch (evidenced by two
orphan artworks and one SKU with no artwork), missing/duplicate trade codes, the wrong
artwork reference on VS-102, the dangling base master VS-199, the recolor-of-a-recolor,
the 400ml-bottle-based-on-250ml-master dieline mismatch, the Pure Botanica PET
reclassification and matte override from the emails, the Dutch/Deutsch language trap,
size format chaos, and the Nordmart deadline pull-in. Mutation checks then fix each
defect in-memory and assert the finding disappears — a validator that flags everything
would also "catch" all defects, so both directions are tested. A clean row is asserted
to stay clean.

## Honest limits

- **It can only see what's in the files.** The v2/v3 gap is *inferred* from
  cross-check anomalies; if v3 renamed a SKU consistently everywhere, nothing would flag.
- **Artwork matching is filename-based.** It matches distinctive variant tokens
  (deliberately refusing the generic-token match that would pair "Argan Conditioner"
  with the *smooth* conditioner artwork), but it never opens the PDFs — wrong art
  inside a correctly-named file passes.
- **Hard-coded around:** the trade-code sequence inference (VLR-2212/2221/2227
  proposals) is manual analysis encoded as data, not a general algorithm; the
  known-range→code map (`hb/sr/pb/mn`) would need a new entry for a new range.
- **What would break it:** a fifth range, a trade-code scheme other than `VLR-NNNN`,
  artwork filenames not matching `velora-<range>-<tokens>-<size>.pdf`, a channel not in
  the spring spec, or a rewritten email thread (that one at least fails loudly via the
  anchor quotes rather than silently).
- The docx reading is a minimal OOXML parser (regex over `document.xml`); a manifest
  restructured into merged cells or nested tables would need `python-docx`.
