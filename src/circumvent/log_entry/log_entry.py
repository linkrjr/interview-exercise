from dataclasses import dataclass
from datetime import datetime

from jsonschema import validate

schema = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "request_id": {"type": "string"},
        "timestamp": {"type": "string"},
        "client_id": {"type": "string"},
        "endpoint": {"type": "string"},
        "status_code": {"type": "integer"},
    },
    "required": ["request_id", "timestamp", "client_id", "endpoint", "status_code"],
}


@dataclass
class LogEntry:
    request_id: str
    timestamp: str
    client_id: str
    endpoint: str
    status_code: int

    def convert_timestamp(self) -> float:
        dt_obj = datetime.strptime(self.timestamp, "%Y-%m-%dT%H:%M:%S%z")
        return dt_obj.timestamp()


def validate_log_entry(log_entry: dict) -> LogEntry:
    validate(
        instance=log_entry,
        schema=schema,
    )

    return LogEntry(**log_entry)
