# Script data protocol compatibility

Run with a supported Node.js version (18–22):

```sh
node --test tests/*.test.js
```

`spiderDataAdapters.test.js` checks the public data contract and protocol
selection. `spiderGateway.test.js` runs the actual gateway and child-process
bootstrap against synthetic scripts and a **loopback-only** pan server; it does
not need credentials or contact real pan services.

## Adapter boundary

The read-only management probes in `src/util/onlineScriptAdapters.js` select both
the credential adapter and the data adapter:

| Detected protocol | Data adapter | Detail/play behavior |
| --- | --- | --- |
| `website-v1` | `cat-open-v1` | Existing Cat/Open contract and legacy mock codec |
| `website-api-v1` | `pan-service-v1` | Native Base64 JSON episode IDs; mock share conversion |
| Unknown | Legacy-compatible fallback | No guessing from filenames, IDs, authors or site names |

The public contract remains `list[].vod_play_from`, `list[].vod_play_url` and
`pan_mock` for detail; `parse`, `url`, `header` plus existing extension fields for
play. No new client-side envelope or script-specific MeowFilm branch is needed.

- **Mock off:** preserve native episode IDs, modes and qualities. The
  client returns the opaque ID and flag to the original script for playback.
  Legacy flags that collide with builtin pan routing use a reversible `原生-`
  prefix; the legacy request adapter restores the original flag on `/play`.
  Already-prefixed native labels are escaped too, avoiding ambiguity. Modern
  native flags are preserved rather than renamed to mock flags.
- **Mock on:** translate supported PanService share tracks into the existing
  `夸父-`, `优夕-`, `百度原画-`, `天意-`, `逸动-` flags, with the access code in the
  aligned URL slot (empty string for no code). Multiple quality tracks of a
  share become one list request; different shares remain distinct. Duplicate
  share flags prefer the first non-empty code because the client keys requests
  by flag, not by password.
- Direct streams, unsupported providers and malformed/unknown native IDs stay
  intact rather than receiving invented share IDs. Native play errors are not
  converted into successful responses.
- Each gateway request snapshots the mock mode. The child receives that snapshot
  via an overwritten internal header and uses async-local context throughout
  the operation. Cache keys also isolate mode, protocol, runtime generation,
  caller identity and query context. Play responses are never spider-cached.
- The mock transport recognizes **request formats**: mobile/139 supports both
  AES-CBC and plain JSON; Tianyi supports separate access-code parameters and
  an access code embedded in `shareCode`.

To support another wire protocol, add a read-only probe/identification rule and
its data adapter with request/response tests. Do not key compatibility on the
script download URL, filename, runtime ID or site label. Existing adapters may
be reused when the data protocol is unchanged.
