# API Log Report CLI

## Solution Design

### What the program does, end to end

The command line ```report``` accepts an argument called, the filepath.
Once the command is invoke with the correct argument, it takes the following steps:

#### Regular Path

- Validates whether or not the file exists.
- Creates a set of variables required for the execution of the program
  - malformed_lines: keeps track of the number malformed lines
  - track_client_rate_limit_violation: tracks the rate limit violation per ```client_id```
- Opens the file for reading
- Loops through line by line - O(n)
- Parses each line, making sure it is valid json
- Validates the log entry, making sure it contains the required fields
- Reads the ```client_id```
- Reads the ```log_entry``` timestamp, parsed
- Checks if the ```client_id``` exists in the current report state
  - When the client_id exists
    - Reads the current ```client_id``` data from the report and creates a new client instance
    - Adds the new ```log_entry``` to it
    - Checks if the current ```client_id``` has already violated rate limit
      - If not, read the tracker for the client
      - Validates it against the current ```log_entry```
      - Set the tracker ```last_log_entry_time``` to the current ```log_entry_time```
    - Sets the client data back in the report

  - When the ```client_id``` does not exist
    - Creates a client instance
    - Adds a ```log_entry``` to it
    - Sets a rate limit tracker for the ```client_id```
    - Stores the newly created client in the report
- Includes the ```malformed_lines``` value
- Sends the final JSON to stdout

#### Exceptional Paths

- Fails with appropriate error message if unable to find the file.
- Throws ```json.JSONDecodeError``` if the line is not a valid JSON
- Throws ```ValidationError``` is line fails schema validation

### Rate Limit

The rate limit algorithm here assumes that all we want is to verify whether or not a client has at some point hit the limit, so it uses a variation of the Token Bucket algorithm, that instead of give more tokens as the requests spread out, it resets the counter everytime a new request respects the threshold, meaning the client did not violate the limit and so we can start count again.

This implementation is not one of the established industry algorithms, it is sometimes know as ```consecutive burst counter```, it's cheap (two values per client, a timestamp and an integer), and it specifically targets burst behavior, rapid-fire consecutive requests, rather than a total count over a fixed period. This makes it popular for things like login-attempt throttling, double-click/double-submit protection, or catching scripted clients hammering an endpoint faster than a human plausibly could.

Since we don't have to actually limit requests here and, all we want is to verify whether or not a client has violated a limit, this version provides a simple and practical result.

A MAX_TOKENS of 3 and a RATE_LIMIT_THRESHOLD of 1s gives us a threshold of 3 requests in 1 second per client_id, which is a common rate limit for APIs.

### Output Specification

- [JSON Schema](specs/Report.schema.json)

- [Web version](https://linkrjr.github.io/interview-exercise/)

### Implementation decisions and assumptions made (and why)

- Empty lines are validated towards the malformed lines count
  - Reason: during development, I introduced an empty line to a test file and noticed the malformed counter increase, since the code was already catching that issue, I decided to keep it a flag as an assumption.
- Log entries in file are ordered by ```timestamp```
  - Reason: The rate limit implementation requires the logs entries to be ordered by timestamp
- ```timestamp``` must be a valid ISO-8601 timestamp like ```2024-01-15T10:00:00Z``` or ```2024-01-15T10:00:00+1000```, with no milliseconds precision, which will invalidate the line and set it as malformed.
  - Reason: The sample log provided assumes those formats, for simplicity reasons, the timestamp convert only uses them.

## Running the code

#### Setup the environment

This project uses UV, a python package and project manager.
To install uv, simply [follow the installation instructions in the uv documentation](https://docs.astral.sh/uv/getting-started/installation/).

#### Install the project globally

Make sure you are in the project directory and run the command
```
uv tool install . -e
```

#### Run it

Use any test file in the data folder to test different scenarios

```
report data/logs.jsonl
```

## What you'd do differently with more time

- I would probably have chosen my primary language (Typescript), I decided to use python just because I have been using it lately for some AI related projects, I thought this was a good chance to practice more;
- Would have improved on the way the MAX_TOKENS and RATE_LIMIT_THRESHOLD are stored, would have made this configurable with default values;
- The current rate limit ignore the requested url, limiting the user on ```client_id```. I would have changed that;
- Would have treated exception types separately rather than catching them all broadly;
- Would modify the rate limit so the log files do not require to be timestamp ordered;
- Would like to look into the timestamp format to include the milliseconds option;

## Whether/how you used AI tools

I have not used AI tools writing implementation code, all done manually, only used it (claude) for:
- Validate ideas since Python is not my primary language;
- Code review;
- Write tests;