# Cross-Lingual Dictionary Externalization

## Problem

`translateQueryCrossLingual()` in `index.ts` has a hardcoded `domainDict` with only 25 Korean→English terms. Cross-lingual search fails for any term not in this small dictionary. The function itself works correctly — the dictionary is just too small and not expandable without code changes.

Additionally, the implementation is Korean-only (detection regex `[\uAC00-\uD7A3]`, cleanup regex `[\uAC00-\uD7A3]+`), so non-Korean/non-English users cannot use cross-lingual search at all.

## Solution

1. **Externalize dictionary** — Replace hardcoded `domainDict` with `.memory/dictionary.json` file read
2. **Generalize language detection** — Korean-specific regex → non-English detection (`[^\x00-\x7F]`)
3. **No new features** — Keep existing `translateQueryCrossLingual()` logic, only change data source and detection scope

## Dictionary Format

```json
{
  "native-en": {
    "정지": "suspension",
    "철회": "withdrawal",
    "절차": "procedure",
    "인증기관": "certification body"
  },
  "en-native": {
    "suspension": "정지",
    "withdrawal": "철회",
    "procedure": "절차",
    "certification body": "인증기관"
  }
}
```

- Direction-separated for accuracy (mappings can be asymmetric)
- Object key lookup for O(1) efficiency
- Any language pair supported (Korean, Arabic, Malay, etc.)
- Users expand by editing JSON — no code changes, no npm publish

## Changes to index.ts

### 1. New: `loadDictionary()` method
- Read `.memory/dictionary.json` relative to `DB_FILE_PATH`
- Parse and cache in memory
- Return empty objects on file-not-found (graceful fallback)

### 2. Modify: `translateQueryCrossLingual()` (line 1246-1295)
- Remove hardcoded `domainDict` (line 1250-1261)
- Call `loadDictionary()` to get `native-en` mapping
- Keep entity observation `한국어명:` auto-expansion (line 1264-1281) — still useful as supplementary source
- Change Korean-only cleanup regex to non-ASCII: `[^\x00-\x7F]+` → remove untranslated non-English chars

### 3. Modify: `hybridSearch()` (line 2216)
- Change `const hasKorean = /[\uAC00-\uD7A3]/.test(query)` to `const hasNonEnglish = /[^\x00-\x7F]/.test(query)`

### 4. No changes to:
- `embedChunks()` — unchanged
- `chunkDocument()` — unchanged
- `searchNodes()` — unchanged (uses same embedding pipeline)
- Any other tool

## Fallback Behavior

| Condition | Behavior |
|-----------|----------|
| `.memory/dictionary.json` exists | Load and use for translation |
| File not found | Empty dictionary, no translation (existing behavior minus 25 hardcoded terms) |
| File malformed | Log warning, empty dictionary |
| `native-en` key missing | No native→English translation |
| `en-native` key missing | No English→native translation |

## File Location

Dictionary path derived from `DB_FILE_PATH` environment variable:
- `DB_FILE_PATH=/path/to/project/.memory/rag-memory.db`
- Dictionary: `/path/to/project/.memory/dictionary.json`

This ensures per-project dictionary isolation (same as DB isolation).

## Scope

- **In scope**: Dictionary externalization, language detection generalization
- **Out of scope**: Auto-generating dictionary entries, LLM translation, embed-time bilingual injection
