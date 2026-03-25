# Cross-Lingual Dictionary Externalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded 25-word Korean→English dictionary with external `.memory/dictionary.json`, generalize language detection to support any language pair.

**Architecture:** Add `loadDictionary()` to read external JSON from same directory as DB. Modify `translateQueryCrossLingual()` to use loaded dictionary instead of hardcoded one. Change Korean-specific regex to non-English detection in `hybridSearch()`.

**Tech Stack:** TypeScript, Node.js fs, path (already imported)

---

### Task 1: Add `loadDictionary()` method

**Files:**
- Modify: `index.ts` — add method to the `RagKnowledgeGraphManager` class (after line 1242)

- [ ] **Step 1: Add dictionary cache property**

At the class property declarations area, add:

```typescript
private dictionaryCache: { nativeToEn: Record<string, string>; enToNative: Record<string, string> } | null = null;
```

- [ ] **Step 2: Add `loadDictionary()` method**

Insert after `cleanupDocument()` method (after line 1242), before `translateQueryCrossLingual()`:

```typescript
private loadDictionary(): { nativeToEn: Record<string, string>; enToNative: Record<string, string> } {
  if (this.dictionaryCache) return this.dictionaryCache;

  const empty = { nativeToEn: {}, enToNative: {} };

  try {
    const dictPath = path.join(path.dirname(DB_FILE_PATH), 'dictionary.json');
    const raw = fs.readFileSync(dictPath, 'utf-8');
    const parsed = JSON.parse(raw);

    this.dictionaryCache = {
      nativeToEn: parsed['native-en'] && typeof parsed['native-en'] === 'object' ? parsed['native-en'] : {},
      enToNative: parsed['en-native'] && typeof parsed['en-native'] === 'object' ? parsed['en-native'] : {},
    };

    console.error(`📖 Dictionary loaded: ${Object.keys(this.dictionaryCache.nativeToEn).length} native→en, ${Object.keys(this.dictionaryCache.enToNative).length} en→native`);
    return this.dictionaryCache;
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`⚠️ Dictionary load warning: ${err.message}`);
    }
    this.dictionaryCache = empty;
    return empty;
  }
}
```

- [ ] **Step 3: Add fs import if missing**

Check top of file — `fs` should already be imported. If not, add:

```typescript
import fs from 'fs';
```

- [ ] **Step 4: Build and verify no errors**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 5: Commit**

```bash
git add index.ts
git commit -m "feat: add loadDictionary() for external .memory/dictionary.json"
```

---

### Task 2: Modify `translateQueryCrossLingual()` to use external dictionary

**Files:**
- Modify: `index.ts:1246-1295`

- [ ] **Step 1: Replace hardcoded domainDict with loadDictionary()**

Replace lines 1249-1261 (the hardcoded `domainDict` declaration) with:

```typescript
    const { nativeToEn } = this.loadDictionary();
    const domainDict: Record<string, string> = { ...nativeToEn };
```

- [ ] **Step 2: Change cleanup regex from Korean-only to non-ASCII**

Replace line 1292:

```typescript
    // OLD: translated = translated.replace(/[\uAC00-\uD7A3]+/g, ' ').replace(/\s+/g, ' ').trim();
    // NEW: Remove remaining non-ASCII characters and clean up
    translated = translated.replace(/[^\x00-\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: translateQueryCrossLingual uses external dictionary, generalized non-ASCII cleanup"
```

---

### Task 3: Generalize language detection in `hybridSearch()`

**Files:**
- Modify: `index.ts:2215-2224`

- [ ] **Step 1: Change Korean detection to non-English detection**

Replace line 2216:

```typescript
    // OLD: const hasKorean = /[\uAC00-\uD7A3]/.test(query);
    // NEW: Detect any non-ASCII characters (Korean, Arabic, CJK, etc.)
    const hasNonEnglish = /[^\x00-\x7F]/.test(query);
```

- [ ] **Step 2: Update variable reference**

Replace line 2219:

```typescript
    // OLD: if (hasKorean) {
    if (hasNonEnglish) {
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: generalize cross-lingual detection from Korean-only to any non-English"
```

---

### Task 4: Create sample dictionary and test end-to-end

**Files:**
- Create: Sample `dictionary.json` for testing (in project's `.memory/` directory)

- [ ] **Step 1: Create sample dictionary.json**

Create `.memory/dictionary.json` in the test project (the RAGMemory project or Halal project):

```json
{
  "native-en": {
    "할랄": "halal",
    "인증": "certification",
    "인증기관": "certification body",
    "상호인정": "mutual recognition",
    "인정": "accreditation",
    "표준": "standard",
    "감사": "audit",
    "심사": "audit review",
    "도축": "slaughter",
    "도축장": "slaughterhouse",
    "식품": "food",
    "화장품": "cosmetics",
    "수출": "export",
    "수입": "import",
    "무역": "trade",
    "정지": "suspension",
    "철회": "withdrawal",
    "절차": "procedure",
    "요건": "requirements",
    "적합성": "conformity",
    "부적합": "nonconformity",
    "감시심사": "surveillance audit",
    "갱신": "renewal",
    "범위": "scope",
    "시정조치": "corrective action",
    "이의제기": "appeal",
    "불만": "complaint",
    "공정성": "impartiality",
    "의약품": "pharmaceuticals",
    "방문": "visit",
    "협력": "cooperation",
    "협약": "agreement",
    "제안": "proposal",
    "회의": "meeting",
    "이메일": "email",
    "보고서": "report",
    "전략": "strategy",
    "사업": "business",
    "정부": "government",
    "지원": "support",
    "바우처": "voucher",
    "창업": "startup",
    "대학": "university"
  },
  "en-native": {
    "halal": "할랄",
    "certification": "인증",
    "certification body": "인증기관",
    "mutual recognition": "상호인정",
    "accreditation": "인정",
    "standard": "표준",
    "audit": "감사",
    "audit review": "심사",
    "slaughter": "도축",
    "slaughterhouse": "도축장",
    "food": "식품",
    "cosmetics": "화장품",
    "export": "수출",
    "import": "수입",
    "trade": "무역",
    "suspension": "정지",
    "withdrawal": "철회",
    "procedure": "절차",
    "requirements": "요건",
    "conformity": "적합성",
    "nonconformity": "부적합",
    "surveillance audit": "감시심사",
    "renewal": "갱신",
    "scope": "범위",
    "corrective action": "시정조치",
    "appeal": "이의제기",
    "complaint": "불만",
    "impartiality": "공정성",
    "pharmaceuticals": "의약품"
  }
}
```

- [ ] **Step 2: Rebuild and restart MCP server**

```bash
cd /Users/heesongkoh/Development/rag-memory-epf-mcp
npm run build
```

Restart Claude Code to reload MCP.

- [ ] **Step 3: Test cross-lingual search**

Test queries via `hybridSearch`:
1. `"할랄 인증기관 정지 철회 절차"` — should now translate "정지"→"suspension", "철회"→"withdrawal", "절차"→"procedure"
2. `"도축장 할랄 인증 심사 요건"` — should translate all terms
3. English query `"suspension withdrawal"` — should work as before (no translation needed)

Verify: `console.error` output shows `📖 Dictionary loaded: N native→en, M en→native` and `🌐 Cross-lingual: "..." → "..."` with full translation.

- [ ] **Step 4: Version bump and publish**

```bash
# Update version in package.json: 1.9.0 → 1.10.0
npm version minor
npm run build
npm publish
git push && git push --tags
```

- [ ] **Step 5: Final commit if any remaining changes**

```bash
git add -A
git commit -m "feat: cross-lingual dictionary externalization v1.10.0"
```
