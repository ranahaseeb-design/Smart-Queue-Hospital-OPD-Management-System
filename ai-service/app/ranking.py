"""Branch recommendation scoring (Section 6.5.2, Eq. 6.3) — FR-08, FR-09.

S_k = w1 * norm(W_k) + w2 * norm(d_k) + w3 * norm(rho_k), lower is better.
Each factor is min-max normalised across the candidates; when all candidates have the
same value the normalised value is 0. When distance is unknown (the patient did not
share a location) the distance weight is redistributed to wait and congestion in
proportion to their own weights.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass(frozen=True)
class Candidate:
    branch_id: int
    doctor_id: Optional[int]
    predicted_wait_minutes: float
    distance_km: Optional[float]
    congestion_ratio: float


@dataclass(frozen=True)
class Ranked:
    branch_id: int
    doctor_id: Optional[int]
    score: float


def min_max_normalise(values: Sequence[float]) -> list[float]:
    """Min-max normalisation to [0, 1]; all-equal (or a single value) maps to 0."""
    if not values:
        return []
    low, high = min(values), max(values)
    span = high - low
    if span <= 1e-12:
        return [0.0 for _ in values]
    return [(v - low) / span for v in values]


def effective_weights(wait: float, distance: float, congestion: float, has_distance: bool) -> tuple[float, float, float]:
    """Return (w_wait, w_distance, w_congestion); without distance its weight is redistributed proportionally."""
    wait, distance, congestion = max(0.0, wait), max(0.0, distance), max(0.0, congestion)
    if has_distance:
        return wait, distance, congestion
    remaining = wait + congestion
    if remaining <= 1e-12:
        # Only distance had weight: split it evenly between the two remaining factors.
        half = distance / 2.0
        return half, 0.0, half
    return wait + distance * wait / remaining, 0.0, congestion + distance * congestion / remaining


def _finite(value: Optional[float], default: float = 0.0) -> float:
    if value is None:
        return default
    value = float(value)
    return value if math.isfinite(value) else default


def rank_candidates(
    candidates: Sequence[Candidate], wait_weight: float, distance_weight: float, congestion_weight: float
) -> list[Ranked]:
    """Score and sort candidates ascending (best first). Ties keep the lower predicted wait first."""
    if not candidates:
        return []

    # Distance is used only if every candidate has one; a partial set cannot be compared fairly.
    has_distance = all(c.distance_km is not None for c in candidates)
    w_wait, w_dist, w_cong = effective_weights(wait_weight, distance_weight, congestion_weight, has_distance)

    norm_wait = min_max_normalise([max(0.0, _finite(c.predicted_wait_minutes)) for c in candidates])
    norm_cong = min_max_normalise([max(0.0, _finite(c.congestion_ratio)) for c in candidates])
    if has_distance:
        norm_dist = min_max_normalise([max(0.0, _finite(c.distance_km)) for c in candidates])
    else:
        norm_dist = [0.0] * len(candidates)

    scored = []
    for index, cand in enumerate(candidates):
        score = w_wait * norm_wait[index] + w_dist * norm_dist[index] + w_cong * norm_cong[index]
        scored.append((round(score, 4), _finite(cand.predicted_wait_minutes), index, cand))

    scored.sort(key=lambda item: (item[0], item[1], item[2]))
    return [Ranked(branch_id=c.branch_id, doctor_id=c.doctor_id, score=s) for s, _, _, c in scored]
