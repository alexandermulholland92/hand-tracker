/**
 * qr-code.js — a QR code for a short text (byte mode, error correction level M, versions 1
 * to 10, up to 213 bytes), drawn on a canvas. Used to pair a phone with this PC: the PC
 * shows its address and a one-time key as a QR code, which the phone's camera reads.
 *
 *   const m = QRCode.matrix("text");      // { size, dark(x, y) }
 *   QRCode.draw(canvas, "text", { scale: 6, margin: 4 });
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QRCode = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Level M: error correction codewords per block, then [blocks, data codewords] groups.
  const BLOCKS = [
    null,
    [10, [1, 16]],
    [16, [1, 28]],
    [26, [1, 44]],
    [18, [2, 32]],
    [24, [2, 43]],
    [16, [4, 27]],
    [18, [4, 31]],
    [22, [2, 38], [2, 39]],
    [22, [3, 36], [2, 37]],
    [26, [4, 43], [1, 44]],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function ecc(data, n) {
    let gen = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= mul(gen[j], EXP[i]);
      }
      gen = next;
    }
    const rem = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ rem.shift();
      rem.push(0);
      for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], f);
    }
    return rem;
  }

  const dataCapacity = (v) => BLOCKS[v].slice(1).reduce((n, [b, d]) => n + b * d, 0);

  function codewords(bytes) {
    let version = 0;
    for (let v = 1; v <= 10 && !version; v++) {
      const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (bits <= dataCapacity(v) * 8) version = v;
    }
    if (!version) throw new Error("Too much text for a QR code here");
    const cap = dataCapacity(version);
    const bits = [];
    const put = (value, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };
    put(0b0100, 4); // byte mode
    put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
    // Split into blocks, add each block's error correction, interleave.
    const [ecLen, ...groups] = BLOCKS[version];
    const blocks = [];
    let o = 0;
    for (const [count, len] of groups) {
      for (let i = 0; i < count; i++) {
        const d = data.slice(o, o + len);
        o += len;
        blocks.push({ d, e: ecc(d, ecLen) });
      }
    }
    const out = [];
    const maxLen = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
    return { version, codewords: out };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function bch(value, poly, shift) {
    let v = value << shift;
    const top = 31 - Math.clz32(poly);
    while (31 - Math.clz32(v) >= top) v ^= poly << (31 - Math.clz32(v) - top);
    return (value << shift) | v;
  }

  function build(version, cws, mask) {
    const size = 17 + version * 4;
    const m = Array.from({ length: size }, () => new Array(size).fill(0));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, dark) => {
      m[r][c] = dark ? 1 : 0;
      fixed[r][c] = true;
    };
    // Finder patterns and their separators.
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = r0 + r, cc = c0 + c;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
          set(rr, cc, ring !== 2 && ring !== 4);
        }
      }
    }
    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    // Alignment patterns.
    const pos = ALIGN[version];
    for (const r of pos) {
      for (const c of pos) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
    // Format information (level M = 00), and the dark module.
    const format = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412;
    const fbit = (i) => ((format >> i) & 1) === 1;
    // (set takes row, column.) First copy around the top-left finder, second split between
    // the top-right and bottom-left ones.
    for (let i = 0; i <= 5; i++) set(i, 8, fbit(i));
    set(7, 8, fbit(6));
    set(8, 8, fbit(7));
    set(8, 7, fbit(8));
    for (let i = 9; i < 15; i++) set(8, 14 - i, fbit(i));
    for (let i = 0; i < 8; i++) set(8, size - 1 - i, fbit(i));
    for (let i = 8; i < 15; i++) set(size - 15 + i, 8, fbit(i));
    set(size - 8, 8, true);
    // Version information (version 7 and up).
    if (version >= 7) {
      const info = bch(version, 0x1f25, 12);
      for (let i = 0; i < 18; i++) {
        const bit = ((info >> i) & 1) === 1;
        const a = Math.floor(i / 3), b = (i % 3) + size - 11;
        set(a, b, bit);
        set(b, a, bit);
      }
    }
    // Data, in the zigzag order, masked.
    let bit = 0;
    const total = cws.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (fixed[r][c]) continue;
          let dark = false;
          if (bit < total) dark = ((cws[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
          bit++;
          m[r][c] = (dark !== MASKS[mask](r, c)) ? 1 : 0;
        }
      }
    }
    return m;
  }

  // The usual penalty rules, to pick the mask that reads best.
  function penalty(m) {
    const n = m.length;
    let score = 0;
    const lines = (get) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b < n; b++) {
          if (get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) score += run - 2;
            run = 1;
          }
        }
        if (run >= 5) score += run - 2;
        for (let b = 0; b + 10 < n + 0 && b + 6 < n; b++) {
          const pat = [1, 0, 1, 1, 1, 0, 1].every((v, k) => get(a, b + k) === v);
          if (pat) {
            const before = b >= 4 && [1, 2, 3, 4].every((k) => get(a, b - k) === 0);
            const after = b + 10 < n && [7, 8, 9, 10].every((k) => get(a, b + k) === 0);
            if (before || after) score += 40;
          }
        }
      }
    };
    lines((a, b) => m[a][b]);
    lines((a, b) => m[b][a]);
    for (let r = 0; r + 1 < n; r++) for (let c = 0; c + 1 < n; c++) if (m[r][c] === m[r + 1][c] && m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c + 1]) score += 3;
    const dark = m.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
    score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return score;
  }

  function matrix(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const { version, codewords: cws } = codewords(bytes);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = build(version, cws, mask);
      const p = penalty(m);
      if (!best || p < best.p) best = { m, p };
    }
    const m = best.m;
    return { size: m.length, version, dark: (x, y) => m[y][x] === 1 };
  }

  function draw(canvas, text, { scale = 6, margin = 4, dark = "#000", light = "#fff" } = {}) {
    const q = matrix(text);
    const px = (q.size + margin * 2) * scale;
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = dark;
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    return q;
  }

  return { matrix, draw };
});
