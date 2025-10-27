from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple


def american_to_decimal(price: int) -> float:
    """Convert American odds to decimal odds."""
    if price == 0:
        raise ValueError("American odds cannot be zero.")
    if price > 0:
        return 1.0 + price / 100.0
    return 1.0 + 100.0 / abs(price)


def decimal_to_american(decimal: float) -> int:
    """Convert decimal odds back to American format."""
    if decimal <= 1.0:
        raise ValueError("Decimal odds must be greater than 1.0")
    if decimal >= 2.0:
        return int(round((decimal - 1.0) * 100.0))
    return int(round(-100.0 / (decimal - 1.0)))


def implied_probability(price: int) -> float:
    """Return the implied win probability for an American price."""
    if price == 0:
        raise ValueError("American odds cannot be zero.")
    if price > 0:
        return 100.0 / (price + 100.0)
    return abs(price) / (abs(price) + 100.0)


def parlay_decimal_odds(prices: Iterable[int]) -> float:
    decimal_total = 1.0
    for price in prices:
        decimal_total *= american_to_decimal(price)
    return decimal_total


def potential_payout(stake: float, prices: Iterable[int]) -> float:
    """Return the gross payout (including stake) if every leg wins."""
    decimal_total = parlay_decimal_odds(prices)
    return stake * decimal_total


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class BetLeg:
    game_id: int
    market: str  # moneyline | spread | total
    selection: str  # e.g. home/away/Over/Under
    price: int
    point: Optional[float] = None
    label: str = ""
    result: str = "pending"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "game_id": self.game_id,
            "market": self.market,
            "selection": self.selection,
            "price": self.price,
            "point": self.point,
            "label": self.label,
            "result": self.result,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "BetLeg":
        return cls(
            game_id=int(raw.get("game_id")),
            market=str(raw.get("market")),
            selection=str(raw.get("selection")),
            price=int(raw.get("price")),
            point=raw.get("point"),
            label=str(raw.get("label", "")),
            result=str(raw.get("result", "pending")),
            metadata=dict(raw.get("metadata") or {}),
        )


@dataclass
class BetSlip:
    slip_id: str
    stake: float
    kind: str  # single | parlay
    legs: List[BetLeg] = field(default_factory=list)
    status: str = "pending"
    placed_at: str = field(default_factory=utc_now_iso)
    potential_payout: float = 0.0
    settled_at: Optional[str] = None
    winnings: float = 0.0
    notes: str = ""
    payout: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "slip_id": self.slip_id,
            "stake": self.stake,
            "kind": self.kind,
            "legs": [leg.to_dict() for leg in self.legs],
            "status": self.status,
            "placed_at": self.placed_at,
            "potential_payout": self.potential_payout,
            "settled_at": self.settled_at,
            "winnings": self.winnings,
            "notes": self.notes,
            "payout": self.payout,
        }

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "BetSlip":
        legs = [BetLeg.from_dict(item) for item in raw.get("legs", [])]
        return cls(
            slip_id=str(raw.get("slip_id")),
            stake=float(raw.get("stake", 0.0)),
            kind=str(raw.get("kind", "single")),
            legs=legs,
            status=str(raw.get("status", "pending")),
            placed_at=str(raw.get("placed_at", utc_now_iso())),
            potential_payout=float(raw.get("potential_payout", 0.0)),
            settled_at=raw.get("settled_at"),
            winnings=float(raw.get("winnings", 0.0)),
            notes=str(raw.get("notes", "")),
            payout=float(raw.get("payout", 0.0)),
        )

    def american_prices(self) -> List[int]:
        return [leg.price for leg in self.legs]

    def decimal_odds(self) -> float:
        return parlay_decimal_odds(self.american_prices())

    def gross_payout(self) -> float:
        return potential_payout(self.stake, self.american_prices())


def grade_leg_from_scoreboard(leg: BetLeg, scoreboard: Optional[Dict[str, Any]]) -> str:
    if not scoreboard:
        return "pending"
    home_score = scoreboard.get("home_score")
    away_score = scoreboard.get("away_score")
    if home_score is None or away_score is None:
        return "pending"

    leg.metadata.setdefault(
        "final", {
            "home_score": home_score,
            "away_score": away_score,
            "home_team": scoreboard.get("home_team"),
            "away_team": scoreboard.get("away_team"),
        },
    )

    market = (leg.market or "").lower()
    selection = (leg.selection or "").lower()

    if market == "moneyline":
        winner = (scoreboard.get("winner") or "").lower()
        home_team = (scoreboard.get("home_team") or "").lower()
        away_team = (scoreboard.get("away_team") or "").lower()
        if not winner:
            if home_score == away_score:
                return "push"
            return "pending"
        if selection.startswith("home"):
            return "won" if winner == home_team else "lost"
        if selection.startswith("away"):
            return "won" if winner == away_team else "lost"
        # If selection stored as team abbreviation/name
        normalized_selection = selection.replace(" ", "")
        if winner.replace(" ", "") == normalized_selection:
            return "won"
        return "lost"

    if market == "spread":
        point = float(leg.point or 0.0)
        if selection.startswith("home"):
            adjusted = float(home_score) + point
            if adjusted > float(away_score):
                return "won"
            if adjusted == float(away_score):
                return "push"
            return "lost"
        if selection.startswith("away"):
            adjusted = float(away_score) + point
            if adjusted > float(home_score):
                return "won"
            if adjusted == float(home_score):
                return "push"
            return "lost"
        return "lost"

    if market == "total":
        point = float(leg.point or 0.0)
        total_score = float(home_score) + float(away_score)
        if selection.startswith("over"):
            if total_score > point:
                return "won"
            if total_score == point:
                return "push"
            return "lost"
        if selection.startswith("under"):
            if total_score < point:
                return "won"
            if total_score == point:
                return "push"
            return "lost"
        return "lost"

    return "pending"


def evaluate_slip_with_scoreboards(
    slip: BetSlip,
    scoreboard_lookup: Dict[int, Dict[str, Any]],
) -> Tuple[BetSlip, bool]:
    resolved = True
    winning_prices: List[int] = []
    for leg in slip.legs:
        game_id = int(leg.game_id)
        scoreboard = scoreboard_lookup.get(game_id)
        result = grade_leg_from_scoreboard(leg, scoreboard)
        leg.result = result
        if result == "pending":
            resolved = False
        elif result == "won":
            winning_prices.append(leg.price)

    if not resolved:
        slip.status = "pending"
        slip.payout = 0.0
        slip.winnings = 0.0
        return slip, False

    slip.settled_at = utc_now_iso()
    if any(leg.result == "lost" for leg in slip.legs):
        slip.status = "lost"
        slip.payout = 0.0
        slip.winnings = 0.0
        return slip, True

    if winning_prices:
        gross = potential_payout(slip.stake, winning_prices)
        slip.status = "won"
        slip.payout = gross
        slip.winnings = gross - slip.stake
    else:
        slip.status = "push"
        slip.payout = slip.stake
        slip.winnings = 0.0

    return slip, True
