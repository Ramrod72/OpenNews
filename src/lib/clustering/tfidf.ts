export type Vector = Map<string, number>;

export interface TfIdfDoc {
  id: string;
  tokens: string[];
}

/** Build TF-IDF weighted vectors for a shared corpus so similarity comparisons are apples-to-apples. */
export function buildTfIdfVectors(docs: TfIdfDoc[]): Map<string, Vector> {
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const n = docs.length;
  const vectors = new Map<string, Vector>();

  for (const doc of docs) {
    if (doc.tokens.length === 0) {
      vectors.set(doc.id, new Map());
      continue;
    }
    const termFrequency = new Map<string, number>();
    for (const term of doc.tokens) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }

    const vector: Vector = new Map();
    for (const [term, count] of termFrequency) {
      const df = documentFrequency.get(term) ?? 1;
      const idf = Math.log((n + 1) / (df + 1)) + 1;
      vector.set(term, (count / doc.tokens.length) * idf);
    }
    vectors.set(doc.id, vector);
  }

  return vectors;
}

export function cosineSimilarity(a: Vector, b: Vector): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size < b.size ? [a, b] : [b, a];

  let dot = 0;
  for (const [term, weight] of smaller) {
    const other = larger.get(term);
    if (other) dot += weight * other;
  }
  if (dot === 0) return 0;

  let normA = 0;
  for (const weight of a.values()) normA += weight * weight;
  let normB = 0;
  for (const weight of b.values()) normB += weight * weight;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Running average of vectors, used to keep a cluster centroid updated as members are added. */
export function averageVectors(vectors: Vector[]): Vector {
  const sum: Vector = new Map();
  for (const vector of vectors) {
    for (const [term, weight] of vector) {
      sum.set(term, (sum.get(term) ?? 0) + weight);
    }
  }
  const count = vectors.length || 1;
  for (const term of sum.keys()) {
    sum.set(term, sum.get(term)! / count);
  }
  return sum;
}
