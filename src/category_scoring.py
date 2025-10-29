from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

import pandas as pd

from .config import CategoryDefinition


STAT_ALIASES: Dict[str, str] = {
    "TREB": "REB",
    "TO": "TOV",
}


@dataclass
class CategoryResult:
    value: float
    label: str
    higher_is_better: bool
    kind: str
    precision: int
    numerator: Optional[float] = None
    denominator: Optional[float] = None

    def to_dict(self) -> Dict[str, float]:
        payload: Dict[str, float] = {
            "value": float(self.value),
            "label": self.label,
            "higher_is_better": self.higher_is_better,
            "kind": self.kind,
            "precision": self.precision,
        }
        if self.numerator is not None:
            payload["numerator"] = float(self.numerator)
        if self.denominator is not None:
            payload["denominator"] = float(self.denominator)
        return payload


def _safe_sum(series: pd.Series) -> float:
    if series is None:
        return 0.0
    return float(pd.to_numeric(series, errors="coerce").fillna(0.0).sum())


def _resolve_stat(record: Mapping[str, Any], stat: Optional[str]) -> float:
    if not stat:
        return 0.0
    if stat in record and record[stat] is not None:
        return float(record[stat])
    alias = STAT_ALIASES.get(stat)
    if alias and alias in record and record[alias] is not None:
        return float(record[alias])
    return 0.0


def compute_category_totals(
    df: pd.DataFrame,
    categories: Dict[str, CategoryDefinition],
) -> Dict[str, CategoryResult]:
    """Compute aggregated category totals for the provided DataFrame."""
    results: Dict[str, CategoryResult] = {}
    for key, definition in categories.items():
        if definition.requires_ratio():
            numerator = _safe_sum(df.get(definition.numerator)) if definition.numerator else 0.0
            denominator = _safe_sum(df.get(definition.denominator)) if definition.denominator else 0.0
            value = numerator / denominator if denominator else 0.0
            results[key] = CategoryResult(
                value=value,
                label=definition.label,
                higher_is_better=definition.higher_is_better,
                kind=definition.kind,
                precision=definition.precision,
                numerator=numerator,
                denominator=denominator,
            )
        else:
            stat_series = df.get(definition.stat)
            total = _safe_sum(stat_series)
            results[key] = CategoryResult(
                value=total,
                label=definition.label,
                higher_is_better=definition.higher_is_better,
                kind=definition.kind,
                precision=definition.precision,
            )
    return results


def category_result_from_record(
    record: Mapping[str, Any],
    definition: CategoryDefinition,
) -> CategoryResult:
    if definition.requires_ratio():
        numerator = _resolve_stat(record, definition.numerator)
        denominator = _resolve_stat(record, definition.denominator)
        value = numerator / denominator if denominator else 0.0
        return CategoryResult(
            value=value,
            label=definition.label,
            higher_is_better=definition.higher_is_better,
            kind=definition.kind,
            precision=definition.precision,
            numerator=numerator,
            denominator=denominator,
        )
    stat_value = _resolve_stat(record, definition.stat)
    return CategoryResult(
        value=stat_value,
        label=definition.label,
        higher_is_better=definition.higher_is_better,
        kind=definition.kind,
        precision=definition.precision,
    )


def merge_category_totals(
    base: Dict[str, Dict[str, float]],
    addition: Dict[str, CategoryResult],
    categories: Dict[str, CategoryDefinition],
) -> Dict[str, Dict[str, float]]:
    """Merge category results, summing numerator/denominator where appropriate."""
    merged: Dict[str, Dict[str, float]] = {key: dict(values) for key, values in base.items()}
    for key, definition in categories.items():
        incoming = addition.get(key)
        if incoming is None:
            continue
        record = merged.setdefault(
            key,
            {
                "value": 0.0,
                "label": definition.label,
                "higher_is_better": definition.higher_is_better,
                "kind": definition.kind,
                "precision": definition.precision,
            },
        )
        if definition.requires_ratio():
            numerator = float(record.get("numerator", 0.0)) + float(incoming.numerator or 0.0)
            denominator = float(record.get("denominator", 0.0)) + float(incoming.denominator or 0.0)
            record["numerator"] = numerator
            record["denominator"] = denominator
            record["value"] = numerator / denominator if denominator else 0.0
        else:
            record["value"] = float(record.get("value", 0.0)) + float(incoming.value)

    return merged


def ensure_category_defaults(
    categories: Dict[str, CategoryDefinition],
    existing: Optional[Dict[str, Dict[str, float]]] = None,
) -> Dict[str, Dict[str, float]]:
    """Return a category mapping that includes every definition key."""
    payload: Dict[str, Dict[str, float]] = {key: dict(values) for key, values in (existing or {}).items()}
    for key, definition in categories.items():
        payload.setdefault(
            key,
            {
                "value": 0.0,
                "label": definition.label,
                "higher_is_better": definition.higher_is_better,
                "kind": definition.kind,
                "precision": definition.precision,
            },
        )
    return payload


def compare_category(
    value_a: float,
    value_b: float,
    definition: CategoryDefinition,
) -> int:
    """Return 1 if A wins, -1 if B wins, 0 if tied for the category."""
    if abs(value_a - value_b) < 1e-9:
        return 0
    if definition.higher_is_better:
        return 1 if value_a > value_b else -1
    return 1 if value_a < value_b else -1


def normalize_category_payload(
    data: Dict[str, Dict[str, float]],
    categories: Dict[str, CategoryDefinition],
) -> Dict[str, Dict[str, float]]:
    """Ensure category payloads include metadata and precision settings."""
    normalized: Dict[str, Dict[str, float]] = {}
    for key, definition in categories.items():
        record = dict(data.get(key) or {})
        record.setdefault("value", 0.0)
        record["label"] = definition.label
        record["higher_is_better"] = definition.higher_is_better
        record["kind"] = definition.kind
        record["precision"] = definition.precision
        if definition.requires_ratio():
            record.setdefault("numerator", 0.0)
            record.setdefault("denominator", 0.0)
            denom = float(record["denominator"])
            record["value"] = float(record["numerator"]) / denom if denom else 0.0
        normalized[key] = record
    return normalized


def deserialize_category_result(
    key: str,
    payload: Dict[str, Any],
    definition: Optional[CategoryDefinition] = None,
) -> CategoryResult:
    label = str(payload.get("label") or (definition.label if definition else key))
    higher_is_better = bool(
        payload.get("higher_is_better")
        if payload.get("higher_is_better") is not None
        else (definition.higher_is_better if definition else True)
    )
    kind = str(payload.get("kind") or (definition.kind if definition else "sum"))
    precision = int(payload.get("precision") or (definition.precision if definition else 2))
    numerator = payload.get("numerator")
    denominator = payload.get("denominator")
    if numerator is not None:
        numerator = float(numerator)
    if denominator is not None:
        denominator = float(denominator)
    value = float(payload.get("value", 0.0))
    if kind == "percentage":
        denom = float(denominator or 0.0)
        if denom:
            value = float(numerator or 0.0) / denom
        else:
            value = 0.0
    return CategoryResult(
        value=value,
        label=label,
        higher_is_better=higher_is_better,
        kind=kind,
        precision=precision,
        numerator=numerator,
        denominator=denominator,
    )
