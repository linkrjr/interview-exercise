from dataclasses import dataclass


@dataclass
class RateLimitTracker:
    last_log_entry_time: float
    tokens: int


# this gives us a threshold of 3 requests in 1 second, which is a common rate limit for APIs
MAX_TOKENS = 3
RATE_LIMIT_THRESHOLD = 1.0


def validate_rate_limit(tracker: RateLimitTracker, current: float) -> bool:
    if current - tracker.last_log_entry_time <= RATE_LIMIT_THRESHOLD:
        tracker.tokens += 1
    else:
        tracker.tokens = 0
    return tracker.tokens >= MAX_TOKENS
