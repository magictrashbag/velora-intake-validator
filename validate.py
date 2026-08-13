#!/usr/bin/env python3
"""Velora intake validator.

Reads the three intake files (client email thread, SKU masterdata CSV, artwork
spec + delivery manifest) and produces:
  output/job_spec.json          - one validated entry per SKU
  output/validation_report.json - every defect found, machine-readable
  output/validation_report.md   - human-readable summary

Stdlib only; no network, no LLM at runtime. Email-thread facts were extracted
once (LLM-assisted, hand-verified) into email_facts.json; each fact carries an
anchor quote that this program re-verifies against intake-emails.docx on every
run, so the frozen facts cannot silently go stale.

Conventions chosen (stated per the brief):
  - Dates are ISO (YYYY-MM-DD); the order year is 2026 (from the thread subject).
  - Sizes normalize to integer millilitres; the [size] filename token is e.g. "250ml".
  - Trade codes normalize to upper-case VLR-NNNN; lower-cased inside filenames.
  - [range]/[variant] filename tokens: lower-case, spaces to dashes.
  - Languages normalize to ISO codes EN/FR/DE/NL; the artwork's language panels
    are treated as ground truth for what can be rendered.
"""

import csv
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).parent


def find_data():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    for cand in (HERE / "data-pack", HERE.parent / "data-pack", HERE.parent.parent / "Test"):
        if cand.exists():
            return cand
    sys.exit("FATAL: data pack not found - pass its path: python validate.py <path-to-data-pack>")


DATA = find_data()
OUT = HERE / "output"

RANGE_CODES = {"Hydra Boost": "hb", "Silk Repair": "sr", "Pure Botanica": "pb", "Velora Men": "mn"}
LANG_MAP = {"en": "EN", "english": "EN", "fr": "FR", "french": "FR",
            "de": "DE", "german": "DE", "deutsch": "DE", "nl": "NL", "dutch": "NL"}
CHANNEL_ORDER = ["nordmart", "ecom", "social"]


# ---------------------------------------------------------------- file readers

def docx_paragraphs(path):
    """Extract paragraph text from a .docx (stdlib only)."""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    paras = []
    for p in re.finditer(r"<w:p\b.*?</w:p>", xml, re.S):
        text = "".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", p.group(0), re.S))
        text = (text.replace("&amp;", "&").replace("&lt;", "<")
                    .replace("&gt;", ">").replace("&quot;", '"'))
        paras.append(text)
    return paras


def docx_tables(path):
    """Extract tables from a .docx as lists of rows of cell strings."""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    tables = []
    for tbl in re.finditer(r"<w:tbl\b.*?</w:tbl>", xml, re.S):
        rows = []
        for tr in re.finditer(r"<w:tr\b.*?</w:tr>", tbl.group(0), re.S):
            cells = []
            for tc in re.finditer(r"<w:tc\b.*?</w:tc>", tr.group(0), re.S):
                cells.append("".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", tc.group(0), re.S)).strip())
            rows.append(cells)
        tables.append(rows)
    return tables


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


# ---------------------------------------------------------------- email facts

def load_email_facts(emails_docx):
    """Load frozen email facts; abort loudly if any anchor quote no longer
    appears in the thread (guards against the thread changing under us)."""
    facts_doc = json.loads((HERE / "email_facts.json").read_text(encoding="utf-8"))
    thread_text = " ".join(docx_paragraphs(emails_docx))
    thread_text = re.sub(r"\s+", " ", thread_text)
    stale = []
    for name, fact in facts_doc["facts"].items():
        quote = re.sub(r"\s+", " ", fact["anchor_quote"])
        if quote.lower() not in thread_text.lower():
            stale.append(f"{name}: anchor quote not found: {quote!r}")
    if stale:
        sys.exit("FATAL: email_facts.json is stale vs intake-emails.docx:\n  " + "\n  ".join(stale)
                 + "\nRe-extract the email facts before trusting this run.")
    return {k: v["value"] for k, v in facts_doc["facts"].items()}, facts_doc["facts"]


# ---------------------------------------------------------------- manifest

def load_manifest(artwork_docx, late_files, late_eta):
    """Parse the artwork delivery manifest table + the announced late files."""
    manifest = {}
    for rows in docx_tables(artwork_docx):
        if not rows or "Filename" not in rows[0]:
            continue
        if "Dieline" not in rows[0]:
            continue  # channel-spec property tables, not the manifest
        idx = {name: i for i, name in enumerate(rows[0])}
        for r in rows[1:]:
            if len(r) < len(rows[0]):
                continue
            fn = r[idx["Filename"]].strip()
            if not fn:
                continue
            panels = [LANG_MAP.get(t.strip().lower(), t.strip().upper())
                      for t in re.split(r"[/,]", r[idx["Language panels"]]) if t.strip()]
            manifest[fn] = {"dieline": r[idx["Dieline"]].strip(),
                            "panels": panels,
                            "finish": r[idx["Finish plate"]].strip(),
                            "status": "available", "eta": None}
    for fn in late_files:
        manifest[fn] = {"dieline": None, "panels": None, "finish": None,
                        "status": "pending", "eta": late_eta}
    return manifest


def parse_artwork_filename(fn):
    m = re.match(r"velora-([a-z]{2})-(.+?)-(\d+)(?:-([a-z]+))?\.pdf$", fn)
    if not m:
        return None
    return {"range_code": m.group(1), "tokens": set(m.group(2).split("-")),
            "size": int(m.group(3)), "suffix": m.group(4)}


# ---------------------------------------------------------------- normalizers

def norm_trade_code(raw):
    raw = (raw or "").strip().upper()
    if not raw:
        return None, None
    m = re.match(r"^VLR-?(\d{4})$", raw)
    if m:
        return f"VLR-{m.group(1)}", None
    return None, f"unparseable trade code {raw!r}"


def norm_languages(raw):
    """Return (codes, note). Flags the Dutch/Deutsch trap for human eyes."""
    raw = (raw or "").strip()
    if not raw:
        return [], None
    tokens = [t for t in re.split(r"[,/;+\-\s]+", raw) if t]
    codes, unknown = [], []
    for t in tokens:
        c = LANG_MAP.get(t.lower())
        (codes if c else unknown).append(c or t)
    note = None
    if any(t.lower() == "dutch" for t in tokens):
        note = ("source says 'Dutch' - ambiguous: German (Deutsch) mistyped, or a genuine "
                "NL requirement the artwork does not carry (NL panels exist elsewhere in "
                "this range) - two different defects with two different owners")
    if unknown:
        note = (note + "; " if note else "") + f"unrecognized language tokens {unknown}"
    return list(dict.fromkeys(codes)), note


def norm_size(size_raw, unit_raw):
    """Normalize to integer ml. Returns (ml, note)."""
    s, u = (size_raw or "").strip().lower(), (unit_raw or "").strip().lower()
    note = None
    m = re.match(r"^([\d.]+)\s*(ml|l)?$", s)
    if not m:
        return None, f"unparseable size {size_raw!r}"
    val, embedded = float(m.group(1)), m.group(2)
    unit = embedded or u or "ml"
    if embedded and not u:
        note = f"unit embedded in size field ({size_raw!r})"
    if unit == "l":
        val *= 1000
        note = f"converted {size_raw} {unit_raw or ''} to {int(val)}ml".strip()
    return int(val), note


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


# ---------------------------------------------------------------- validation

class Report:
    def __init__(self):
        self.global_defects = []
        self.sku_defects = {}

    def add(self, sku, severity, code, message, evidence=None, resolution=None):
        d = {"severity": severity, "code": code, "message": message,
             "evidence": evidence, "resolution": resolution}
        if sku is None:
            self.global_defects.append(d)
        else:
            self.sku_defects.setdefault(sku, []).append(d)


GENERIC_TOKENS = {"body", "lotion", "cream", "deo", "spray", "shampoo", "conditioner"}


def resolve_artwork(row, size_ml, manifest):
    """Match a SKU to its manifest artwork by range code + size + variant tokens.

    A match requires at least one DISTINCTIVE variant token (e.g. 'citrus',
    'argan') - generic category words ('conditioner', 'spray') only break ties.
    This is what stops 'Argan Conditioner' from hallucinating a match onto
    velora-sr-conditioner-smooth-300.pdf. If no distinctive token matches, the
    CSV's own filename is accepted only if it literally exists for the right
    range and size. Returns (filename or None, how_matched)."""
    rc = RANGE_CODES.get(row["range"])
    tokens = set(slug(row["variant"]).split("-"))
    distinctive, generic = tokens - GENERIC_TOKENS, tokens & GENERIC_TOKENS
    csv_fn = (row["artwork_file"] or "").strip()
    best, best_score = None, (0, 0, 0)
    for fn in manifest:
        p = parse_artwork_filename(fn)
        if not p or p["range_code"] != rc or (size_ml and p["size"] != size_ml):
            continue
        score = (len(distinctive & p["tokens"]), len(generic & p["tokens"]), int(fn == csv_fn))
        if score[0] > 0 and score > best_score:
            best, best_score = fn, score
    if best:
        return best, "variant_match"
    if csv_fn in manifest:
        p = parse_artwork_filename(csv_fn)
        if p and p["range_code"] == rc and (not size_ml or p["size"] == size_ml):
            return csv_fn, "csv_filename_only"
    return None, "none"


def build_outputs(trade_code, size_ml, range_name, variant, channels, nordmart_deadline, global_deadline):
    if not trade_code:
        return [{"channel": ch, "filename": None,
                 "deadline": nordmart_deadline if ch == "nordmart" else global_deadline,
                 "reason": "no valid unique trade code - filename cannot be generated"}
                for ch in CHANNEL_ORDER if ch in channels]
    # [range] token: brand word dropped when the range itself starts with it
    # ("Velora Men" -> "men"), else the ecom/social patterns would read
    # "...-velora-velora-men-..." - the pattern already carries "velora-".
    range_token = re.sub(r"^velora-", "", slug(range_name))
    t, r, v, s = trade_code.lower(), range_token, slug(variant), f"{size_ml}ml"
    spec = {
        "nordmart": (f"{t}_{s}_nordmart.jpg", "JPG 2000x2000 sRGB, white bg", nordmart_deadline),
        "ecom": (f"{t}-velora-{r}-{v}-{s}-packshot.tif", "Layered TIFF 4000x4000, transparent bg", global_deadline),
        "social": (f"{t}-velora-{r}-{v}-social.png", "PNG 1080x1350, range bg color", global_deadline),
    }
    return [{"channel": ch, "filename": spec[ch][0], "format": spec[ch][1], "deadline": spec[ch][2]}
            for ch in CHANNEL_ORDER if ch in channels]


def validate(rows, manifest, facts):
    rep = Report()
    nordmart_dl = facts["nordmart_deadline"]
    global_dl = facts["global_deadline"]
    late_eta = facts["late_artworks"]["eta"]
    by_id = {r["sku_id"]: r for r in rows}

    # --- global: masterdata version mismatch (v2 export vs v3 sent) ----------
    rep.add(None, "blocker", "MASTERDATA_VERSION",
            f"CSV is the spring 'v2' export but the client attached {facts['masterdata_version_sent']} "
            "(Email 1). SKU list may be stale - see orphan-artwork and missing-artwork defects "
            "for concrete evidence of a delta.",
            evidence="brief: 'labeled v2 in our system'; Email 1: masterdata_v3.xlsx",
            resolution="request v3 from client; validator reconciles CSV vs manifest meanwhile")

    rep.add(None, "info", "VIDEO_SCOPE_REQUEST",
            "Email 2 asks for e-commerce videos for 'hero SKUs' - undefined scope, no SKUs flagged "
            "as hero, no video spec in the pack.",
            evidence="Email 2 (Tomas)",
            resolution="route to account team as separate scope/quote; does not gate packshots")

    # --- duplicate trade codes ----------------------------------------------
    seen = {}
    for r in rows:
        code, err = norm_trade_code(r["trade_code"])
        r["_trade"] = code
        if err:
            rep.add(r["sku_id"], "blocker", "TRADE_CODE_INVALID", err, evidence=f"CSV {r['sku_id']}")
        if code:
            seen.setdefault(code, []).append(r["sku_id"])
    for code, ids in seen.items():
        if len(ids) > 1:
            for sid in ids[1:]:  # first claimant keeps it; later ones are the anomaly
                rep.add(sid, "blocker", "TRADE_CODE_DUPLICATE",
                        f"trade code {code} already used by {ids[0]} - delivery filenames would collide; "
                        "sequence inference suggests VLR-2221 for VS-112 (Silk Repair runs 2216-2223 "
                        "with 2221 unused) but a guessed code must not reach deliverables",
                        evidence=f"CSV: {', '.join(ids)} share {code}",
                        resolution="needs_client: confirm correct code")
                by_id[sid]["_trade"] = None
                by_id[sid]["_trade_conflict"] = code

    entries = []
    claimed_artworks = set()
    for r in rows:
        sid = r["sku_id"]
        defects = rep.sku_defects.setdefault(sid, [])

        # trade code
        trade = r.get("_trade")
        proposed = None
        if trade is None and not r.get("_trade_conflict"):
            if not (r["trade_code"] or "").strip():
                proposed = {"VS-104": "VLR-2212", "VS-118": "VLR-2227"}.get(sid)
                rep.add(sid, "blocker", "TRADE_CODE_MISSING",
                        "no trade code - every delivery filename derives from it; twin production can "
                        "proceed but nothing can be named or delivered"
                        + (f"; sequence inference suggests {proposed} (report-only, not applied)" if proposed else ""),
                        evidence=f"CSV {sid}: empty trade_code",
                        resolution="needs_client: confirm code")
        elif r.get("_trade_conflict"):
            proposed = {"VS-112": "VLR-2221"}.get(sid)

        # size + languages
        size_ml, size_note = norm_size(r["size"], r["size_unit"])
        if size_note:
            rep.add(sid, "info", "SIZE_FORMAT", size_note,
                    evidence=f"CSV {sid}: size={r['size']!r} unit={r['size_unit']!r}",
                    resolution=f"auto_fixed: normalized to {size_ml}ml")
        langs, lang_note = norm_languages(r["languages"])

        # artwork resolution
        art_file, how = resolve_artwork(r, size_ml, manifest)
        csv_art = (r["artwork_file"] or "").strip()
        art_status, art_eta, art_info = "missing", None, None
        if art_file:
            claimed_artworks.add(art_file)
            art_info = manifest[art_file]
            art_status, art_eta = art_info["status"], art_info["eta"]
            if csv_art and csv_art != art_file:
                rep.add(sid, "warning", "ARTWORK_REF_MISMATCH",
                        f"CSV points at {csv_art} but variant '{r['variant']}' matches {art_file}",
                        evidence="distinctive variant-token match vs manifest",
                        resolution=f"auto_fixed: using {art_file}; flagged for client confirm")
            if how == "csv_filename_only":
                rep.add(sid, "info", "ARTWORK_WEAK_MATCH",
                        f"no variant token links '{r['variant']}' to {art_file}; accepted only because "
                        "the CSV filename literally exists for this range and size",
                        evidence="filename-only match", resolution="worth a human glance")
            if art_status == "pending":
                rep.add(sid, "warning", "ARTWORK_PENDING",
                        f"artwork {art_file} not on the drive yet; StudioPack ETA {art_eta}",
                        evidence="Email 3 (Lea): late-artwork list",
                        resolution="watch drive; escalate if not delivered by ETA")
        else:
            rep.add(sid, "blocker", "ARTWORK_MISSING",
                    f"no artwork on the StudioPack drive matches this SKU (CSV says {csv_art or 'nothing'}); "
                    "it is also not in the announced late list",
                    evidence="manifest (artwork-spec.docx) + Email 3 late list",
                    resolution="needs_client: ask Sanne/Lea whether this SKU is still in scope (see v3 mismatch)")

        # languages vs artwork panels (artwork = renderable ground truth)
        panels = (art_info or {}).get("panels")
        if panels:
            if not langs:
                rep.add(sid, "warning", "LANGUAGES_MISSING",
                        f"CSV has no languages; artwork carries panels {'/'.join(panels)}",
                        evidence=f"CSV {sid} vs manifest {art_file}",
                        resolution=f"auto_fixed: using artwork panels {'/'.join(panels)}")
                langs = panels
            elif set(langs) != set(panels):
                rep.add(sid, "warning", "LANGUAGE_MISMATCH",
                        f"CSV languages {','.join(langs)} vs artwork panels {'/'.join(panels)}"
                        + (f" ({lang_note})" if lang_note else ""),
                        evidence=f"CSV {sid} vs manifest {art_file}",
                        resolution=f"auto_fixed: using artwork panels {'/'.join(panels)}; flagged for client confirm")
                langs = panels
        elif lang_note:
            rep.add(sid, "warning", "LANGUAGE_FORMAT", lang_note,
                    evidence=f"CSV {sid}: languages={r['languages']!r}", resolution="normalized")

        # finish
        finish = (r["label_finish"] or "").strip()
        if r["range"] == "Pure Botanica":
            if finish.lower() != "matte":
                rep.add(sid, "warning", "FINISH_OVERRIDE_EMAIL",
                        f"CSV/manifest say {finish or 'nothing'} but Pure Botanica switched to matte "
                        "after the sustainability review",
                        evidence="Email 3 (Lea): gloss to matte, dielines unchanged",
                        resolution="auto_fixed: finish=matte")
            finish = "matte"
        elif art_info and art_info.get("finish") and finish.lower() not in (art_info["finish"].lower(), ""):
            if slug(finish) != slug(art_info["finish"]):
                rep.add(sid, "info", "FINISH_MISMATCH",
                        f"CSV finish {finish!r} vs artwork finish plate {art_info['finish']!r}",
                        evidence=f"CSV {sid} vs manifest {art_file}",
                        resolution=f"auto_fixed: using artwork finish plate {art_info['finish']!r}")
            finish = art_info["finish"]
        elif art_info and art_info.get("finish") and not finish:
            finish = art_info["finish"]
        elif finish.upper() == "TBD" or finish.lower() == "none":
            base_range_finish = {"Silk Repair": "gloss + foil accent"}.get(r["range"])
            if base_range_finish:
                rep.add(sid, "info", "FINISH_MISMATCH",
                        f"CSV finish {finish!r}; range artworks carry 'gloss + foil accent'",
                        evidence="manifest: all Silk Repair rows",
                        resolution="auto_fixed: using gloss + foil accent")
                finish = base_range_finish

        r.update(_size_ml=size_ml, _langs=langs, _finish=finish, _artwork=art_file,
                 _art_status=art_status, _art_eta=art_eta, _proposed=proposed)

    # --- twin classification + base-master graph (needs all rows resolved) ---
    for r in rows:
        sid = r["sku_id"]
        action = (r["twin_action"] or "").strip()
        base = (r["base_master"] or "").strip() or None
        classification, rationale = None, []

        my_dieline = (manifest.get(r["_artwork"]) or {}).get("dieline")

        if r["range"] == "Pure Botanica":
            if action in ("existing_master", "new_master") or (base and by_id.get(base, {}).get("range") != "Pure Botanica"):
                pass
            base_dieline = (manifest.get(by_id.get(base, {}).get("_artwork")) or {}).get("dieline")
            # an unknown dieline (late artwork) is NOT a mismatch - Email 3 says
            # dielines are unchanged, so a pending recolor stays a recolor
            if action == "existing_master" or (action == "recolor" and base and
                                               my_dieline and base_dieline and base_dieline != my_dieline):
                # master itself, or recolor whose base has a different dieline
                classification = "new_master"
                base = None
                rationale.append("Pure Botanica moved to the recycled-PET bottle - shape changed, old "
                                 "geometry must not be reused (Email 2)")
                rep.add(sid, "warning", "SHAPE_CHANGE_RECLASS",
                        f"CSV says {action} but the PET bottle change forces a new master"
                        + ("" if action == "existing_master" else f" (base {r['base_master']} is a different dieline anyway)"),
                        evidence="Email 2 (Tomas): 'the shape is different'",
                        resolution="auto_fixed: classification=new_master; client confirm requested (cost impact)")
            else:
                classification = "recolor"
                rationale.append("recolor of the rebuilt PET master (dependency: master must be rebuilt first)")
                rep.add(sid, "info", "MASTER_DEPENDENCY",
                        f"base master {base} is itself being rebuilt for the PET shape change",
                        evidence="Email 2", resolution="sequence: master first")

        elif action == "existing_master":
            classification = "recolor"
            rationale.append("geometry reused from the spring twin; new refresh artwork must still be "
                             "preprocessed and mapped (artwork refresh). Pure 'reuse' only if client "
                             "confirms the artwork is unchanged (Email 4 reuse request honored at "
                             "geometry level)")
            base = f"spring:{sid}"

        elif action == "new_master":
            classification = "new_master"
            rationale.append("declared new master in masterdata")

        elif action == "recolor":
            classification = "recolor"
            if base and base not in by_id:
                cands = [x["sku_id"] for x in rows
                         if x["range"] == r["range"] and x["_size_ml"] == r["_size_ml"]
                         and (x["twin_action"] or "").strip() in ("new_master", "existing_master")]
                if len(cands) == 1:
                    rep.add(sid, "warning", "BASE_MASTER_DANGLING",
                            f"base_master {base} does not exist in the SKU list; {cands[0]} is the only "
                            f"{r['range']} {r['_size_ml']}ml master",
                            evidence=f"CSV {sid}: base_master={base}",
                            resolution=f"auto_fixed: re-parented to {cands[0]}")
                    base = cands[0]
                else:
                    rep.add(sid, "blocker", "BASE_MASTER_DANGLING",
                            f"base_master {base} does not exist and no unique candidate found",
                            evidence=f"CSV {sid}", resolution="needs_internal")
                    classification = "blocked"
            if base in by_id and (by_id[base]["twin_action"] or "").strip() == "recolor":
                root = base
                hops = 0
                while root in by_id and (by_id[root]["twin_action"] or "").strip() == "recolor" and hops < 10:
                    root = (by_id[root]["base_master"] or "").strip()
                    hops += 1
                rep.add(sid, "warning", "BASE_MASTER_IS_RECOLOR",
                        f"base_master {base} is itself a recolor; geometry root is {root}",
                        evidence=f"CSV {sid}: {base} has twin_action=recolor",
                        resolution=f"auto_fixed: re-parented to {root}")
                base = root
            base_dieline = (manifest.get(by_id.get(base, {}).get("_artwork")) or {}).get("dieline")
            if my_dieline and base_dieline and my_dieline != base_dieline:
                rep.add(sid, "warning", "BASE_DIELINE_MISMATCH",
                        f"this SKU's artwork is on dieline {my_dieline} but base {base} is on "
                        f"{base_dieline} - geometry cannot be reused from that master",
                        evidence=f"manifest dielines for {r['_artwork']} vs {by_id[base]['_artwork']}",
                        resolution="needs_internal: check the spring twin library for a matching-dieline "
                                   "master; fallback = new master (+~25h)")
                base = None
                rationale.append("base master invalid (different dieline); awaiting internal library check")

        # physics check, independent of dielines: a recolor must live in the same
        # container as its master - a 250ml bottle does not hold 400ml. The dieline
        # comparison catches this when both dielines are known; this catches it
        # when one artwork is still pending and the dieline is unknown.
        if classification == "recolor" and base in by_id:
            base_ml = by_id[base].get("_size_ml")
            already = any(d["code"] == "BASE_DIELINE_MISMATCH"
                          for d in rep.sku_defects.get(sid, []))
            if base_ml and r["_size_ml"] and base_ml != r["_size_ml"] and not already:
                rep.add(sid, "warning", "BASE_SIZE_MISMATCH",
                        f"{r['_size_ml']}ml SKU claims {base} ({base_ml}ml) as base master - "
                        "different container, geometry cannot be reused",
                        evidence=f"CSV sizes: {sid}={r['_size_ml']}ml vs {base}={base_ml}ml",
                        resolution="needs_internal: locate or build the correct-size master")
                base = None
                rationale.append("base master invalid (different container size)")

        # a new master with late artwork can still start geometry IF a sibling
        # artwork (same range + container size) reveals the dieline; without one
        # there is nothing to model from and the dieline itself becomes the ask
        if classification == "new_master" and r["_art_status"] == "pending":
            sib_dieline = next((manifest[x["_artwork"]]["dieline"] for x in rows
                                if x is not r and x["range"] == r["range"]
                                and x["_size_ml"] == r["_size_ml"] and x["_artwork"]
                                and (manifest.get(x["_artwork"]) or {}).get("dieline")), None)
            if sib_dieline:
                rep.add(sid, "info", "GEOMETRY_CAN_START",
                        f"master artwork is late but sibling artworks share dieline {sib_dieline} - "
                        "geometry can start now; only label mapping waits for the file",
                        evidence="manifest: same range+size artworks on the drive",
                        resolution="sequence: start geometry now")
            else:
                rep.add(sid, "warning", "DIELINE_UNKNOWN",
                        "master artwork is late and no artwork on the drive shares this range+size - "
                        "there is no dieline to start geometry from",
                        evidence="manifest has no matching range+size row",
                        resolution="needs_client: ask StudioPack for the dieline now, ahead of the artwork")

        if r["_art_status"] == "missing":
            classification = "blocked"
            rationale.append("no artwork exists for this SKU on the drive or in the late list")

        # deadlines / channels
        channels = [c.strip().lower() for c in (r["channels"] or "").split(",") if c.strip()]

        # dependency notes: recolor of a master whose artwork is late
        if classification == "recolor" and base in by_id and by_id[base]["_art_status"] == "pending":
            sev = "warning" if "nordmart" in channels else "info"
            rep.add(sid, sev, "MASTER_DEPENDENCY",
                    f"base master {base}'s artwork arrives ~{by_id[base]['_art_eta']}; master geometry "
                    "can start now from the range dieline, mapping waits for artwork"
                    + (f" - tight against the Nordmart deadline {nordmart_dl}" if sev == "warning" else ""),
                    evidence="Email 3 late list + Email 4 deadline pull-in",
                    resolution="sequence: start geometry now")
        outputs = build_outputs(r["_trade"], r["_size_ml"], r["range"], r["variant"],
                                channels, facts["nordmart_deadline"], facts["global_deadline"])
        deadline = min((o["deadline"] for o in outputs if o.get("deadline")), default=global_dl)

        if "nordmart" in channels and r["_art_status"] == "pending":
            rep.add(sid, "warning", "SCHEDULE_RISK_NORDMART",
                    f"Nordmart deadline {nordmart_dl} but artwork lands ~{late_eta} - "
                    "17 days for master/mapping/QC/outputs",
                    evidence="Email 4 (deadline pull-in) + Email 3 (late artwork)",
                    resolution="start geometry from dieline now; escalate on any ETA slip")

        delivery_blocked = r["_trade"] is None
        status = ("blocked" if classification == "blocked"
                  else "blocked_delivery_naming" if delivery_blocked
                  else "pending_artwork" if r["_art_status"] == "pending"
                  else "ready")

        entries.append({
            "sku_id": sid,
            "trade_code": r["_trade"],
            "proposed_trade_code": r["_proposed"],
            "range": r["range"], "variant": r["variant"],
            "size_ml": r["_size_ml"],
            "languages": r["_langs"],
            "label_finish": r["_finish"],
            "wave": int(r["launch_wave"]) if (r["launch_wave"] or "").strip().isdigit() else r["launch_wave"],
            "twin": {"classification": classification, "base_master": base,
                     "rationale": "; ".join(rationale) or "as declared in masterdata"},
            "artwork": {"file": r["_artwork"], "status": r["_art_status"], "eta": r["_art_eta"],
                        "csv_reference": (r["artwork_file"] or "").strip() or None},
            "channels": channels,
            "outputs": outputs,
            "deadline": deadline,
            "status": status,
        })

    # --- orphan artworks (manifest files no SKU claims) ----------------------
    for fn in sorted(set(manifest) - claimed_artworks):
        rep.add(None, "warning", "ORPHAN_ARTWORK",
                f"artwork {fn} is on the StudioPack drive but matches no SKU in the CSV - "
                "likely a SKU that exists in masterdata v3 but not in our v2 export",
                evidence="manifest vs CSV cross-check",
                resolution="needs_client: confirm scope with the v3 file")

    # drop empty defect lists
    rep.sku_defects = {k: v for k, v in rep.sku_defects.items() if v}
    return entries, rep


# ---------------------------------------------------------------- reporting

def summarize(entries, rep):
    sev_rank = {"blocker": 0, "warning": 1, "info": 2}
    counts = {"blocker": 0, "warning": 0, "info": 0}
    for defs in [rep.global_defects] + list(rep.sku_defects.values()):
        for d in defs:
            counts[d["severity"]] += 1
    lines = ["# Velora intake validation report", "",
             f"SKUs: {len(entries)} | blockers: {counts['blocker']} | "
             f"warnings: {counts['warning']} | info: {counts['info']}", "",
             "## Order-level", ""]
    for d in sorted(rep.global_defects, key=lambda d: sev_rank[d["severity"]]):
        lines.append(f"- **[{d['severity'].upper()}] {d['code']}** - {d['message']}")
    lines += ["", "## Per SKU", ""]
    for e in entries:
        defs = rep.sku_defects.get(e["sku_id"], [])
        flag = {"blocked": "BLOCKED", "blocked_delivery_naming": "BLOCKED (naming)",
                "pending_artwork": "pending artwork", "ready": "ready"}[e["status"]]
        lines.append(f"### {e['sku_id']} - {e['range']} {e['variant']} - "
                     f"{e['twin']['classification']} - {flag} - due {e['deadline']}")
        if not defs:
            lines.append("- clean")
        for d in sorted(defs, key=lambda d: sev_rank[d["severity"]]):
            res = f" -> {d['resolution']}" if d["resolution"] else ""
            lines.append(f"- [{d['severity']}] {d['code']}: {d['message']}{res}")
        lines.append("")
    return "\n".join(lines), counts


def main():
    emails = DATA / "intake-emails.docx"
    csv_path = DATA / "velora-skus.csv"
    artwork = DATA / "artwork-spec.docx"
    for p in (emails, csv_path, artwork):
        if not p.exists():
            sys.exit(f"FATAL: input not found: {p}")

    facts, facts_full = load_email_facts(emails)
    manifest = load_manifest(artwork, facts["late_artworks"]["files"], facts["late_artworks"]["eta"])
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("sku_id") or "").strip()]

    entries, rep = validate(rows, manifest, facts)
    md, counts = summarize(entries, rep)

    OUT.mkdir(exist_ok=True)
    provenance = {
        "inputs": {p.name: sha256(p) for p in (emails, csv_path, artwork)},
        "email_facts": facts_full,
        "conventions": {
            "dates": "ISO YYYY-MM-DD, order year 2026",
            "size_token": "integer millilitres + 'ml' (e.g. 250ml)",
            "trade_code": "VLR-NNNN upper-case canonical, lower-cased in filenames",
            "filename_tokens": "lower-case, spaces to dashes",
            "language_ground_truth": "artwork language panels win over CSV",
            "deadline_model": "channel-driven, not wave-driven: nordmart outputs due "
                              "2026-09-22 (Email 4 pull-in), all other channels 2026-10-15 "
                              "(Email 1); SKU deadline = earliest of its outputs. Wave is "
                              "carried as information only - Email 1 ties early dates to "
                              "RETAILER reset dates, and the only retailer channel is Nordmart",
        },
    }
    (OUT / "job_spec.json").write_text(
        json.dumps({"provenance": provenance, "skus": entries}, indent=2), encoding="utf-8")
    (OUT / "validation_report.json").write_text(
        json.dumps({"provenance": provenance["inputs"], "counts": counts,
                    "order_level": rep.global_defects, "per_sku": rep.sku_defects}, indent=2),
        encoding="utf-8")
    (OUT / "validation_report.md").write_text(md, encoding="utf-8")

    ready = sum(1 for e in entries if e["status"] in ("ready", "pending_artwork"))
    print(f"Validated {len(entries)} SKUs -> {ready} can enter production, "
          f"{len(entries) - ready} blocked. "
          f"Defects: {counts['blocker']} blockers, {counts['warning']} warnings, {counts['info']} info.")
    print(f"Outputs in {OUT}")


if __name__ == "__main__":
    main()
