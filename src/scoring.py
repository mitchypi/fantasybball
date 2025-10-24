from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

from .config import DATA_DIR, ScoringProfile, settings

SCORING_CONFIG_PATH = DATA_DIR / "scoring_profiles.json"
STAT_DEFAULTS = {
    "PTS": 0.0,
    "OREB": 0.0,
    "DREB": 0.0,
    "TREB": 0.0,
    "AST": 0.0,
    "STL": 0.0,
    "BLK": 0.0,
    "3PM": 0.0,
    "3PA": 0.0,
    "MPG": 0.0,
    "FGM": 0.0,
    "FGA": 0.0,
    "FG_MISS": 0.0,
    "FTM": 0.0,
    "FTA": 0.0,
    "FT_MISS": 0.0,
    "TO": 0.0,
    "DD": 0.0,
    "TD": 0.0,
    "PF": 0.0,
    "DOUBLE_DOUBLE": 0.0,
    "TRIPLE_DOUBLE": 0.0,
}


def _merge_weights_with_defaults(base: Dict[str, float], overrides: Dict[str, float]) -> Dict[str, float]:
    merged = {k.upper(): float(v) for k, v in base.items()}
    merged.update({k.upper(): float(v) for k, v in overrides.items()})
    for stat, default in STAT_DEFAULTS.items():
        merged.setdefault(stat, base.get(stat, default))
    return merged


def load_custom_scoring_profiles(path: Path | None = None) -> None:
    """Load persisted scoring profiles (if any) and apply them to global settings."""
    config_path = path or SCORING_CONFIG_PATH
    if not config_path.exists():
        return

    with config_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    profiles: Dict[str, Dict[str, object]] = payload.get("profiles", {})
    default_profile: str | None = payload.get("default")

    for key, raw_profile in profiles.items():
        base_profile = settings.scoring_profiles.get(key)
        base_weights = dict(base_profile.weights) if base_profile else {}
        loaded_weights = {k.upper(): float(v) for k, v in (raw_profile.get("weights") or {}).items()}
        merged_weights = _merge_weights_with_defaults(base_weights, loaded_weights)
        profile_name = str(raw_profile.get("name") or (base_profile.name if base_profile else key))
        settings.scoring_profiles[key] = ScoringProfile(name=profile_name, weights=merged_weights)

    if default_profile:
        settings.default_scoring_profile = default_profile


def persist_scoring_profiles(path: Path | None = None) -> None:
    config_path = path or SCORING_CONFIG_PATH
    config_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "profiles": {
            key: {
                "name": profile.name,
                "weights": profile.weights,
            }
            for key, profile in settings.scoring_profiles.items()
        },
        "default": settings.default_scoring_profile,
    }
    with config_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def update_scoring_profile(
    key: str,
    name: str,
    weights: Dict[str, float],
    make_default: bool = False,
) -> ScoringProfile:
    existing = settings.scoring_profiles.get(key)
    existing_weights = dict(existing.weights) if existing else {}
    updated_weights = {k.upper(): float(v) for k, v in weights.items()}
    merged_weights = _merge_weights_with_defaults(existing_weights, updated_weights)
    profile_name = name or (existing.name if existing else key)
    profile = ScoringProfile(name=profile_name, weights=merged_weights)
    settings.scoring_profiles[key] = profile
    if make_default:
        settings.default_scoring_profile = key
    persist_scoring_profiles()
    return profile


# Load persisted scoring on import for convenience.
load_custom_scoring_profiles()

# Ensure all active profiles include new stat keys even if not yet persisted.
for _profile_key, _profile in list(settings.scoring_profiles.items()):
    merged = _merge_weights_with_defaults({}, _profile.weights)
    settings.scoring_profiles[_profile_key] = ScoringProfile(name=_profile.name, weights=merged)
