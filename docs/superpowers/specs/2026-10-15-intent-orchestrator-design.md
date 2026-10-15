# Intent orchestrator

## Problem

Typed instructions are interpreted partly by keyword matching:

- `parseIntent` (regex) builds the trade for an ordinary swap, so a paraphrase with no
  swap/convert/trade/sell word falls to the default buy of WETH.
- `isSelfContained` decides by an action-word and ticker list whether the model is asked at all.
- Unreadable or unrelated text ("I want to go jogging") still reaches the agents as a market buy.
- The reader and the clarifier are two separate model calls, and neither can say "this is not
  something Intent does" or "tell me what I can do".

## Outcome

One orchestrator model call sees every message before any keyword code and returns one of:

| outcome        | meaning                                                  | client behaviour                                    |
| -------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `act`          | a complete, understood instruction                       | structured reading builds the trade; agents race    |
| `ask`          | something material is missing, or the meaning is unclear | one follow-up question; always asked, never guessed |
| `help`         | the user asks what they can do                           | fixed capability list, nothing runs                 |
| `out_of_scope` | unrelated to Intent (jogging, weather)                   | fixed "outside what Intent does" message            |

## Decisions

- Single route `POST /api/intent/orchestrate`, tool `orchestrate`. Replaces the parse and clarify
  round trips for the chat; the old routes stay for other callers.
- `act` carries the existing `read_intent` fields plus a standalone `instruction` and a `facts`
  brief for the agents. Server-side validation (tradeable symbols, lendable-only assets, venues,
  anchors, size sanity) is unchanged and applied to the `act` reading.
- `help` and `out_of_scope` copy is fixed and rendered by the client from what the chain
  supports. The model never writes it, so it cannot invent features.
- Model outage, timeout or an unusable reply: "I can't read that right now, try again." No regex
  fallback, no default asset.
- Question cap stays at four. At the cap the chat says it could not pin the request down and
  asks the user to rephrase; it does not run a guess.
- The structured reading builds `ParsedIntent` through `buildParsedIntent`, extracted from
  `parseIntent`. `parseIntent` stays for the evals runner and non-chat callers.
- The perp and offramp-only field extractors still run, but only on the orchestrator's `act`
  instruction. They extract fields; they no longer decide whether the text is an instruction.

## Testing

- Unit: outcome mapping, validation of `act`, outage, unknown-field fallbacks (mocked fetch).
- Route: each outcome, allowlist and lendable-only rejection, not configured.
- `buildParsedIntent`: matches `parseIntent` on the same reading.
- Live (skipped with the other live tests): paraphrase, off-topic and help sentences.
