// vnc: real mouse and keys through macOS Screen Sharing, for when Accessibility is gone
// (a reboot, a reinstalled interpreter) and nothing else on the Mac can click or type.
// Screen Sharing input is real input: it flips privacy switches and fills password sheets
// that refuse Accessibility presses. It needs Screen Sharing on and the Mac's own address:
// loopback is refused for the console session, so the default host is this Mac's Tailscale
// or LAN address.
import { createCipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { deflateSync } from "node:zlib";

const KEYSYM = { return: 0xff0d, enter: 0xff0d, tab: 0xff09, escape: 0xff1b, space: 0x20, backspace: 0xff08,
  delete: 0xffff, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, home: 0xff50, end: 0xff57,
  cmd: 0xffe7, shift: 0xffe1, ctrl: 0xffe3, alt: 0xffe9, option: 0xffe9 };
const SHIFTED = /[A-Z~!@#$%^&*()_+{}|:"<>?]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultHost() {
  for (const cmd of [["tailscale", ["ip", "-4"]], ["ipconfig", ["getifaddr", "en0"]], ["ipconfig", ["getifaddr", "en1"]]]) {
    try { const ip = execFileSync(...cmd, { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0]; if (ip) return ip; } catch {}
  }
  throw new Error("no address for this Mac (loopback is refused by Screen Sharing); pass --host");
}

// A byte reader over the socket: await take(n) returns exactly n bytes.
function reader(sock) {
  let buf = Buffer.alloc(0), want = 0, wake = null, err = null;
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); if (wake && buf.length >= want) wake(); });
  sock.on("error", (e) => { err = e; wake?.(); });
  sock.on("close", () => { err ??= new Error("Screen Sharing closed the connection"); wake?.(); });
  return async (n) => {
    while (buf.length < n) {
      if (err) throw err;
      want = n; await new Promise((r) => { wake = r; }); wake = null;
    }
    const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
  };
}

const modpow = (b, e, m) => { let r = 1n; b %= m; for (; e > 0n; e >>= 1n, b = b * b % m) if (e & 1n) r = r * b % m; return r; };
const big = (b) => BigInt("0x" + (b.toString("hex") || "0"));
const bytes = (n, len) => Buffer.from(n.toString(16).padStart(len * 2, "0"), "hex");

// Apple Remote Desktop authentication (security type 30): Diffie-Hellman, then the
// user name and password, each NUL-padded to 64 bytes, under AES-128-ECB keyed by md5(secret).
export async function open({ host, user, password }) {
  const sock = connect(5900, host); sock.setNoDelay(true);
  const take = reader(sock);
  await new Promise((ok, no) => { sock.once("connect", ok); sock.once("error", no); });
  await take(12); sock.write("RFB 003.008\n");
  const types = [...await take((await take(1))[0])];
  if (!types.includes(30)) throw new Error(`Screen Sharing offers no ARD login (types ${types})`);
  sock.write(Buffer.from([30]));
  const g = big(await take(2)), len = (await take(2)).readUInt16BE(0);
  const p = big(await take(len)), ys = big(await take(len));
  const x = BigInt("0x" + randomBytes(len).toString("hex")) % (p - 2n) + 1n;
  const key = createHash("md5").update(bytes(modpow(ys, x, p), len)).digest();
  const field = (s) => { const b = Buffer.alloc(64); randomBytes(64).copy(b); Buffer.from(s + "\0").copy(b); return b; };
  const aes = createCipheriv("aes-128-ecb", key, null).setAutoPadding(false);
  sock.write(Buffer.concat([aes.update(Buffer.concat([field(user), field(password)])), aes.final(), bytes(modpow(g, x, p), len)]));
  if ((await take(4)).readUInt32BE(0) !== 0) { sock.destroy(); throw new Error("Screen Sharing refused the login"); }
  sock.write(Buffer.from([1]));                                   // shared session
  const init = await take(24); const width = init.readUInt16BE(0), height = init.readUInt16BE(2);
  await take(init.readUInt32BE(20));
  // 32 bpp little-endian BGRX, raw encoding only: the frames asyncvnc asked for never came
  const pf = Buffer.alloc(20); pf[0] = 0; pf.writeUInt8(32, 4); pf.writeUInt8(24, 5); pf.writeUInt8(0, 6); pf.writeUInt8(1, 7);
  pf.writeUInt16BE(255, 8); pf.writeUInt16BE(255, 10); pf.writeUInt16BE(255, 12); pf.writeUInt8(16, 14); pf.writeUInt8(8, 15); pf.writeUInt8(0, 16);
  sock.write(pf); sock.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
  const send = async (b) => { if (!sock.write(b)) await new Promise((r) => sock.once("drain", r)); };
  const pointer = (x, y, mask) => send(Buffer.from([5, mask, x >> 8, x & 255, y >> 8, y & 255]));
  // Keys are dropped when sent in a burst: each edge goes out alone, 60 ms apart (measured 2026-11-19).
  const keyEdge = async (sym, down) => { const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(sym, 4); await send(b); await sleep(60); };
  return {
    width, height,
    async click(x, y, { double = false, right = false } = {}) {
      const m = right ? 4 : 1;
      await pointer(x, y, 0); await sleep(150);
      for (let i = 0; i < (double ? 2 : 1); i++) { await pointer(x, y, m); await sleep(80); await pointer(x, y, 0); await sleep(80); }
    },
    async scroll(x, y, lines) {
      await pointer(x, y, 0);
      for (let i = 0; i < Math.abs(lines); i++) { await pointer(x, y, lines > 0 ? 16 : 8); await pointer(x, y, 0); await sleep(10); }
    },
    async key(combo) {
      const syms = combo.split("+").map((k) => KEYSYM[k.toLowerCase()] ?? (k.length === 1 ? k.charCodeAt(0) : NaN));
      if (syms.some(Number.isNaN)) throw new Error(`unknown key in ${combo}`);
      for (const s of syms) await keyEdge(s, true);
      for (const s of syms.reverse()) await keyEdge(s, false);
    },
    async type(text) {
      for (const ch of text) {
        const shift = SHIFTED.test(ch);
        if (shift) await keyEdge(KEYSYM.shift, true);
        await keyEdge(ch.codePointAt(0), true); await keyEdge(ch.codePointAt(0), false);
        if (shift) await keyEdge(KEYSYM.shift, false);
      }
    },
    // One frame of the region as RGB rows.
    async grab(x = 0, y = 0, w = width - x, h = height - y) {
      const req = Buffer.alloc(10); req[0] = 3; req.writeUInt16BE(x, 2); req.writeUInt16BE(y, 4); req.writeUInt16BE(w, 6); req.writeUInt16BE(h, 8);
      await send(req);
      const rgb = Buffer.alloc(w * h * 3);
      for (;;) {
        const t = (await take(1))[0];
        if (t === 2) continue;                                    // bell
        if (t === 3) { await take(3); await take((await take(4)).readUInt32BE(0)); continue; } // clipboard
        if (t !== 0) throw new Error(`unexpected Screen Sharing message ${t}`);
        await take(1); const n = (await take(2)).readUInt16BE(0);
        for (let i = 0; i < n; i++) {
          const r = await take(12);
          const rx = r.readUInt16BE(0), ry = r.readUInt16BE(2), rw = r.readUInt16BE(4), rh = r.readUInt16BE(6), enc = r.readInt32BE(8);
          if (enc !== 0) { if (rw * rh) throw new Error(`unexpected encoding ${enc}`); continue; }
          const px = await take(rw * rh * 4);
          for (let row = 0; row < rh; row++) for (let col = 0; col < rw; col++) {
            const dx = rx - x + col, dy = ry - y + row; if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
            const s = (row * rw + col) * 4, d = (dy * w + dx) * 3; rgb[d] = px[s + 2]; rgb[d + 1] = px[s + 1]; rgb[d + 2] = px[s];
          }
        }
        return { w, h, rgb };
      }
    },
    close() { sock.end(); },
  };
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }

// PNG of an RGB frame, shrunk by an integer factor (nearest pixel).
export function png({ w, h, rgb }, shrink = 1) {
  const W = Math.floor(w / shrink), H = Math.floor(h / shrink), raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.copy(raw, y * (W * 3 + 1) + 1 + x * 3, ((y * shrink) * w + x * shrink) * 3, ((y * shrink) * w + x * shrink) * 3 + 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// mac vnc <step>... : steps run in order on one connection, in desktop pixels:
//   click X,Y  dclick X,Y  rclick X,Y  scroll X,Y N  key COMBO  type --secret ENV | type TEXT  wait MS  shot FILE [--region x,y,w,h] [--shrink N]
export async function vncCmd(args, { password, user, host }) {
  const s = await open({ host, user, password });
  const pt = (v) => { const [x, y] = v.split(",").map(Number); if (!(x >= 0 && y >= 0)) throw new Error(`bad point ${v}`); return [x, y]; };
  try {
    for (let i = 0; i < args.length;) {
      const op = args[i++];
      if (op === "click" || op === "dclick" || op === "rclick") await s.click(...pt(args[i++]), { double: op === "dclick", right: op === "rclick" });
      else if (op === "scroll") { const [x, y] = pt(args[i++]); await s.scroll(x, y, Number(args[i++])); }
      else if (op === "key") await s.key(args[i++]);
      else if (op === "type") {
        let text = args[i++];
        if (text === "--secret") { const name = args[i++]; text = process.env[name]; if (text == null) throw new Error(`${name} is not set`); }
        await s.type(text);
      }
      else if (op === "wait") await sleep(Number(args[i++]));
      else if (op === "shot") {
        const file = args[i++]; let region = [0, 0, s.width, s.height], shrink = 4;
        while (args[i]?.startsWith("--")) {
          if (args[i] === "--region") region = args[i + 1].split(",").map(Number), shrink = 1;
          else if (args[i] === "--shrink") shrink = Number(args[i + 1]);
          else break;
          i += 2;
        }
        await sleep(400);                                         // let the last input draw
        writeFileSync(file, png(await s.grab(...region), shrink));
        console.log(`${file}: desktop ${s.width}x${s.height}, region ${region.join(",")}, shrink ${shrink}`);
      }
      else throw Object.assign(new Error(`unknown vnc step ${op}`), { code: 2 });
    }
  } finally { s.close(); }
}
