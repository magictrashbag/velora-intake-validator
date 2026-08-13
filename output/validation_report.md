# Velora intake validation report

SKUs: 24 | blockers: 5 | warnings: 23 | info: 16

## Order-level

- **[BLOCKER] MASTERDATA_VERSION** - CSV is the spring 'v2' export but the client attached masterdata_v3.xlsx (Email 1). SKU list may be stale - see orphan-artwork and missing-artwork defects for concrete evidence of a delta.
- **[WARNING] ORPHAN_ARTWORK** - artwork velora-hb-fresh-100-travel.pdf is on the StudioPack drive but matches no SKU in the CSV - likely a SKU that exists in masterdata v3 but not in our v2 export
- **[WARNING] ORPHAN_ARTWORK** - artwork velora-pb-handcream-250.pdf is on the StudioPack drive but matches no SKU in the CSV - likely a SKU that exists in masterdata v3 but not in our v2 export
- **[INFO] VIDEO_SCOPE_REQUEST** - Email 2 asks for e-commerce videos for 'hero SKUs' - undefined scope, no SKUs flagged as hero, no video spec in the pack.

## Per SKU

### VS-101 - Hydra Boost Fresh - recolor - ready - due 2026-09-22
- clean

### VS-102 - Hydra Boost Citrus - recolor - ready - due 2026-09-22
- [warning] ARTWORK_REF_MISMATCH: CSV points at velora-hb-fresh-250.pdf but variant 'Citrus' matches velora-hb-citrus-250.pdf -> auto_fixed: using velora-hb-citrus-250.pdf; flagged for client confirm

### VS-103 - Hydra Boost Aloe - recolor - ready - due 2026-09-22
- clean

### VS-104 - Hydra Boost Coconut - recolor - BLOCKED (naming) - due 2026-09-22
- [blocker] TRADE_CODE_MISSING: no trade code - every delivery filename derives from it; twin production can proceed but nothing can be named or delivered; sequence inference suggests VLR-2212 (report-only, not applied) -> needs_client: confirm code

### VS-105 - Hydra Boost Sport - recolor - ready - due 2026-09-22
- [warning] LANGUAGE_MISMATCH: CSV languages EN,FR vs artwork panels EN/FR/DE -> auto_fixed: using artwork panels EN/FR/DE; flagged for client confirm
- [warning] BASE_DIELINE_MISMATCH: this SKU's artwork is on dieline DL-HB-400 but base VS-101 is on DL-HB-250 - geometry cannot be reused from that master -> needs_internal: check the spring twin library for a matching-dieline master; fallback = new master (+~25h)
- [info] SIZE_FORMAT: converted 0.4 L to 400ml -> auto_fixed: normalized to 400ml

### VS-106 - Hydra Boost Sensitive - recolor - ready - due 2026-09-22
- clean

### VS-107 - Silk Repair Smooth Shampoo - recolor - ready - due 2026-10-15
- [warning] LANGUAGES_MISSING: CSV has no languages; artwork carries panels EN/FR/DE -> auto_fixed: using artwork panels EN/FR/DE
- [info] FINISH_MISMATCH: CSV finish 'none' vs artwork finish plate 'gloss + foil accent' -> auto_fixed: using artwork finish plate 'gloss + foil accent'

### VS-108 - Silk Repair Volume Shampoo - recolor - ready - due 2026-10-15
- [warning] LANGUAGE_MISMATCH: CSV languages EN,FR,NL vs artwork panels EN/FR/DE (source says 'Dutch' - ambiguous: German (Deutsch) mistyped, or a genuine NL requirement the artwork does not carry (NL panels exist elsewhere in this range) - two different defects with two different owners) -> auto_fixed: using artwork panels EN/FR/DE; flagged for client confirm
- [info] FINISH_MISMATCH: CSV finish 'none' vs artwork finish plate 'gloss + foil accent' -> auto_fixed: using artwork finish plate 'gloss + foil accent'

### VS-109 - Silk Repair Repair Shampoo - recolor - ready - due 2026-10-15
- [info] FINISH_MISMATCH: CSV finish 'none' vs artwork finish plate 'gloss + foil accent' -> auto_fixed: using artwork finish plate 'gloss + foil accent'

### VS-110 - Silk Repair Curl Shampoo - recolor - ready - due 2026-10-15
- [warning] BASE_MASTER_IS_RECOLOR: base_master VS-109 is itself a recolor; geometry root is VS-107 -> auto_fixed: re-parented to VS-107
- [info] FINISH_MISMATCH: CSV finish 'TBD' vs artwork finish plate 'gloss + foil accent' -> auto_fixed: using artwork finish plate 'gloss + foil accent'

### VS-111 - Silk Repair Smooth Conditioner - recolor - ready - due 2026-10-15
- [info] FINISH_MISMATCH: CSV finish 'TBD' vs artwork finish plate 'gloss + foil accent' -> auto_fixed: using artwork finish plate 'gloss + foil accent'

### VS-112 - Silk Repair Volume Conditioner - recolor - BLOCKED (naming) - due 2026-10-15
- [blocker] TRADE_CODE_DUPLICATE: trade code VLR-2214 already used by VS-103 - delivery filenames would collide; sequence inference suggests VLR-2221 for VS-112 (Silk Repair runs 2216-2223 with 2221 unused) but a guessed code must not reach deliverables -> needs_client: confirm correct code
- [info] FINISH_MISMATCH: CSV finish 'gloss+foil' vs artwork finish plate 'gloss + foil accent' -> auto_fixed: using artwork finish plate 'gloss + foil accent'

### VS-113 - Silk Repair Argan Conditioner - blocked - BLOCKED - due 2026-10-15
- [blocker] ARTWORK_MISSING: no artwork on the StudioPack drive matches this SKU (CSV says velora-sr-conditioner-argan-300.pdf); it is also not in the announced late list -> needs_client: ask Sanne/Lea whether this SKU is still in scope (see v3 mismatch)

### VS-114 - Silk Repair Keratin Conditioner - recolor - ready - due 2026-10-15
- [warning] LANGUAGE_MISMATCH: CSV languages EN,FR,DE vs artwork panels EN/FR/DE/NL -> auto_fixed: using artwork panels EN/FR/DE/NL; flagged for client confirm
- [info] FINISH_MISMATCH: CSV finish 'gloss+foil' vs artwork finish plate 'gloss + foil accent' -> auto_fixed: using artwork finish plate 'gloss + foil accent'

### VS-115 - Pure Botanica Shea Body Lotion - new_master - ready - due 2026-09-22
- [warning] FINISH_OVERRIDE_EMAIL: CSV/manifest say gloss but Pure Botanica switched to matte after the sustainability review -> auto_fixed: finish=matte
- [warning] SHAPE_CHANGE_RECLASS: CSV says existing_master but the PET bottle change forces a new master -> auto_fixed: classification=new_master; client confirm requested (cost impact)

### VS-116 - Pure Botanica Cocoa Body Lotion - new_master - ready - due 2026-09-22
- [warning] FINISH_OVERRIDE_EMAIL: CSV/manifest say gloss but Pure Botanica switched to matte after the sustainability review -> auto_fixed: finish=matte
- [warning] SHAPE_CHANGE_RECLASS: CSV says recolor but the PET bottle change forces a new master (base VS-115 is a different dieline anyway) -> auto_fixed: classification=new_master; client confirm requested (cost impact)
- [info] SIZE_FORMAT: unit embedded in size field ('400ml') -> auto_fixed: normalized to 400ml

### VS-117 - Pure Botanica Aloe Body Lotion - recolor - ready - due 2026-10-15
- [warning] FINISH_OVERRIDE_EMAIL: CSV/manifest say gloss but Pure Botanica switched to matte after the sustainability review -> auto_fixed: finish=matte
- [info] MASTER_DEPENDENCY: base master VS-115 is itself being rebuilt for the PET shape change -> sequence: master first

### VS-118 - Pure Botanica Rose Body Lotion - recolor - BLOCKED (naming) - due 2026-10-15
- [blocker] TRADE_CODE_MISSING: no trade code - every delivery filename derives from it; twin production can proceed but nothing can be named or delivered; sequence inference suggests VLR-2227 (report-only, not applied) -> needs_client: confirm code
- [warning] FINISH_OVERRIDE_EMAIL: CSV/manifest say gloss but Pure Botanica switched to matte after the sustainability review -> auto_fixed: finish=matte
- [info] MASTER_DEPENDENCY: base master VS-115 is itself being rebuilt for the PET shape change -> sequence: master first

### VS-119 - Pure Botanica Vanilla Body Lotion - recolor - pending artwork - due 2026-09-22
- [warning] ARTWORK_PENDING: artwork velora-pb-vanilla-250.pdf not on the drive yet; StudioPack ETA 2026-09-05 -> watch drive; escalate if not delivered by ETA
- [warning] FINISH_OVERRIDE_EMAIL: CSV/manifest say gloss but Pure Botanica switched to matte after the sustainability review -> auto_fixed: finish=matte
- [warning] SCHEDULE_RISK_NORDMART: Nordmart deadline 2026-09-22 but artwork lands ~2026-09-05 - 17 days for master/mapping/QC/outputs -> start geometry from dieline now; escalate on any ETA slip
- [info] MASTER_DEPENDENCY: base master VS-115 is itself being rebuilt for the PET shape change -> sequence: master first

### VS-120 - Velora Men Active Deo Spray - new_master - pending artwork - due 2026-10-15
- [warning] ARTWORK_PENDING: artwork velora-mn-active-150.pdf not on the drive yet; StudioPack ETA 2026-09-05 -> watch drive; escalate if not delivered by ETA
- [info] GEOMETRY_CAN_START: master artwork is late but sibling artworks share dieline DL-MN-150 - geometry can start now; only label mapping waits for the file -> sequence: start geometry now

### VS-121 - Velora Men Fresh Deo Spray - recolor - ready - due 2026-10-15
- [warning] BASE_MASTER_DANGLING: base_master VS-199 does not exist in the SKU list; VS-120 is the only Velora Men 150ml master -> auto_fixed: re-parented to VS-120
- [info] MASTER_DEPENDENCY: base master VS-120's artwork arrives ~2026-09-05; master geometry can start now from the range dieline, mapping waits for artwork -> sequence: start geometry now

### VS-122 - Velora Men Sport Deo Spray - recolor - ready - due 2026-09-22
- [warning] MASTER_DEPENDENCY: base master VS-120's artwork arrives ~2026-09-05; master geometry can start now from the range dieline, mapping waits for artwork - tight against the Nordmart deadline 2026-09-22 -> sequence: start geometry now

### VS-123 - Velora Men Sensitive Deo Spray - recolor - ready - due 2026-10-15
- [info] MASTER_DEPENDENCY: base master VS-120's artwork arrives ~2026-09-05; master geometry can start now from the range dieline, mapping waits for artwork -> sequence: start geometry now

### VS-124 - Velora Men Sensitive Stick - new_master - pending artwork - due 2026-10-15
- [warning] ARTWORK_PENDING: artwork velora-mn-stick-50.pdf not on the drive yet; StudioPack ETA 2026-09-05 -> watch drive; escalate if not delivered by ETA
- [warning] DIELINE_UNKNOWN: master artwork is late and no artwork on the drive shares this range+size - there is no dieline to start geometry from -> needs_client: ask StudioPack for the dieline now, ahead of the artwork
