import dataclasses
import json
from dataclasses import dataclass, field
from pathlib import Path

import typer

from .log_entry import LogEntry, validate_log_entry
from .rate_limit import RateLimitTracker, validate_rate_limit

app = typer.Typer()

options = typer.Argument(exists=True, file_okay=True, dir_okay=False)


@dataclass
class Client:
    logs: list[LogEntry] = field(default_factory=list, init=True)
    rate_limit_violated: bool = field(init=True, default=False)
    total_requests: int = field(init=True, default=0)

    def add_log_entry(self, log_entry):
        self.logs.append(log_entry)
        self.total_requests += 1


@dataclass
class Report:
    clients: dict[str, Client]
    malformed_lines: int


@app.command()
def generate(
    filepath: Path = options,
) -> None:
    """Generates the report for the provided log file"""

    malformed_lines = 0
    track_client_rate_limit_violation = {}
    report = Report({}, 0)

    with filepath.open(encoding="utf-8") as file:
        for line in file:
            try:
                parsed = json.loads(line)
                log_entry = validate_log_entry(parsed)
                client_id = log_entry.client_id

                log_entry_time = log_entry.convert_timestamp()
                if client_id in report.clients:
                    client = Client(**report.clients[client_id])

                    client.add_log_entry(log_entry)

                    if not client.rate_limit_violated:
                        tracker = track_client_rate_limit_violation[client_id]
                        client.rate_limit_violated = validate_rate_limit(
                            tracker,
                            log_entry_time,
                        )
                        tracker.last_log_entry_time = log_entry_time

                    report.clients[client_id] = dataclasses.asdict(client)

                else:
                    client = Client()
                    client.add_log_entry(log_entry)

                    track_client_rate_limit_violation[client_id] = RateLimitTracker(
                        log_entry_time, 0
                    )
                    report.clients[client_id] = dataclasses.asdict(client)

            except Exception:
                malformed_lines += 1

    report.malformed_lines = malformed_lines
    typer.echo(json.dumps(dataclasses.asdict(report)))


if __name__ == "__main__":
    app()
