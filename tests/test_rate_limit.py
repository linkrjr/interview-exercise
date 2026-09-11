from circumvent.rate_limit.rate_limit import (
    MAX_TOKENS,
    RATE_LIMIT_THRESHOLD,
    RateLimitTracker,
    validate_rate_limit,
)


def advance(tracker: RateLimitTracker, current: float) -> bool:
    """Mirrors how report.py drives the tracker: check, then move the clock."""
    result = validate_rate_limit(tracker, current)
    tracker.last_log_entry_time = current
    return result


class TestValidateRateLimit:
    def test_constants_match_expected_policy(self):
        assert MAX_TOKENS == 3
        assert RATE_LIMIT_THRESHOLD == 1.0

    def test_single_close_request_is_not_a_violation(self):
        tracker = RateLimitTracker(last_log_entry_time=0.0, tokens=0)
        assert advance(tracker, 0.5) is False
        assert tracker.tokens == 1

    def test_gap_exactly_at_threshold_counts_as_within_limit(self):
        tracker = RateLimitTracker(last_log_entry_time=0.0, tokens=0)
        assert advance(tracker, 1.0) is False
        assert tracker.tokens == 1

    def test_gap_beyond_threshold_resets_tokens(self):
        tracker = RateLimitTracker(last_log_entry_time=0.0, tokens=2)
        assert advance(tracker, 1.5) is False
        assert tracker.tokens == 0

    def test_reaching_max_tokens_signals_violation(self):
        tracker = RateLimitTracker(last_log_entry_time=0.0, tokens=0)
        assert advance(tracker, 0.2) is False  # tokens=1
        assert advance(tracker, 0.4) is False  # tokens=2
        assert advance(tracker, 0.6) is True  # tokens=3 -> violated

    def test_violation_stays_true_while_requests_stay_close(self):
        tracker = RateLimitTracker(last_log_entry_time=0.0, tokens=3)
        assert advance(tracker, 0.2) is True
        assert tracker.tokens == 4

    def test_slow_requests_never_trigger_violation(self):
        tracker = RateLimitTracker(last_log_entry_time=0.0, tokens=0)
        for t in (2.0, 4.0, 6.0, 8.0):
            assert advance(tracker, t) is False
        assert tracker.tokens == 0

    def test_violation_resets_after_a_slow_gap(self):
        tracker = RateLimitTracker(last_log_entry_time=0.0, tokens=0)
        assert advance(tracker, 0.2) is False
        assert advance(tracker, 0.4) is False
        assert advance(tracker, 0.6) is True
        assert advance(tracker, 5.0) is False
        assert tracker.tokens == 0
