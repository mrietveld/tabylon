# Chunked Grouping Algorithm

The backend groups tabs iteratively when a request is too large to send to the LLM in one pass.

## Constants
- **Chunk size:** 32 tabs maximum per LLM call
- **Ungrouped retry threshold:** retry if more than 12 tabs remain ungrouped
- **Minimum group size:** 5 tabs

## Flow
1. Start with the full tab list.
2. Split the current pending tab list into chunks of at most 32 tabs.
3. For each chunk:
   - send the chunk to the LLM embedding model

## Logging
The backend logs:
- start of each chunked grouping pass
- chunk number and size for each pass

This makes it easier to diagnose whether a failure happened:
- in an early chunk
