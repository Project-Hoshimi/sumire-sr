// A1.1 shared protobuf runtime — runtime/proto.ts
// Wire primitives + schema-driven encode/decode, mirroring protobuf-java
// (the game's MessageParser/CodedInputStream behaviour) with proto3-style
// default-skipping so re-encoded bytes match what the official client sends.
//
// Field shapes carried by catalog messages:
//   { wire:'varint', label:'int32'|'int64'|'uint32'|'uint64'|'bool'|'enum', zigzag?:null|false|true }
//   { wire:'fixed32'|'fixed64' }                     float / double
//   { wire:'len', label:'string'|'bytes'|'message', message?:Name }
//   { repeated:true, element:FieldShape }
//   { map:true, key:FieldShape, value:FieldShape }   // protobuf map (entry msg: key=1,value=2)
//
// Decoder also preserves unknown fields verbatim (raw wire bytes) so a
// decode→encode roundtrip keeps exactly what the server sent — used both for
// byte-exact verification and response-cache key derivation.

export type FieldShape = {
  number?: number;
  name?: string;
  wire?: 'varint' | 'fixed32' | 'fixed64' | 'len';
  label?: string;
  zigzag?: null | boolean;
  csharpType?: string;
  message?: string;
  repeated?: boolean;
  map?: boolean;
  key?: FieldShape;
  value?: FieldShape;
  element?: FieldShape;
};

export type MessageShape = {
  name: string;
  namespace: string;
  oneof?: boolean;
  fields: FieldShape[];
};

export const WT_VARINT = 0, WT_FIXED64 = 1, WT_LEN = 2, WT_FIXED32 = 5;

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------
export class Reader {
  buf: Uint8Array;
  pos: number;
  lenient: boolean; // tolerant of truncated buffer: clamp len, never throw on overrun

  constructor(buf: Uint8Array | number[], pos = 0, lenient = false) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.pos = pos;
    this.lenient = lenient;
  }
  get eof() { return this.pos >= this.buf.length; }
  get truncated() { return this.pos > this.buf.length; }
  readByte() {
    if (this.pos >= this.buf.length) {
      if (this.lenient) { this.pos++; return 0; }
      throw new Error(`read past end @${this.pos}`);
    }
    return this.buf[this.pos++];
  }
  readVarint(): bigint | number {
    let x = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.readByte();
      x |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return x <= 0x1fffffffffffffn ? Number(x) : x;
  }
  readZigzag(): bigint | number {
    const u = BigInt(this.readVarint());
    const neg = u & 1n;
    const v = u >> 1n;
    const out = neg ? -(v + 1n) : v;
    return out <= 9007199254740991n && out >= -9007199254740991n ? Number(out) : out;
  }
  readTag(): { field: number; wire: number } {
    const k = Number(this.readVarint());
    return { field: k >>> 3 & 0x7fffffff, wire: k & 7 };
  }
  readLen(): number {
    const n = Number(this.readVarint());
    if (n < 0 || this.pos + n > this.buf.length) {
      if (this.lenient) {
        const avail = Math.max(0, this.buf.length - this.pos);
        const clamped = Math.min(n, avail);
        this.pos += clamped;
        return clamped;
      }
      throw new Error(`bad len ${n} @${this.pos}`);
    }
    return n;
  }
  readBytes(len: number): Uint8Array {
    if (this.pos + len > this.buf.length) {
      if (this.lenient) {
        const out = this.buf.subarray(this.pos);
        this.pos += len; // mark truncated
        return out;
      }
      throw new Error(`bad len ${len} @${this.pos}`);
    }
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  readString(len: number): string { return Buffer.from(this.readBytes(len)).toString('utf8'); }
  readFixed32(): number {
    const [a, b, c, d] = [this.readByte(), this.readByte(), this.readByte(), this.readByte()];
    const u = new Uint8Array([a, b, c, d]);
    const dv = new DataView(u.buffer);
    const f = dv.getFloat32(0, true);
    return f;
  }
  readFixed64(): number {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = this.readByte();
    return new DataView(bytes.buffer).getFloat64(0, true);
  }
  subReader(len: number): Reader { return new Reader(this.readBytes(len), 0, this.lenient); }
  // read the raw wire bytes of the current field value (for unknown passthrough)
  readWireValueRaw(wire: number): Uint8Array {
    const start = this.pos;
    switch (wire) {
      case WT_VARINT: this.readVarint(); break;
      case WT_FIXED32: for (let i = 0; i < 4; i++) this.readByte(); break;
      case WT_FIXED64: for (let i = 0; i < 8; i++) this.readByte(); break;
      case WT_LEN: { const n = this.readLen(); this.pos += n; break; }
      default: throw new Error(`unknown wire ${wire}`);
    }
    const end = Math.min(this.pos, this.buf.length);
    return this.buf.subarray(start, end);
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------
export class Writer {
  out: number[];
  constructor() { this.out = []; }
  get length() { return this.out.length; }
  toBytes(): Uint8Array { return Uint8Array.from(this.out); }
  writeByte(b: number) { this.out.push(b & 0xff); }
  writeVarint(v: bigint | number) {
    let x = BigInt(v);
    if (x < 0n) x = (x + (1n << 64n)) & ((1n << 64n) - 1n);
    while (x >= 0x80n) {
      this.writeByte(Number(x & 0x7fn) | 0x80);
      x >>= 7n;
    }
    this.writeByte(Number(x));
  }
  writeTag(field: number, wire: number) { this.writeVarint((BigInt(field) << 3n) | BigInt(wire)); }
  writeLen(n: number) { this.writeVarint(n); }
  writeBytes(b: Uint8Array) { for (const x of b) this.writeByte(x); }
  writeString(s: string) { this.writeBytes(Buffer.from(s, 'utf8')); }
  writeFixed32(f: number) {
    const u = new Uint8Array(4);
    new DataView(u.buffer).setFloat32(0, f, true);
    for (const x of u) this.writeByte(x);
  }
  writeFixed64(f: number) {
    const u = new Uint8Array(8);
    new DataView(u.buffer).setFloat64(0, f, true);
    for (const x of u) this.writeByte(x);
  }
}

// ---------------------------------------------------------------------------
// Schema-driven serialization
// ---------------------------------------------------------------------------
export type Decoded = {
  __unknown?: { field: number; wire: number; raw: Uint8Array }[];
  __msg?: string;
  [k: string]: any;
};

export const msgRegistry = new Map<string, MessageShape>();
export function register(shape: MessageShape) { msgRegistry.set(shape.name, shape); }

function wireOf(f: FieldShape | undefined): number {
  if (!f) return 0;
  if (f.wire === 'len' || f.label === 'message' || f.message) return WT_LEN;
  if (f.wire === 'fixed32') return WT_FIXED32;
  if (f.wire === 'fixed64') return WT_FIXED64;
  return WT_VARINT;
}

function isZigzag(f: FieldShape): boolean { return f.zigzag === true; }

// read one field value whose TAG has already been consumed
function readValue(f: FieldShape, r: Reader): any {
  switch (wireOf(f)) {
    case WT_VARINT: {
      if (isZigzag(f)) return r.readZigzag();
      const v = r.readVarint();
      // Negative int32/int64 travel as 64-bit two's complement; restore the sign.
      if (typeof v === 'bigint' && v >= 1n << 63n && (f.label === 'int32' || f.label === 'int64')) {
        const signed = v - (1n << 64n);
        return signed >= -0x1fffffffffffffn ? Number(signed) : signed;
      }
      return v;
    }
    case WT_FIXED32: return r.readFixed32();
    case WT_FIXED64: return r.readFixed64();
    case WT_LEN:
    default:
      const len = r.readLen();
      if (f.label === 'string') return r.readString(len);
      if (f.label === 'bytes') return r.readBytes(len);
      // message (or unknown len) → recurse using registry
      if (f.message) return decodeMessage(getShape(f.message), r.subReader(len));
      if (f.label === 'message') return r.readBytes(len); // fallback: raw
      return r.readBytes(len);
  }
}

function getShape(name: string): MessageShape {
  const s = msgRegistry.get(name);
  if (!s) throw new Error(`schema not registered: ${name}`);
  return s;
}

function isScalarWire(f: FieldShape | undefined): boolean {
  if (!f) return false;
  return f.wire === 'varint' || f.wire === 'fixed32' || f.wire === 'fixed64';
}

// Parse one top-level entry (tag + value) off `r`, returning undefined when the
// field is unknown (already buffered into `unknown`).
function decodeEntry(shape: MessageShape, r: Reader, out: Decoded, unknown: NonNullable<Decoded['__unknown']>) {
  const { field, wire } = r.readTag();
  const f = shape.fields.find(x => x.number === field);
  if (!f) {
    unknown.push({ field, wire, raw: r.readWireValueRaw(wire) });
    return;
  }
  if (f.repeated && f.element) {
    const arr = (out[f.name!] ??= []);
    // scalar/enum repeats are length-prefixed packed arrays (wire 2)
    if (isScalarWire(f.element) && wire === WT_LEN) {
      const len = r.readLen();
      const sub = r.subReader(len);
      while (!sub.eof) arr.push(readValue(f.element, sub));
    } else {
      arr.push(readValue(f.element, r));
    }
  } else if (f.map) {
    const m = (out[f.name!] ??= {} as Record<string, any>);
    const len = r.readLen();
    const er = r.subReader(len);
    let key: any, value: any;
    while (!er.eof) {
      const kt = er.readTag();
      if (kt.field === 1 && f.key) key = readValue(f.key, er);
      else if (kt.field === 2 && f.value) value = readValue(f.value, er);
      else er.readWireValueRaw(kt.wire);
    }
    m[keyToString(key)] = value;
  } else {
    out[f.name!] = readValue(f, r);
  }
}

function keyToString(k: any): string {
  if (typeof k === 'bigint') return k.toString();
  return String(k);
}

export function decodeMessage(shape: MessageShape, r: Reader, out: Decoded = {}): Decoded {
  const unknown: NonNullable<Decoded['__unknown']> = [];
  out.__unknown = unknown;
  out.__msg = shape.name;
  let guard = 0;
  while (!r.eof && guard++ < 1_000_000) decodeEntry(shape, r, out, unknown);
  if (r.truncated) out.__truncated = true;
  return out;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------
function isDefaultScalar(f: FieldShape, v: any): boolean {
  if (v === undefined || v === null) return true;
  switch (wireOf(f)) {
    case WT_VARINT:
      if (f.label === 'bool') return v === false || v === 0 || v === 0n;
      return v === 0n || v === 0;
    case WT_FIXED32:
    case WT_FIXED64:
      return v === 0 || v === 0.0;
    case WT_LEN:
    default:
      if (f.label === 'string') return v === '';
      if (f.label === 'bytes') return (v as Uint8Array).length === 0 || v === null;
      return false; // message: write when present
  }
}

function writeValue(f: FieldShape, w: Writer, v: any) {
  switch (wireOf(f)) {
    case WT_VARINT: {
      let x = BigInt(v);
      if (isZigzag(f)) x = (x << 1n) ^ (x >> 63n);
      w.writeVarint(x);
      break;
    }
    case WT_FIXED32: w.writeFixed32(Number(v)); break;
    case WT_FIXED64: w.writeFixed64(Number(v)); break;
    case WT_LEN:
    default:
      if (f.label === 'string') { w.writeLen(Buffer.byteLength(String(v), 'utf8')); w.writeString(String(v)); }
      else if (f.label === 'bytes') { const b = v as Uint8Array; w.writeLen(b.length); w.writeBytes(b); }
      else if (f.message) {
        const sub = new Writer();
        encodeMessage(getShape(f.message), v, sub);
        w.writeLen(sub.length);
        w.writeBytes(sub.toBytes());
      } else { throw new Error(`cannot write len field ${f.name}`); }
  }
}

function parseKey(k: string, shape: FieldShape): any {
  if (shape.label === 'string') return k;
  if (shape.wire === 'varint') return /^-?\d+$/.test(k) ? BigInt(k) : k;
  if (shape.wire === 'fixed32' || shape.wire === 'fixed64') return Number(k);
  return k;
}

export function encodeMessage(shape: MessageShape, v: Decoded, w: Writer, includeUnknown = true) {
  // protobuf encodes fields in ascending field-number order
  const fields = [...shape.fields].sort((a, b) => a.number! - b.number!);
  for (const f of fields) {
    const val = v[f.name!];
    if (val === undefined || val === null) continue;
    if (f.repeated && f.element) {
      if ((val as any[]).length === 0) continue;
      if (isScalarWire(f.element)) {
        // packed: single WT_LEN header + concatenated element encodings
        const sub = new Writer();
        for (const el of val) writeValue(f.element, sub, el);
        w.writeTag(f.number!, WT_LEN);
        w.writeLen(sub.length);
        w.writeBytes(sub.toBytes());
        continue;
      }
      for (const el of val) {
        w.writeTag(f.number!, wireOf(f.element));
        writeValue(f.element, w, el);
      }
      continue;
    }
    if (f.map) {
      if (Object.keys(val).length === 0) continue;
      for (const [k, mv] of Object.entries(val)) {
        w.writeTag(f.number!, WT_LEN);
        const sub = new Writer();
        if (f.key) { sub.writeTag(1, wireOf(f.key)); writeValue(f.key, sub, parseKey(k, f.key)); }
        if (f.value) { sub.writeTag(2, wireOf(f.value)); writeValue(f.value, sub, mv); }
        w.writeLen(sub.length);
        w.writeBytes(sub.toBytes());
      }
      continue;
    }
    if (isDefaultScalar(f, val)) continue;
    w.writeTag(f.number!, wireOf(f));
    writeValue(f, w, val);
  }
  if (includeUnknown) {
    for (const u of v.__unknown ?? []) {
      w.writeTag(u.field, u.wire);
      w.writeBytes(u.raw);
    }
  }
}
