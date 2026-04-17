/**
 * packages/core/src/memory/semantic-graph.ts
 * ==========================================
 * Semantic Memory layer backed by a Subject-Predicate-Object (SPO) knowledge
 * graph.  Permanent facts about the user are extracted from conversation text
 * by the local LLM router, then persisted in a lightweight graph store.
 *
 * ## Architecture
 *
 * ```
 *   text ──► extractAndStoreFacts()
 *              │
 *              ├─► LLM router (strict SPO extraction prompt)
 *              │        │
 *              │        └─► Triple[]
 *              │
 *              └─► storeTriples(triples)
 *                       │
 *                       └─► IGraphAdapter  ◄──── pluggable backend
 *                              │
 *                              ├── SqliteGraphAdapter  (default, zero-deps)
 *                              └── Neo4jGraphAdapter   (drop-in for prod)
 * ```
 *
 * ### Swapping to Neo4j
 * Pass a `Neo4jGraphAdapter` instance to `SemanticGraph`:
 * ```ts
 * import neo4j from 'neo4j-driver';
 * const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
 * const graph = new SemanticGraph({ adapter: new Neo4jGraphAdapter(driver) });
 * ```
 *
 * ### Default (SQLite)
 * ```ts
 * const graph = new SemanticGraph();                  // in-memory SQLite
 * const graph = new SemanticGraph({ dbPath: './kg.db' }); // persistent file
 * ```
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Triple types
// ---------------------------------------------------------------------------

/**
 * A Subject-Predicate-Object triple representing a permanent fact about
 * the user extracted from conversation text.
 *
 * @example
 * ```json
 * { "subject": "user", "predicate": "lives in", "object": "Paris" }
 * ```
 */
export interface Triple {
  /** The entity the fact is about (often "user", or a named entity). */
  subject: string;
  /** The relationship or property name (verb phrase or attribute). */
  predicate: string;
  /** The value, object entity, or concept being asserted. */
  object: string;
}

/**
 * Result returned by {@link SemanticGraph.extractAndStoreFacts}.
 */
export interface ExtractionResult {
  /** Raw triples produced by the LLM extraction pass. */
  triples: Triple[];
  /** Number of triples that were new (not already in the store). */
  stored: number;
  /** Number of triples that were duplicates and skipped. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// IGraphAdapter — pluggable graph database interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface that any graph backend must implement.
 * Both {@link SqliteGraphAdapter} and {@link Neo4jGraphAdapter} satisfy this
 * contract, making the backend fully swappable via dependency injection.
 */
export interface IGraphAdapter {
  /**
   * Persist a single triple.  Implementations SHOULD be idempotent: if an
   * identical (subject, predicate, object) triple already exists the store
   * should silently do nothing rather than creating a duplicate.
   *
   * @returns `true` if the triple was newly inserted, `false` if it already existed.
   */
  upsertTriple(triple: Triple): Promise<boolean>;

  /**
   * Query all triples where `subject` matches.
   *
   * @param subject - Exact subject string to filter on.
   */
  queryBySubject(subject: string): Promise<Triple[]>;

  /**
   * Query all triples where `predicate` matches.
   *
   * @param predicate - Exact predicate string to filter on.
   */
  queryByPredicate(predicate: string): Promise<Triple[]>;

  /**
   * Return all triples in the store.
   */
  getAll(): Promise<Triple[]>;

  /**
   * Remove all triples from the store.  Useful for testing / reset.
   */
  clear(): Promise<void>;

  /**
   * Release any held resources (connections, file handles, etc.).
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SqliteGraphAdapter — default lightweight backend
// ---------------------------------------------------------------------------

/**
 * A zero-dependency knowledge graph backed by SQLite (via `better-sqlite3`).
 *
 * The schema uses a single `triples` table with a composite unique constraint
 * on (subject, predicate, object) to enforce idempotency.
 *
 * Pass `':memory:'` as `dbPath` for a fully in-memory store (useful for tests).
 */
export class SqliteGraphAdapter implements IGraphAdapter {
  private readonly db: Database.Database;

  /**
   * @param dbPath - File path for the SQLite database, or `':memory:'` for an
   *                 ephemeral in-memory store.  Defaults to `':memory:'`.
   */
  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this._bootstrap();
  }

  // ── DDL ─────────────────────────────────────────────────────────────────

  private _bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triples (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        subject   TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (subject, predicate, object)
      );
      CREATE INDEX IF NOT EXISTS idx_triples_subject   ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
    `);
  }

  // ── IGraphAdapter implementation ────────────────────────────────────────

  async upsertTriple(triple: Triple): Promise<boolean> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO triples (subject, predicate, object)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(
      triple.subject.trim(),
      triple.predicate.trim(),
      triple.object.trim(),
    );
    // `changes` is 1 if inserted, 0 if ignored (duplicate).
    return result.changes === 1;
  }

  async queryBySubject(subject: string): Promise<Triple[]> {
    const rows = this.db
      .prepare('SELECT subject, predicate, object FROM triples WHERE subject = ?')
      .all(subject) as Triple[];
    return rows;
  }

  async queryByPredicate(predicate: string): Promise<Triple[]> {
    const rows = this.db
      .prepare('SELECT subject, predicate, object FROM triples WHERE predicate = ?')
      .all(predicate) as Triple[];
    return rows;
  }

  async getAll(): Promise<Triple[]> {
    return this.db
      .prepare('SELECT subject, predicate, object FROM triples ORDER BY id')
      .all() as Triple[];
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM triples');
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Neo4jGraphAdapter — stub for production graph database
// ---------------------------------------------------------------------------

/**
 * Neo4j-compatible adapter stub.
 *
 * Import and instantiate this when a full property graph database is needed
 * (relationships become first-class graph edges, enabling Cypher traversals).
 *
 * **Setup**:
 * ```
 * bun add neo4j-driver
 * ```
 * ```ts
 * import neo4j from 'neo4j-driver';
 * const driver = neo4j.driver(
 *   'bolt://localhost:7687',
 *   neo4j.auth.basic('neo4j', 'password'),
 * );
 * const adapter = new Neo4jGraphAdapter(driver);
 * const graph   = new SemanticGraph({ adapter });
 * ```
 *
 * Each triple is stored as:
 * ```
 * (:Entity {name: subject})-[:PREDICATE {value: predicate}]->(:Entity {name: object})
 * ```
 */
export class Neo4jGraphAdapter implements IGraphAdapter {
  // The driver is typed as `any` to avoid requiring `neo4j-driver` as a hard
  // compile-time dependency.  At runtime the caller supplies the real driver.
  private readonly driver: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(driver: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.driver = driver;
  }

  async upsertTriple(triple: Triple): Promise<boolean> {
    const session = this.driver.session();
    try {
      // MERGE prevents duplicates at the graph level.
      const result = await session.run(
        `MERGE (s:Entity {name: $subject})
         MERGE (o:Entity {name: $object})
         MERGE (s)-[r:FACT {predicate: $predicate}]->(o)
         ON CREATE SET r.created_at = datetime()
         RETURN r.created_at AS created`,
        triple,
      );
      // `created` will be set only if the relationship was newly created.
      return result.records.length > 0 && result.records[0].get('created') !== null;
    } finally {
      await session.close();
    }
  }

  async queryBySubject(subject: string): Promise<Triple[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Entity {name: $subject})-[r:FACT]->(o:Entity)
         RETURN s.name AS subject, r.predicate AS predicate, o.name AS object`,
        { subject },
      );
      return result.records.map((rec: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        subject: rec.get('subject'),
        predicate: rec.get('predicate'),
        object: rec.get('object'),
      }));
    } finally {
      await session.close();
    }
  }

  async queryByPredicate(predicate: string): Promise<Triple[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Entity)-[r:FACT {predicate: $predicate}]->(o:Entity)
         RETURN s.name AS subject, r.predicate AS predicate, o.name AS object`,
        { predicate },
      );
      return result.records.map((rec: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        subject: rec.get('subject'),
        predicate: rec.get('predicate'),
        object: rec.get('object'),
      }));
    } finally {
      await session.close();
    }
  }

  async getAll(): Promise<Triple[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Entity)-[r:FACT]->(o:Entity)
         RETURN s.name AS subject, r.predicate AS predicate, o.name AS object`,
      );
      return result.records.map((rec: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        subject: rec.get('subject'),
        predicate: rec.get('predicate'),
        object: rec.get('object'),
      }));
    } finally {
      await session.close();
    }
  }

  async clear(): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

// ---------------------------------------------------------------------------
// LLM router type (minimal, compatible with Anthropic / Google SDKs)
// ---------------------------------------------------------------------------

/**
 * Minimal contract for an LLM that can generate a text completion.
 * Both `@anthropic-ai/sdk` and `@google/generative-ai` adapters satisfy this
 * if wrapped in a one-line shim.  Pass any conforming instance to
 * {@link SemanticGraph}.
 *
 * @example  Wrapping Anthropic:
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * const client = new Anthropic();
 *
 * const llmRouter: LLMRouter = {
 *   async complete(systemPrompt, userPrompt) {
 *     const msg = await client.messages.create({
 *       model: 'claude-3-5-haiku-latest',
 *       max_tokens: 512,
 *       system: systemPrompt,
 *       messages: [{ role: 'user', content: userPrompt }],
 *     });
 *     const block = msg.content[0];
 *     return block.type === 'text' ? block.text : '';
 *   },
 * };
 * ```
 */
export interface LLMRouter {
  /**
   * Run a completion against the underlying model.
   *
   * @param systemPrompt - System / instruction context.
   * @param userPrompt   - The user-turn input to respond to.
   * @returns            The model's raw text response.
   */
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Extraction prompt (strict SPO schema)
// ---------------------------------------------------------------------------

/**
 * Strict system prompt that instructs the LLM to emit ONLY a JSON array of
 * Subject-Predicate-Object triples about the user.  No surrounding prose is
 * permitted — this keeps parsing deterministic.
 */
const EXTRACTION_SYSTEM_PROMPT = `\
You are a fact-extraction engine that reads conversation text and identifies \
permanent facts about the user. Your sole output must be a valid JSON array \
of objects, each with exactly three string fields: "subject", "predicate", \
"object".  Represent every extracted fact as a Subject-Predicate-Object triple.

Rules:
- Output ONLY the JSON array.  No preamble, no explanation, no markdown fences.
- Only include facts that are likely to remain true over time (e.g. name, \
  occupation, preferences, relationships, goals).
- Normalise subjects: refer to the human as "user" unless a specific name is known.
- If no permanent facts are present, return an empty array: []
- Do not hallucinate; only extract facts explicitly stated or strongly implied.

Example output:
[
  {"subject":"user","predicate":"is named","object":"Alice"},
  {"subject":"user","predicate":"works as","object":"software engineer"},
  {"subject":"user","predicate":"prefers","object":"dark mode"}
]`;

// ---------------------------------------------------------------------------
// SemanticGraph
// ---------------------------------------------------------------------------

/**
 * Configuration options for {@link SemanticGraph}.
 */
export interface SemanticGraphOptions {
  /**
   * Pluggable graph database adapter.
   * Defaults to a new {@link SqliteGraphAdapter} with an in-memory database.
   */
  adapter?: IGraphAdapter;

  /**
   * LLM router used for fact extraction.
   * If omitted, {@link extractAndStoreFacts} will throw unless an `llm` is
   * provided at call time.
   */
  llm?: LLMRouter;

  /**
   * When `true`, log debug information to `console.debug`.
   * Default: `false`.
   */
  debug?: boolean;
}

/**
 * Semantic Memory layer — extracts permanent facts from conversation text into
 * a Subject-Predicate-Object knowledge graph.
 *
 * Analogous to the semantic memory system in human cognition: while episodic
 * memory captures *events* (handled by {@link MemoryConsolidator} on the
 * Python side), semantic memory stores *facts* that generalise across episodes
 * (e.g. "user lives in Paris").
 *
 * @example
 * ```ts
 * const graph = new SemanticGraph({ llm: myLLMRouter });
 *
 * const result = await graph.extractAndStoreFacts(
 *   "Hi, I'm Alice and I'm a software engineer based in London.",
 * );
 * // result.triples → [
 * //   { subject: 'user', predicate: 'is named', object: 'Alice' },
 * //   { subject: 'user', predicate: 'works as', object: 'software engineer' },
 * //   { subject: 'user', predicate: 'is based in', object: 'London' },
 * // ]
 *
 * const facts = await graph.queryFacts('user');
 * // → same triples retrieved from the graph
 * ```
 */
export class SemanticGraph {
  private readonly adapter: IGraphAdapter;
  private readonly llm: LLMRouter | undefined;
  private readonly debug: boolean;

  constructor(options: SemanticGraphOptions = {}) {
    this.adapter = options.adapter ?? new SqliteGraphAdapter(':memory:');
    this.llm = options.llm;
    this.debug = options.debug ?? false;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Extract permanent facts from `text` using the LLM router, then persist
   * them to the graph store via {@link storeTriples}.
   *
   * The LLM is given a strict extraction prompt:
   * > "Extract permanent facts about the user from the following text into
   * > Subject-Predicate-Object triples."
   *
   * The response is parsed as a JSON array of {@link Triple} objects.  Any
   * triples that already exist in the graph are silently skipped (idempotent).
   *
   * @param text - Raw conversation or monologue text to mine for facts.
   * @param llm  - Optional LLM router override (falls back to constructor arg).
   * @returns    {@link ExtractionResult} describing what was extracted and stored.
   * @throws     If no LLM router is available (neither constructor nor parameter).
   */
  async extractAndStoreFacts(
    text: string,
    llm?: LLMRouter,
  ): Promise<ExtractionResult> {
    const router = llm ?? this.llm;
    if (!router) {
      throw new Error(
        '[SemanticGraph] No LLM router provided. ' +
          'Pass one to the SemanticGraph constructor or to extractAndStoreFacts().',
      );
    }

    if (!text.trim()) {
      this._log('extractAndStoreFacts called with empty text — skipping.');
      return { triples: [], stored: 0, skipped: 0 };
    }

    // ── Step 1: Run strict SPO extraction via the LLM router ───────────────
    const userPrompt =
      'Extract permanent facts about the user from the following text into ' +
      'Subject-Predicate-Object triples.\n\n' +
      `TEXT:\n${text}`;

    let rawResponse: string;
    try {
      rawResponse = await router.complete(EXTRACTION_SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      console.error('[SemanticGraph] LLM extraction call failed:', err);
      return { triples: [], stored: 0, skipped: 0 };
    }

    // ── Step 2: Parse the JSON response ────────────────────────────────────
    const triples = this._parseTriples(rawResponse);
    this._log(`Extracted ${triples.length} triple(s) from text.`);

    // ── Step 3: Persist to the graph ────────────────────────────────────────
    const { stored, skipped } = await this.storeTriples(triples);

    return { triples, stored, skipped };
  }

  /**
   * Persist an array of {@link Triple} objects to the graph store.
   *
   * Duplicates (same subject + predicate + object) are silently skipped.
   * Each triple is upserted independently so partial failures do not roll back
   * previously stored triples.
   *
   * @param triples - Array of SPO triples to store.  May be empty.
   * @returns       Counts of newly stored vs skipped triples.
   */
  async storeTriples(triples: Triple[]): Promise<{ stored: number; skipped: number }> {
    let stored = 0;
    let skipped = 0;

    for (const triple of triples) {
      // Basic validation — skip malformed triples rather than throwing.
      if (!triple.subject?.trim() || !triple.predicate?.trim() || !triple.object?.trim()) {
        this._log(`Skipping malformed triple: ${JSON.stringify(triple)}`);
        skipped++;
        continue;
      }

      try {
        const wasNew = await this.adapter.upsertTriple(triple);
        if (wasNew) {
          stored++;
          this._log(`Stored: ${triple.subject} → [${triple.predicate}] → ${triple.object}`);
        } else {
          skipped++;
          this._log(`Duplicate skipped: ${triple.subject} → [${triple.predicate}] → ${triple.object}`);
        }
      } catch (err) {
        console.error('[SemanticGraph] Failed to upsert triple:', triple, err);
        skipped++;
      }
    }

    return { stored, skipped };
  }

  /**
   * Retrieve all facts about a given subject from the graph.
   *
   * @param subject - Subject entity to look up (e.g. `'user'`).
   */
  async queryFacts(subject: string): Promise<Triple[]> {
    return this.adapter.queryBySubject(subject);
  }

  /**
   * Retrieve all triples sharing a given predicate.
   *
   * @param predicate - Relation/property to look up (e.g. `'works as'`).
   */
  async queryByRelation(predicate: string): Promise<Triple[]> {
    return this.adapter.queryByPredicate(predicate);
  }

  /**
   * Return every triple currently stored in the graph.
   * Useful for exporting the full knowledge base or debugging.
   */
  async getAllFacts(): Promise<Triple[]> {
    return this.adapter.getAll();
  }

  /**
   * Format the knowledge graph as a human-readable context string for
   * injection into an LLM system prompt.
   *
   * Output format (one triple per line):
   * ```
   * user  is named  Alice
   * user  works as  software engineer
   * ```
   *
   * @param subject - Optional filter; if supplied, only triples for this
   *                  subject are included.  Defaults to all triples.
   */
  async toContextString(subject?: string): Promise<string> {
    const triples = subject
      ? await this.adapter.queryBySubject(subject)
      : await this.adapter.getAll();

    if (triples.length === 0) return '';

    return triples
      .map((t) => `${t.subject}  ${t.predicate}  ${t.object}`)
      .join('\n');
  }

  /**
   * Release all resources held by the underlying graph adapter.
   * Call this when the agent session is being torn down.
   */
  async close(): Promise<void> {
    await this.adapter.close();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Parse the raw LLM text response into a {@link Triple} array.
   *
   * The model is instructed to emit only a JSON array; this method handles
   * common deviation cases:
   * - Markdown code fences (```json ... ```)
   * - Leading/trailing whitespace
   * - Non-array top-level values (returns empty array)
   * - Missing or extra object keys (filters to valid triples only)
   */
  private _parseTriples(raw: string): Triple[] {
    // Strip optional markdown fences the LLM might add despite instructions.
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn('[SemanticGraph] LLM response is not valid JSON:', raw.slice(0, 200));
      return [];
    }

    if (!Array.isArray(parsed)) {
      console.warn('[SemanticGraph] Expected a JSON array, got:', typeof parsed);
      return [];
    }

    // Filter to objects that have at least the three required string fields.
    return (parsed as unknown[]).filter(
      (item): item is Triple =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).subject === 'string' &&
        typeof (item as Record<string, unknown>).predicate === 'string' &&
        typeof (item as Record<string, unknown>).object === 'string',
    );
  }

  private _log(message: string): void {
    if (this.debug) {
      console.debug(`[SemanticGraph] ${message}`);
    }
  }
}
