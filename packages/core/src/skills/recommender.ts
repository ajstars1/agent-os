const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'about', 'as', 'into', 'through', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'can', 'this', 'that', 'these', 'those', 'it', 'its', 'you', 'your',
  'me', 'my', 'we', 'our', 'i', 'use', 'using', 'used', 'get', 'run',
  'make', 'create', 'add', 'new', 'when', 'how', 'what', 'which', 'who',
]);

export interface SkillSuggestion {
  name: string;
  hint: string; // one-line description shown in prompt
  score: number;
}

interface IndexedSkill {
  name: string;
  hint: string;
  terms: Map<string, number>; // term → TF weight
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function buildTF(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const max = Math.max(1, ...freq.values());
  const tf = new Map<string, number>();
  for (const [t, f] of freq) tf.set(t, f / max);
  return tf;
}

/** Extract first sentence or up to 80 chars from description, stripping YAML artifacts. */
function extractHint(description: string): string {
  const first = description
    .replace(/^[\s|]+/gm, '')        // strip YAML block scalar leading chars
    .replace(/Use when.*/is, '')      // drop whenToUse portion
    .split(/[.\n]/)[0]
    ?.trim() ?? '';
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

/** Parse YAML frontmatter from SKILL.md content. Returns key→value map. */
function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return {};
  const result: Record<string, string> = {};
  // Handle simple key: value and key: | (block scalar)
  const lines = match[1].split('\n');
  let currentKey = '';
  let blockLines: string[] = [];

  for (const line of lines) {
    const kvMatch = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kvMatch) {
      // Flush previous block
      if (currentKey && blockLines.length > 0) {
        result[currentKey] = blockLines.join(' ').replace(/\s+/g, ' ').trim();
        blockLines = [];
      }
      const [, key, val] = kvMatch;
      if (val?.trim() === '|' || val?.trim() === '>') {
        currentKey = key ?? '';
      } else {
        currentKey = '';
        if (key && val !== undefined) result[key] = val.trim();
      }
    } else if (currentKey && line.startsWith('  ')) {
      blockLines.push(line.trim());
    }
  }
  if (currentKey && blockLines.length > 0) {
    result[currentKey] = blockLines.join(' ').replace(/\s+/g, ' ').trim();
  }
  return result;
}

export class SkillRecommender {
  private index: IndexedSkill[] = [];
  /** IDF weights: term → log(N / df) */
  private idf: Map<string, number> = new Map();

  /**
   * Build the index from raw SKILL.md file contents.
   * Call this whenever skills reload — it's cheap (no I/O, no LLM).
   */
  buildIndex(skills: Array<{ name: string; content: string }>): void {
    const parsed: Array<{ name: string; hint: string; tokens: string[] }> = [];

    for (const { name, content } of skills) {
      const fm = parseFrontmatter(content);
      const description = fm['description'] ?? '';
      const hint = extractHint(description);
      // Combine name + description + whenToUse-like text from description for scoring
      const combined = `${name} ${description}`.replace(/\s+/g, ' ');
      parsed.push({ name, hint, tokens: tokenize(combined) });
    }

    // Compute IDF across all skills
    const N = parsed.length;
    const df = new Map<string, number>();
    for (const { tokens } of parsed) {
      for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.idf = new Map();
    for (const [t, count] of df) {
      this.idf.set(t, Math.log((N + 1) / (count + 1)) + 1); // smoothed IDF
    }

    this.index = parsed.map(({ name, hint, tokens }) => ({
      name,
      hint,
      terms: buildTF(tokens),
    }));
  }

  /**
   * Score user message against the index.
   * Returns top suggestions sorted by TF-IDF cosine similarity, score > 0.
   * Zero tokens, pure arithmetic.
   */
  suggest(message: string, limit = 3, threshold = 0.04): SkillSuggestion[] {
    if (this.index.length === 0) return [];

    const queryTokens = tokenize(message);
    if (queryTokens.length === 0) return [];
    const queryTF = buildTF(queryTokens);

    // Build query TF-IDF vector
    const queryVec = new Map<string, number>();
    for (const [t, tf] of queryTF) {
      const idf = this.idf.get(t) ?? 1;
      queryVec.set(t, tf * idf);
    }
    const queryNorm = Math.sqrt([...queryVec.values()].reduce((s, v) => s + v * v, 0));
    if (queryNorm === 0) return [];

    const scored = this.index.map((skill) => {
      // Dot product of query and skill TF-IDF vectors
      let dot = 0;
      let skillNorm = 0;
      for (const [t, tf] of skill.terms) {
        const idf = this.idf.get(t) ?? 1;
        const skillWeight = tf * idf;
        skillNorm += skillWeight * skillWeight;
        const qWeight = queryVec.get(t) ?? 0;
        dot += qWeight * skillWeight;
      }
      const cosine = skillNorm > 0 ? dot / (queryNorm * Math.sqrt(skillNorm)) : 0;
      return { name: skill.name, hint: skill.hint, score: cosine };
    });

    return scored
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
