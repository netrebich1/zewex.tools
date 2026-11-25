/** Векторы эмбеддингов: хранение Float32 в Bytes, косинус, центроид (векторы нормированы при упаковке). */

export function normalize(v: number[] | Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function pack(v: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(v.byteLength);
  out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return out;
}

export function unpack(b: Uint8Array | Buffer | null | undefined): Float32Array | null {
  if (!b || b.byteLength < 8) return null;
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** Скалярное произведение нормированных векторов = косинусная близость. */
export function cos(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function centroid(vs: Float32Array[]): Float32Array | null {
  if (!vs.length) return null;
  const out = new Float32Array(vs[0].length);
  for (const v of vs) if (v.length === out.length) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return normalize(out);
}

/** Сдвиг центроида кластера на новый вектор (среднее по n+1). */
export function addToCentroid(c: Float32Array, n: number, v: Float32Array): Float32Array {
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) out[i] = c[i] * n + v[i];
  return normalize(out);
}
