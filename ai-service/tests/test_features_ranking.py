"""Unit tests: Section 6.3 feature handling, Eq. 6.2 baseline and Eq. 6.3 ranking (FR-08)."""

from __future__ import annotations

import pytest

from app.features import FEATURES, baseline_minutes, prepare_frame
from app.ranking import Candidate, effective_weights, min_max_normalise, rank_candidates

CONTRACT_FEATURES = [
    "patients_ahead", "priority_ahead", "doctor_avg_consult", "doctor_recent_consult",
    "interruptions_last_hour", "session_started", "minutes_to_start", "hour_of_day", "day_of_week",
    "appointments_ahead", "department_load", "doctor_id", "department_id", "branch_id",
]


# --------------------------------------------------------------------------- features / baseline


def test_feature_order_matches_contract():
    assert FEATURES == CONTRACT_FEATURES
    frame = prepare_frame([{"patients_ahead": 3, "unknown_key": 5}])
    assert list(frame.columns) == CONTRACT_FEATURES


def test_prepare_frame_fills_missing_values_consistently():
    frame = prepare_frame([{"patients_ahead": 2, "doctor_avg_consult": 12, "session_started": True}])
    row = frame.iloc[0]
    assert row["doctor_recent_consult"] == 12  # falls back to the doctor's average
    assert row["session_started"] == 1.0  # booleans become 0/1
    assert row["interruptions_last_hour"] == 0.0
    assert prepare_frame([{"patients_ahead": 1}]).iloc[0]["doctor_avg_consult"] == 10.0


def test_baseline_before_session_start_adds_delay():
    # Eq. 6.2: n_ahead * c_doctor + d_start; the priority token ahead is already in patients_ahead
    features = {"patients_ahead": 4, "priority_ahead": 1, "doctor_avg_consult": 8, "session_started": 0, "minutes_to_start": 15}
    assert baseline_minutes(features) == pytest.approx(4 * 8 + 15)


def test_baseline_ignores_start_delay_once_started():
    features = {"patients_ahead": 4, "priority_ahead": 1, "doctor_avg_consult": 8, "session_started": True, "minutes_to_start": 15}
    assert baseline_minutes(features) == pytest.approx(32)


def test_baseline_does_not_double_count_priority_tokens():
    without = {"patients_ahead": 3, "priority_ahead": 0, "doctor_avg_consult": 10, "session_started": 1}
    with_priority = dict(without, priority_ahead=3)  # all three patients ahead are priority tokens
    assert baseline_minutes(with_priority) == baseline_minutes(without) == pytest.approx(30)


def test_baseline_is_never_negative():
    assert baseline_minutes({"patients_ahead": 0, "doctor_avg_consult": 9, "minutes_to_start": -5}) == 0


# --------------------------------------------------------------------------- ranking (Eq. 6.3)


def test_min_max_normalisation():
    assert min_max_normalise([0, 5, 10]) == [0.0, 0.5, 1.0]
    assert min_max_normalise([7, 7, 7]) == [0.0, 0.0, 0.0]  # all equal -> 0
    assert min_max_normalise([42]) == [0.0]
    assert min_max_normalise([]) == []


def test_distance_weight_is_redistributed_proportionally():
    wait, distance, congestion = effective_weights(0.6, 0.25, 0.15, has_distance=False)
    assert distance == 0.0
    assert wait == pytest.approx(0.6 + 0.25 * 0.6 / 0.75)  # 0.8
    assert congestion == pytest.approx(0.15 + 0.25 * 0.15 / 0.75)  # 0.2
    assert effective_weights(0.6, 0.25, 0.15, has_distance=True) == (0.6, 0.25, 0.15)


def _candidates(with_distance: bool) -> list[Candidate]:
    return [
        Candidate(branch_id=1, doctor_id=11, predicted_wait_minutes=60, distance_km=1.0 if with_distance else None, congestion_ratio=1.0),
        Candidate(branch_id=2, doctor_id=21, predicted_wait_minutes=30, distance_km=5.0 if with_distance else None, congestion_ratio=0.5),
        Candidate(branch_id=3, doctor_id=31, predicted_wait_minutes=45, distance_km=3.0 if with_distance else None, congestion_ratio=0.5),
    ]


def test_rank_with_distance():
    ranked = rank_candidates(_candidates(True), 0.6, 0.25, 0.15)
    # wait norm: 1, 0, .5; distance norm: 0, 1, .5; congestion norm: 1, 0, 0
    assert [r.branch_id for r in ranked] == [2, 3, 1]
    scores = {r.branch_id: r.score for r in ranked}
    assert scores[2] == pytest.approx(0.25)
    assert scores[3] == pytest.approx(0.3 + 0.125)
    assert scores[1] == pytest.approx(0.6 + 0.15)


def test_rank_without_distance_uses_redistributed_weights():
    ranked = rank_candidates(_candidates(False), 0.6, 0.25, 0.15)
    scores = {r.branch_id: r.score for r in ranked}
    assert [r.branch_id for r in ranked] == [2, 3, 1]
    assert scores[2] == pytest.approx(0.0)
    assert scores[3] == pytest.approx(0.8 * 0.5)
    assert scores[1] == pytest.approx(0.8 + 0.2)


def test_rank_all_equal_scores_zero():
    same = [Candidate(branch_id=b, doctor_id=None, predicted_wait_minutes=20, distance_km=2.0, congestion_ratio=0.3) for b in (1, 2)]
    assert [r.score for r in rank_candidates(same, 0.6, 0.25, 0.15)] == [0.0, 0.0]


def test_rank_branches_endpoint(client):
    body = {
        "weights": {"wait": 0.6, "distance": 0.25, "congestion": 0.15},
        "candidates": [
            {"branchId": 1, "doctorId": 11, "predictedWaitMinutes": 60, "distanceKm": None, "congestionRatio": 1.0},
            {"branchId": 2, "doctorId": 21, "predictedWaitMinutes": 30, "distanceKm": None, "congestionRatio": 0.5},
            {"branchId": 3, "doctorId": 31, "predictedWaitMinutes": 45, "distanceKm": None, "congestionRatio": 0.5},
        ],
    }
    response = client.post("/ai/rank-branches", json=body)
    assert response.status_code == 200, response.text
    ranked = response.json()["ranked"]
    assert [item["branchId"] for item in ranked] == [2, 3, 1]
    assert [item["doctorId"] for item in ranked] == [21, 31, 11]
    assert ranked[0]["score"] <= ranked[1]["score"] <= ranked[2]["score"]
    assert ranked[2]["score"] == pytest.approx(1.0)
