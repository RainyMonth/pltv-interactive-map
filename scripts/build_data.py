#!/usr/bin/env python3
"""Validate the PLTV workbook and build browser-ready map data."""

from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
WORKBOOK_PATH = ROOT / "source" / "division_level.xlsx"
BOUNDARY_PATH = ROOT / "source" / "Political_Divisions.geojson"
OUTPUT_DIR = ROOT / "dist" / "data"

REQUIRED_COLUMNS = {
    "Division",
    "Division and Dorms",
    "Election Type",
    "Year",
    "In Person Count",
    "Mail/Absentee Count",
    "Provisional Count",
    "Vote Count",
    "Registration Number",
    "1 Year Registration Number",
    "Turnout Rate",
}

TARGET_DIVISIONS = {
    "2703",
    "2706",
    "2711",
    "2718",
    "2719",
    "2720",
    "2721",
    "2722",
}


def fail(message: str) -> None:
    raise ValueError(message)


def as_int(value, label: str, row_number: int) -> int:
    if value is None or value == "":
        fail(f"Row {row_number}: {label} is blank.")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Row {row_number}: {label} must be numeric, got {value!r}.") from exc
    if not math.isfinite(number) or not number.is_integer():
        fail(f"Row {row_number}: {label} must be a whole number, got {value!r}.")
    return int(number)


def split_dorms(combined, division: int) -> str:
    """Remove only the leading division label; preserve the workbook's dorm wording."""
    if division == 6:
        return ""
    text = "" if combined is None else str(combined).strip()
    if not text:
        return "Not listed"
    pattern = rf"^\s*{re.escape(str(division))}\s*[-–—·]\s*"
    dorms = re.sub(pattern, "", text, count=1).strip()
    return dorms or "Not listed"


def sheet_columns(sheet):
    return {str(v).strip(): i for i, v in enumerate(next(sheet.values)) if v is not None}


def build_voting_data() -> list[dict]:
    workbook = load_workbook(WORKBOOK_PATH, read_only=True, data_only=True)
    # Use the named detail sheet, not comparison/benchmark sheets or formatting ranges.
    detail = next((s for s in workbook if s.title.lower().replace("_", "-") == "division-level"), None)
    if detail is None:
        candidates = []
        for sheet in workbook:
            cols = sheet_columns(sheet)
            if not REQUIRED_COLUMNS.issubset(cols):
                continue
            if any(str(row[cols["Division"]]).strip() in {"3", "3.0", "2703"}
                   for row in sheet.iter_rows(min_row=2, values_only=True)):
                candidates.append(sheet)
        if len(candidates) != 1:
            fail("Cannot uniquely identify the division-level worksheet.")
        detail = candidates[0]
    sheets = [detail] + [s for s in workbook if s.title.lower() == "total" and s != detail]
    records, totals = [], {}
    fields = {"registrationNumber": "Registration Number",
              "oneYearRegistrationNumber": "1 Year Registration Number", "voteCount": "Vote Count"}
    components = ("In Person Count", "Mail/Absentee Count", "Provisional Count")
    for sheet in sheets:
        columns = sheet_columns(sheet)
        if not REQUIRED_COLUMNS.issubset(columns):
            fail(f"{sheet.title}: missing columns {sorted(REQUIRED_COLUMNS - columns.keys())}")
        for rn, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), 2):
            if all(v is None for v in row):
                continue
            raw = row[columns["Division"]]
            kind = str(row[columns["Election Type"]] or "").strip().title()
            year = as_int(row[columns["Year"]], "Year", rn)
            if kind not in {"Primary", "General"}:
                fail(f"{sheet.title} row {rn}: invalid Election Type {kind!r}.")
            values = {key: as_int(row[columns[col]], col, rn) for key, col in fields.items()}
            parts = [as_int(row[columns[col]], col, rn) for col in components]
            if min(*values.values(), *parts) < 0:
                fail(f"{sheet.title} row {rn}: counts cannot be negative.")
            reg, vote = values["registrationNumber"], values["voteCount"]
            if sum(parts) != vote or vote > reg or values["oneYearRegistrationNumber"] > reg:
                fail(f"{sheet.title} row {rn}: inconsistent registration/vote counts.")
            rate = vote / reg if reg else None
            supplied = row[columns["Turnout Rate"]]
            if supplied not in (None, ""):
                try:
                    supplied = float(supplied)
                except (TypeError, ValueError):
                    fail(f"{sheet.title} row {rn}: Turnout Rate must be a numeric fraction.")
                if rate is None or not math.isfinite(supplied) or abs(supplied - rate) > 1e-8:
                    fail(f"{sheet.title} row {rn}: Turnout Rate does not equal Vote Count / Registration Number.")
            values.update(inPersonCount=parts[0], mailAbsenteeCount=parts[1], provisionalCount=parts[2])
            key = (year, kind)
            if str(raw).strip().lower() == "total":
                if key in totals:
                    fail(f"Duplicate Total row for {key}.")
                totals[key] = values
                continue
            division = as_int(raw, "Division", rn)
            if division >= 100:
                ward, division = divmod(division, 100)
            else:
                ward = as_int(row[columns["Ward"]], "Ward", rn) if "Ward" in columns else 27
            division_id = f"{ward:02d}{division:02d}"
            if division_id not in TARGET_DIVISIONS:
                fail(f"{sheet.title} row {rn}: unexpected division {division_id}.")
            records.append(dict(year=year, electionType=kind, ward=ward, division=division,
                                divisionId=division_id, turnoutRate=rate,
                                dorms=split_dorms(row[columns["Division and Dorms"]], division), **values))
    workbook.close()
    if not records:
        fail("No division records found.")
    keys = [(r["year"], r["electionType"], r["divisionId"]) for r in records]
    duplicates = [key for key, count in Counter(keys).items() if count > 1]
    if duplicates:
        fail(f"Duplicate Year × Election Type × Division rows: {duplicates[:8]}")
    groups = defaultdict(list)
    for record in records:
        groups[record["year"], record["electionType"]].append(record)
    for key, group in groups.items():
        found = {r["divisionId"] for r in group}
        if found != TARGET_DIVISIONS:
            fail(f"{key}: missing divisions {sorted(TARGET_DIVISIONS - found)}.")
        if key in totals:
            for field, expected in totals[key].items():
                actual = sum(r[field] for r in group)
                if actual != expected:
                    fail(f"{key}: Total {field} is {expected}, but divisions sum to {actual}.")
    if set(totals) - groups.keys():
        fail("A Total row has no matching division records.")
    records.sort(key=lambda r: (r["year"], r["electionType"], r["division"]))
    return records


def build_boundary_data() -> dict:
    with BOUNDARY_PATH.open("r", encoding="utf-8") as handle:
        geojson = json.load(handle)

    if geojson.get("type") != "FeatureCollection":
        fail("Political_Divisions.geojson must be a GeoJSON FeatureCollection.")

    selected = []
    for feature in geojson.get("features", []):
        properties = feature.get("properties") or {}
        lower_properties = {str(key).lower(): value for key, value in properties.items()}
        division_id = lower_properties.get("division_num") or lower_properties.get("division_n")
        division_id = "" if division_id is None else str(division_id).zfill(4)
        if division_id in TARGET_DIVISIONS:
            selected.append(
                {
                    "type": "Feature",
                    "properties": {"divisionId": division_id},
                    "geometry": feature.get("geometry"),
                }
            )

    found = {feature["properties"]["divisionId"] for feature in selected}
    if found != TARGET_DIVISIONS:
        fail(
            "Boundary file does not contain all required divisions. "
            f"Missing: {sorted(TARGET_DIVISIONS - found)}"
        )
    if len(selected) != len(TARGET_DIVISIONS):
        fail("Boundary file contains duplicate features for at least one required division.")

    selected.sort(key=lambda feature: feature["properties"]["divisionId"])
    return {"type": "FeatureCollection", "features": selected}


def main() -> None:
    if not WORKBOOK_PATH.exists():
        fail(f"Missing workbook: {WORKBOOK_PATH}")
    if not BOUNDARY_PATH.exists():
        fail(f"Missing boundary file: {BOUNDARY_PATH}")

    records = build_voting_data()
    boundaries = build_boundary_data()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with (OUTPUT_DIR / "voting.json").open("w", encoding="utf-8") as handle:
        json.dump(records, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    with (OUTPUT_DIR / "ward27_divisions.geojson").open("w", encoding="utf-8") as handle:
        json.dump(boundaries, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")

    # A regular script tag works under file:// as well as on GitHub Pages.
    payload = json.dumps({"records": records, "boundaries": boundaries}, ensure_ascii=False, separators=(",", ":"))
    (OUTPUT_DIR / "map-data.js").write_text("window.PLTV_DATA = " + payload + ";\n", encoding="utf-8")

    # Standalone preview: CSS, map library and data are embedded, no local fetches.
    dist = ROOT / "dist"
    preview = (dist / "index.html").read_text(encoding="utf-8")
    for asset in ("vendor/leaflet.css", "styles.css"):
        preview = preview.replace(f'<link rel="stylesheet" href="{asset}" />',
                                  "<style>" + (dist / asset).read_text(encoding="utf-8") + "</style>")
    for asset in ("vendor/leaflet.js", "data/map-data.js", "app.js"):
        content = (dist / asset).read_text(encoding="utf-8").replace("</script", "<\\/script")
        preview = preview.replace(f'<script src="{asset}"></script>', "<script>" + content + "</script>")
        preview = preview.replace(f'<script src="{asset}" defer></script>', "<script>" + content + "</script>")
    (dist / "preview.html").write_text(preview, encoding="utf-8")

    years = sorted({record["year"] for record in records})
    election_types = sorted({record["electionType"] for record in records})
    print(
        f"Built {len(records)} records and {len(boundaries['features'])} boundaries; "
        f"years {years[0]}–{years[-1]}; election types {', '.join(election_types)}."
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Data build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
