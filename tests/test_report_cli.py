from .conftest import log_entry


class TestValidInput:
    def test_single_entry_produces_single_client(self, run_report):
        result, report = run_report([log_entry()])

        assert result.exit_code == 0
        assert report["malformed_lines"] == 0
        assert set(report["clients"]) == {"client-1"}
        client = report["clients"]["client-1"]
        assert client["total_requests"] == 1
        assert client["rate_limit_violated"] is False
        assert len(client["logs"]) == 1
        assert client["logs"][0]["request_id"] == "req-1"

    def test_multiple_entries_same_client_accumulate(self, run_report):
        lines = [
            log_entry(request_id="r1", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="r2", timestamp="2024-01-15T10:00:05Z"),
            log_entry(request_id="r3", timestamp="2024-01-15T10:00:10Z"),
        ]
        result, report = run_report(lines)

        assert result.exit_code == 0
        client = report["clients"]["client-1"]
        assert client["total_requests"] == 3
        assert [e["request_id"] for e in client["logs"]] == ["r1", "r2", "r3"]

    def test_multiple_clients_are_tracked_separately(self, run_report):
        lines = [
            log_entry(request_id="a1", client_id="client-a"),
            log_entry(request_id="b1", client_id="client-b"),
            log_entry(request_id="a2", client_id="client-a"),
        ]
        result, report = run_report(lines)

        assert result.exit_code == 0
        assert set(report["clients"]) == {"client-a", "client-b"}
        assert report["clients"]["client-a"]["total_requests"] == 2
        assert report["clients"]["client-b"]["total_requests"] == 1

    def test_empty_file_produces_empty_report(self, run_report):
        result, report = run_report([])

        assert result.exit_code == 0
        assert report == {"clients": {}, "malformed_lines": 0}


class TestMalformedInput:
    def test_invalid_json_line_is_counted_as_malformed(self, run_report):
        result, report = run_report(["{not valid json"])

        assert result.exit_code == 0
        assert report["clients"] == {}
        assert report["malformed_lines"] == 1

    def test_blank_line_is_counted_as_malformed(self, run_report):
        result, report = run_report([""])

        assert result.exit_code == 0
        assert report["malformed_lines"] == 1

    def test_missing_required_field_is_counted_as_malformed(self, run_report):
        entry = log_entry()
        del entry["status_code"]
        result, report = run_report([entry])

        assert result.exit_code == 0
        assert report["clients"] == {}
        assert report["malformed_lines"] == 1

    def test_wrong_field_type_is_counted_as_malformed(self, run_report):
        entry = log_entry()
        entry["status_code"] = "200"
        result, report = run_report([entry])

        assert result.exit_code == 0
        assert report["malformed_lines"] == 1

    def test_unexpected_field_is_counted_as_malformed(self, run_report):
        entry = log_entry()
        entry["unexpected"] = "nope"
        result, report = run_report([entry])

        assert result.exit_code == 0
        assert report["malformed_lines"] == 1

    def test_malformed_lines_do_not_affect_valid_clients(self, run_report):
        lines = [
            log_entry(request_id="r1"),
            "{not valid json",
            log_entry(request_id="r2"),
        ]
        result, report = run_report(lines)

        assert result.exit_code == 0
        assert report["malformed_lines"] == 1
        assert report["clients"]["client-1"]["total_requests"] == 2


class TestRateLimitViolation:
    def test_four_rapid_requests_trigger_violation(self, run_report):
        lines = [
            log_entry(request_id="r1", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="r2", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="r3", timestamp="2024-01-15T10:00:01Z"),
            log_entry(request_id="r4", timestamp="2024-01-15T10:00:01Z"),
        ]
        result, report = run_report(lines)

        assert result.exit_code == 0
        assert report["clients"]["client-1"]["rate_limit_violated"] is True

    def test_requests_spaced_out_do_not_trigger_violation(self, run_report):
        lines = [
            log_entry(request_id="r1", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="r2", timestamp="2024-01-15T10:00:02Z"),
            log_entry(request_id="r3", timestamp="2024-01-15T10:00:04Z"),
            log_entry(request_id="r4", timestamp="2024-01-15T10:00:06Z"),
        ]
        result, report = run_report(lines)

        assert result.exit_code == 0
        assert report["clients"]["client-1"]["rate_limit_violated"] is False

    def test_violation_is_sticky_even_after_a_later_slow_gap(self, run_report):
        lines = [
            log_entry(request_id="r1", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="r2", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="r3", timestamp="2024-01-15T10:00:01Z"),
            log_entry(request_id="r4", timestamp="2024-01-15T10:00:01Z"),
            log_entry(request_id="r5", timestamp="2024-01-15T10:05:00Z"),
        ]
        result, report = run_report(lines)

        assert result.exit_code == 0
        client = report["clients"]["client-1"]
        assert client["rate_limit_violated"] is True
        assert client["total_requests"] == 5

    def test_violations_are_tracked_independently_per_client(self, run_report):
        lines = [
            log_entry(request_id="a1", client_id="client-a", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="a2", client_id="client-a", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="a3", client_id="client-a", timestamp="2024-01-15T10:00:01Z"),
            log_entry(request_id="a4", client_id="client-a", timestamp="2024-01-15T10:00:01Z"),
            log_entry(request_id="b1", client_id="client-b", timestamp="2024-01-15T10:00:00Z"),
            log_entry(request_id="b2", client_id="client-b", timestamp="2024-01-15T10:00:10Z"),
        ]
        result, report = run_report(lines)

        assert result.exit_code == 0
        assert report["clients"]["client-a"]["rate_limit_violated"] is True
        assert report["clients"]["client-b"]["rate_limit_violated"] is False


class TestCliArgumentHandling:
    def test_missing_file_path_errors_out(self, runner):
        from circumvent.report import app

        result = runner.invoke(app, ["/no/such/file.jsonl"])
        assert result.exit_code != 0

    def test_directory_path_errors_out(self, runner, tmp_path):
        from circumvent.report import app

        result = runner.invoke(app, [str(tmp_path)])
        assert result.exit_code != 0
