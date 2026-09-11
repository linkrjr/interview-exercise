import json

import pytest
from typer.testing import CliRunner

from circumvent.report import app


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def make_log_file(tmp_path):
    """Writes a .jsonl file from a list of lines and returns its path.

    Each item in `lines` is written as-is if it's already a string,
    otherwise it's json.dumps()-encoded. This lets tests mix well-formed
    dicts with deliberately malformed raw strings in the same file.
    """

    def _make(lines, name: str = "logs.jsonl"):
        path = tmp_path / name
        with path.open("w", encoding="utf-8") as f:
            for line in lines:
                text = line if isinstance(line, str) else json.dumps(line)
                f.write(text + "\n")
        return path

    return _make


@pytest.fixture
def run_report(runner, make_log_file):
    """Writes `lines` to a log file, invokes the CLI, and returns
    (result, parsed_json) where parsed_json is None if stdout wasn't
    valid JSON (e.g. the CLI errored before producing a report).
    """

    def _run(lines, name: str = "logs.jsonl"):
        path = make_log_file(lines, name=name)
        result = runner.invoke(app, [str(path)])
        parsed = None
        if result.exit_code == 0:
            parsed = json.loads(result.stdout)
        return result, parsed

    return _run


def log_entry(
    request_id="req-1",
    timestamp="2024-01-15T10:00:00Z",
    client_id="client-1",
    endpoint="/v1/widgets",
    status_code=200,
):
    return {
        "request_id": request_id,
        "timestamp": timestamp,
        "client_id": client_id,
        "endpoint": endpoint,
        "status_code": status_code,
    }
