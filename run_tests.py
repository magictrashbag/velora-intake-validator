#!/usr/bin/env python3
"""Verification for the Velora intake validator (stdlib only, no framework).

Two layers:
  1. Golden checks against the real data pack: every defect we identified by
     hand-auditing the three files must be caught, with the right resolution.
  2. Mutation checks: fix a defect in-memory and assert the finding disappears
     (guards against a validator that flags everything, which would also "catch"
     all defects).

Run:  python run_tests.py [path-to-data-pack]
"""

import copy
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import validate as V

DATA = Path(sys.argv[1]) if len(sys.argv) > 1 else V.DATA

PASS = 0


def check(name, cond, detail=""):
    global PASS
    status = "ok" if cond else "FAIL"
    print(f"  [{status}] {name}" + (f" - {detail}" if detail and not cond else ""))
    if cond:
        PASS += 1
    else:
        raise SystemExit(f"FAILED: {name} {detail}")


def load():
    facts, _ = V.load_email_facts(DATA / "intake-emails.docx")
    manifest = V.load_manifest(DATA / "artwork-spec.docx",
                               facts["late_artworks"]["files"], facts["late_artworks"]["eta"])
    with open(DATA / "velora-skus.csv", newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("sku_id") or "").strip()]
    return rows, manifest, facts


def codes(rep, sku):
    return {d["code"] for d in rep.sku_defects.get(sku, [])}


def entry(entries, sku):
    return next(e for e in entries if e["sku_id"] == sku)


rows, manifest, facts = load()
entries, rep = V.validate(copy.deepcopy(rows), manifest, facts)
gcodes = {d["code"] for d in rep.global_defects}

print("Golden checks (real data pack):")
check("24 SKUs in, 24 entries out", len(entries) == 24)
check("email anchor quotes verified (load_email_facts did not abort)", True)
check("manifest parsed: 22 rows + 3 late", len(manifest) == 25, str(len(manifest)))

# the traps, one by one
check("masterdata v2/v3 mismatch raised", "MASTERDATA_VERSION" in gcodes)
check("orphan artworks found (travel + handcream)",
      sum(d["code"] == "ORPHAN_ARTWORK" for d in rep.global_defects) == 2)
check("VS-104 missing trade code", "TRADE_CODE_MISSING" in codes(rep, "VS-104"))
check("VS-118 missing trade code", "TRADE_CODE_MISSING" in codes(rep, "VS-118"))
check("VS-112 duplicate trade code vs VS-103", "TRADE_CODE_DUPLICATE" in codes(rep, "VS-112"))
check("VS-103 keeps VLR-2214", entry(entries, "VS-103")["trade_code"] == "VLR-2214")
check("VS-113 blocked: argan artwork nowhere", entry(entries, "VS-113")["status"] == "blocked"
      and "ARTWORK_MISSING" in codes(rep, "VS-113"))
check("VS-113 NOT fuzzy-matched to another conditioner artwork",
      entry(entries, "VS-113")["artwork"]["file"] is None)
check("VS-102 wrong artwork ref auto-fixed to citrus",
      entry(entries, "VS-102")["artwork"]["file"] == "velora-hb-citrus-250.pdf"
      and "ARTWORK_REF_MISMATCH" in codes(rep, "VS-102"))
check("VS-121 dangling base VS-199 re-parented to VS-120",
      entry(entries, "VS-121")["twin"]["base_master"] == "VS-120")
check("VS-110 recolor-of-recolor re-parented to root VS-107",
      entry(entries, "VS-110")["twin"]["base_master"] == "VS-107")
check("VS-105 dieline mismatch caught (400 bottle vs 250 master)",
      "BASE_DIELINE_MISMATCH" in codes(rep, "VS-105"))
check("all 5 Pure Botanica SKUs forced to matte",
      all(e["label_finish"] == "matte" for e in entries if e["range"] == "Pure Botanica"))
check("PB masters reclassified new_master (PET shape change)",
      entry(entries, "VS-115")["twin"]["classification"] == "new_master"
      and entry(entries, "VS-116")["twin"]["classification"] == "new_master")
check("VS-119 stays a recolor of VS-115 (late artwork is not a dieline mismatch)",
      entry(entries, "VS-119")["twin"]["classification"] == "recolor"
      and entry(entries, "VS-119")["twin"]["base_master"] == "VS-115")
check("exactly 4 new masters on the order",
      sorted(e["sku_id"] for e in entries if e["twin"]["classification"] == "new_master")
      == ["VS-115", "VS-116", "VS-120", "VS-124"])
check("VS-108 'Dutch' ambiguity flagged, rendering resolved to artwork panels",
      "LANGUAGE_MISMATCH" in codes(rep, "VS-108")
      and entry(entries, "VS-108")["languages"] == ["EN", "FR", "DE"]
      and "ambiguous" in next(d["message"] for d in rep.sku_defects["VS-108"]
                              if d["code"] == "LANGUAGE_MISMATCH"))
check("VS-105 size 0.4 L normalized to 400ml", entry(entries, "VS-105")["size_ml"] == 400)
check("VS-116 '400ml' in size column normalized", entry(entries, "VS-116")["size_ml"] == 400)
check("nordmart deadline pulled in to 2026-09-22",
      entry(entries, "VS-101")["deadline"] == "2026-09-22")
check("non-nordmart SKU keeps 2026-10-15", entry(entries, "VS-107")["deadline"] == "2026-10-15")
check("VS-119 nordmart + late artwork schedule risk",
      "SCHEDULE_RISK_NORDMART" in codes(rep, "VS-119"))
check("nordmart filename convention", entry(entries, "VS-101")["outputs"][0]["filename"]
      == "vlr-2210_250ml_nordmart.jpg")
check("no double 'velora' in Velora Men filenames",
      "velora-velora" not in entry(entries, "VS-121")["outputs"][0]["filename"])
check("blocked-naming SKU still carries its nordmart deadline",
      entry(entries, "VS-104")["deadline"] == "2026-09-22")

print("\nMutation checks (fix the defect -> finding must disappear):")


def mutate(sku_id, **changes):
    rs = copy.deepcopy(rows)
    for r in rs:
        if r["sku_id"] == sku_id:
            r.update(changes)
    return V.validate(rs, manifest, facts)


e2, r2 = mutate("VS-104", trade_code="VLR-2212")
check("VS-104 with a trade code -> no TRADE_CODE_MISSING, gets filenames",
      "TRADE_CODE_MISSING" not in codes(r2, "VS-104")
      and entry(e2, "VS-104")["outputs"][0]["filename"] == "vlr-2212_250ml_nordmart.jpg")

e2, r2 = mutate("VS-102", artwork_file="velora-hb-citrus-250.pdf")
check("VS-102 with correct artwork ref -> no ARTWORK_REF_MISMATCH",
      "ARTWORK_REF_MISMATCH" not in codes(r2, "VS-102"))

e2, r2 = mutate("VS-121", base_master="VS-120")
check("VS-121 with correct base -> no BASE_MASTER_DANGLING",
      "BASE_MASTER_DANGLING" not in codes(r2, "VS-121"))

e2, r2 = mutate("VS-108", languages="EN,FR,DE")
check("VS-108 with clean languages -> no LANGUAGE_MISMATCH",
      "LANGUAGE_MISMATCH" not in codes(r2, "VS-108"))

# a clean row must stay clean (validator must not cry wolf)
_, r2 = mutate("VS-101")  # no changes
check("VS-101 stays defect-free", not codes(r2, "VS-101"))

print("\nInvariant + hardening checks:")
# physics invariant over the whole spec: no recolor spans container sizes
by_id = {e["sku_id"]: e for e in entries}
check("no recolor silently spans container sizes",
      all(by_id[e["twin"]["base_master"]]["size_ml"] == e["size_ml"]
          for e in entries if e["twin"]["classification"] == "recolor"
          and e["twin"]["base_master"] in by_id))
# cross-size recolor whose base has UNKNOWN dieline (late artwork) must still be
# caught - the dieline check can't run, the size check must (a 150ml spray is
# not a variant of a 50ml stick)
e2, r2 = mutate("VS-121", base_master="VS-124")
check("cross-size base with unknown dieline caught by size check",
      "BASE_SIZE_MISMATCH" in codes(r2, "VS-121")
      and entry(e2, "VS-121")["twin"]["base_master"] is None)
# late-master distinction: VS-120 can start geometry (sibling dieline DL-MN-150
# on the drive), VS-124 cannot (no artwork anywhere shares 50ml Velora Men)
check("VS-120: geometry can start from sibling dieline",
      "GEOMETRY_CAN_START" in codes(rep, "VS-120"))
check("VS-124: dieline unknown, geometry blocked until StudioPack answers",
      "DIELINE_UNKNOWN" in codes(rep, "VS-124"))

print(f"\nAll {PASS} checks passed.")
