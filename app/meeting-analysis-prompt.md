You are given the raw JSON output of a meeting diarizer. It contains a `segments` array of
`{speaker, start, end, text}` entries ordered by time (speaker is an enrolled name, "Speaker A/B/…"
for consistent-but-unknown voices, or "UNKNOWN"), plus a `speaker_report` with identification
detail you can use for context.

Produce a markdown document with exactly these sections:

# Meeting Analysis

## Summary
A concise paragraph or two: what the meeting was about and what was accomplished.

## Attendees
The speakers who appear, one per line, with approximate share of speaking time if available.

## Decisions
Bulleted list of decisions made. If none, write "None recorded."

## Action Items
Bulleted list, each with the owner (speaker name) when identifiable. If none, write "None recorded."

## Transcript
A cleaned, readable transcript: merge consecutive segments from the same speaker, fix obvious
transcription artifacts (stutters, filler words, mis-punctuation) without changing meaning, and
label each turn as `**Name:**`. Keep UNKNOWN/Speaker letters as-is — never guess an identity.

Rules: output only the markdown document, no preamble or commentary. Do not invent content that is
not supported by the transcript.
