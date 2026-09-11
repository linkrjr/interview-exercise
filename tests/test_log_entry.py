import pytest
from jsonschema.exceptions import ValidationError

from circumvent.log_entry.log_entry import LogEntry, validate_log_entry


class TestParseTimestamp:
    def test_parses_utc_offset(self):
        entry = LogEntry(
            request_id="r1",
            timestamp="2024-01-15T10:00:00+00:00",
            client_id="c1",
            endpoint="/x",
            status_code=200,
        )
        assert entry.convert_timestamp() == 1705312800.0

    def test_parses_z_suffix_as_utc(self):
        entry = LogEntry(
            request_id="r1",
            timestamp="2024-01-15T10:00:00Z",
            client_id="c1",
            endpoint="/x",
            status_code=200,
        )
        assert entry.convert_timestamp() == 1705312800.0

    def test_parses_non_utc_offset(self):
        entry = LogEntry(
            request_id="r1",
            timestamp="2024-01-15T10:00:00+05:30",
            client_id="c1",
            endpoint="/x",
            status_code=200,
        )
        # 10:00 +05:30 is 04:30 UTC
        assert entry.convert_timestamp() == 1705293000.0

    def test_two_timestamps_one_second_apart_differ_by_one(self):
        first = LogEntry("r1", "2024-01-15T10:00:00Z", "c1", "/x", 200)
        second = LogEntry("r2", "2024-01-15T10:00:01Z", "c1", "/x", 200)
        assert second.convert_timestamp() - first.convert_timestamp() == 1.0

    def test_malformed_timestamp_raises_value_error(self):
        entry = LogEntry(
            request_id="r1",
            timestamp="not-a-timestamp",
            client_id="c1",
            endpoint="/x",
            status_code=200,
        )
        with pytest.raises(ValueError):
            entry.convert_timestamp()

    def test_timestamp_missing_timezone_raises_value_error(self):
        entry = LogEntry(
            request_id="r1",
            timestamp="2024-01-15T10:00:00",
            client_id="c1",
            endpoint="/x",
            status_code=200,
        )
        with pytest.raises(ValueError):
            entry.convert_timestamp()


class TestValidateLogEntry:
    VALID = {
        "request_id": "req-1",
        "timestamp": "2024-01-15T10:00:00Z",
        "client_id": "client-1",
        "endpoint": "/v1/widgets",
        "status_code": 200,
    }

    def test_valid_entry_returns_log_entry(self):
        result = validate_log_entry(self.VALID)
        assert isinstance(result, LogEntry)
        assert result.request_id == "req-1"
        assert result.timestamp == "2024-01-15T10:00:00Z"
        assert result.client_id == "client-1"
        assert result.endpoint == "/v1/widgets"
        assert result.status_code == 200

    @pytest.mark.parametrize(
        "missing_field",
        ["request_id", "timestamp", "client_id", "endpoint", "status_code"],
    )
    def test_missing_required_field_raises(self, missing_field):
        payload = {k: v for k, v in self.VALID.items() if k != missing_field}
        with pytest.raises(ValidationError):
            validate_log_entry(payload)

    def test_wrong_type_for_status_code_raises(self):
        payload = {**self.VALID, "status_code": "200"}
        with pytest.raises(ValidationError):
            validate_log_entry(payload)

    def test_wrong_type_for_string_field_raises(self):
        payload = {**self.VALID, "client_id": 123}
        with pytest.raises(ValidationError):
            validate_log_entry(payload)

    def test_unexpected_additional_field_raises(self):
        payload = {**self.VALID, "extra_field": "not allowed"}
        with pytest.raises(ValidationError):
            validate_log_entry(payload)

    def test_non_object_instance_raises(self):
        with pytest.raises(ValidationError):
            validate_log_entry(["not", "an", "object"])
