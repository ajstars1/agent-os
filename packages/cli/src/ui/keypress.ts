// Standalone keypress parser for raw stdin bytes.
// Ports the subset of Claude Code's src/ink/parse-keypress.ts that agent-os needs:
// CSI u (kitty keyboard protocol), xterm modifyOtherKeys, bracketed paste,
// arrows / home / end / page nav, ctrl+letter, backspace / delete / tab / escape,
// and plain printable characters (utf-8).
//
// Stock Ink's useInput swallows CSI-u sequences silently, which is why Shift+Enter
// never reaches our handler. Feeding stdin through this parser sidesteps that.

export interface KeyEvent {
  kind: 'key' | 'paste';
  // For 'key': the canonical name ('return', 'up', 'a', 'space', etc.) or '' for raw sequences.
  // For 'paste': always empty; use `sequence`.
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  // The user-visible text this key inserts, if any.
  // For printables this is the character; for special keys ('', or the key name).
  sequence: string;
  // Raw bytes as received (useful for debugging).
  raw: string;
  isPasted: boolean;
}

// ── Control sequences ────────────────────────────────────────────────────────
const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// CSI u: ESC [ keycode [; modifier] u
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/;
// xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/;
// CSI ~ function keys: ESC [ num [; mod] ~
const CSI_TILDE_RE = /^\x1b\[(\d+)(?:;(\d+))?~/;
// CSI letter: ESC [ [1;mod] A|B|C|D|F|H
const CSI_LETTER_RE = /^\x1b\[(?:1;(\d+))?([A-HPQRS])/;
// SS3 letter: ESC O A|B|C|D|F|H|P|Q|R|S
const SS3_RE = /^\x1bO([A-HPQRS])/;

// Modifier bits: 1=none, 2=shift, 3=alt, 4=shift+alt, 5=ctrl, 6=ctrl+shift, 7=ctrl+alt, 8=ctrl+shift+alt
function parseModifier(m: number | undefined): { shift: boolean; meta: boolean; ctrl: boolean } {
  const mod = (m ?? 1) - 1;
  return {
    shift: (mod & 1) !== 0,
    meta: (mod & 2) !== 0,
    ctrl: (mod & 4) !== 0,
  };
}

const CSI_LETTER_NAMES: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left',
  F: 'end', H: 'home',
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
};

const CSI_TILDE_NAMES: Record<number, string> = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end',
  5: 'pageup', 6: 'pagedown',
  7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4',
  15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8',
  20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};

// Map CSI-u keycodes (Kitty) → canonical names for the ones we care about.
function csiUKeyName(code: number): string {
  switch (code) {
    case 13: return 'return';
    case 27: return 'escape';
    case 9: return 'tab';
    case 32: return 'space';
    case 127: return 'backspace';
    default:
      if (code >= 32 && code <= 126) return String.fromCharCode(code);
      return '';
  }
}

function makeKey(partial: Partial<KeyEvent> & { name: string; raw: string }): KeyEvent {
  return {
    kind: 'key',
    ctrl: false,
    shift: false,
    meta: false,
    sequence: partial.sequence ?? partial.name,
    isPasted: false,
    ...partial,
  };
}

// ── Parser state ─────────────────────────────────────────────────────────────
export interface KeypressState {
  mode: 'NORMAL' | 'IN_PASTE';
  pasteBuffer: string;
  carry: string;
}

export const INITIAL_STATE: KeypressState = {
  mode: 'NORMAL',
  pasteBuffer: '',
  carry: '',
};

// ── Main feed function ───────────────────────────────────────────────────────
export function feedKeypress(
  prevState: KeypressState,
  chunk: string,
): { events: KeyEvent[]; state: KeypressState } {
  const events: KeyEvent[] = [];
  let buf = prevState.carry + chunk;
  let mode = prevState.mode;
  let pasteBuffer = prevState.pasteBuffer;

  while (buf.length > 0) {
    // ── Bracketed paste ──
    if (mode === 'IN_PASTE') {
      const end = buf.indexOf(PASTE_END);
      if (end === -1) {
        pasteBuffer += buf;
        buf = '';
        break;
      }
      pasteBuffer += buf.slice(0, end);
      events.push({
        kind: 'paste',
        name: '',
        ctrl: false, shift: false, meta: false,
        sequence: pasteBuffer,
        raw: pasteBuffer,
        isPasted: true,
      });
      pasteBuffer = '';
      mode = 'NORMAL';
      buf = buf.slice(end + PASTE_END.length);
      continue;
    }

    if (buf.startsWith(PASTE_START)) {
      mode = 'IN_PASTE';
      buf = buf.slice(PASTE_START.length);
      continue;
    }

    // ── CSI u (Kitty) ──
    const csiU = CSI_U_RE.exec(buf);
    if (csiU) {
      const code = parseInt(csiU[1]!, 10);
      const mod = parseModifier(csiU[2] ? parseInt(csiU[2], 10) : undefined);
      const name = csiUKeyName(code);
      const raw = csiU[0];
      events.push(makeKey({
        name,
        sequence: name.length === 1 ? name : '',
        raw,
        shift: mod.shift, meta: mod.meta, ctrl: mod.ctrl,
      }));
      buf = buf.slice(raw.length);
      continue;
    }

    // ── xterm modifyOtherKeys ──
    const mok = MODIFY_OTHER_KEYS_RE.exec(buf);
    if (mok) {
      const mod = parseModifier(parseInt(mok[1]!, 10));
      const code = parseInt(mok[2]!, 10);
      const name = csiUKeyName(code);
      const raw = mok[0];
      events.push(makeKey({
        name,
        sequence: name.length === 1 ? name : '',
        raw,
        shift: mod.shift, meta: mod.meta, ctrl: mod.ctrl,
      }));
      buf = buf.slice(raw.length);
      continue;
    }

    // ── CSI letter (arrows, home, end, F1–F4) ──
    const csiL = CSI_LETTER_RE.exec(buf);
    if (csiL) {
      const mod = parseModifier(csiL[1] ? parseInt(csiL[1], 10) : undefined);
      const letter = csiL[2]!;
      const name = CSI_LETTER_NAMES[letter] ?? '';
      const raw = csiL[0];
      if (name) {
        events.push(makeKey({
          name, sequence: '', raw,
          shift: mod.shift, meta: mod.meta, ctrl: mod.ctrl,
        }));
      }
      buf = buf.slice(raw.length);
      continue;
    }

    // ── CSI ~ (insert, delete, pageup/down, F5–F12) ──
    const csiT = CSI_TILDE_RE.exec(buf);
    if (csiT) {
      const code = parseInt(csiT[1]!, 10);
      const mod = parseModifier(csiT[2] ? parseInt(csiT[2], 10) : undefined);
      const name = CSI_TILDE_NAMES[code] ?? '';
      const raw = csiT[0];
      if (name) {
        events.push(makeKey({
          name, sequence: '', raw,
          shift: mod.shift, meta: mod.meta, ctrl: mod.ctrl,
        }));
      }
      buf = buf.slice(raw.length);
      continue;
    }

    // ── SS3 (xterm/rxvt ESC O letter) ──
    const ss3 = SS3_RE.exec(buf);
    if (ss3) {
      const letter = ss3[1]!;
      const name = CSI_LETTER_NAMES[letter] ?? '';
      if (name) {
        events.push(makeKey({ name, sequence: '', raw: ss3[0] }));
      }
      buf = buf.slice(ss3[0].length);
      continue;
    }

    // ── Incomplete escape sequence — stash and wait for next chunk ──
    if (buf[0] === ESC && buf.length < 8) {
      // Lone ESC is also possible; emit it after a short delay via the carry.
      // If this chunk ends with an unfinished ESC[..., keep it for next feed.
      if (buf.length === 1 || /^\x1b[\[ON]/.test(buf)) {
        break;
      }
    }

    // ── Alt+char: ESC followed by a single printable ──
    if (buf[0] === ESC && buf.length >= 2 && buf[1] !== '[' && buf[1] !== 'O') {
      const ch = buf[1]!;
      events.push(makeKey({
        name: ch, sequence: ch, raw: ESC + ch, meta: true,
      }));
      buf = buf.slice(2);
      continue;
    }

    // ── Lone ESC ──
    if (buf[0] === ESC) {
      events.push(makeKey({ name: 'escape', sequence: '', raw: ESC }));
      buf = buf.slice(1);
      continue;
    }

    // ── Control characters (Ctrl+A..Z, Enter, Tab, Backspace) ──
    const ch = buf[0]!;
    const code = ch.charCodeAt(0);

    if (code === 0x0d || code === 0x0a) {
      events.push(makeKey({ name: 'return', sequence: '', raw: ch }));
      buf = buf.slice(1);
      continue;
    }
    if (code === 0x09) {
      events.push(makeKey({ name: 'tab', sequence: '', raw: ch }));
      buf = buf.slice(1);
      continue;
    }
    if (code === 0x7f || code === 0x08) {
      events.push(makeKey({ name: 'backspace', sequence: '', raw: ch }));
      buf = buf.slice(1);
      continue;
    }
    if (code >= 1 && code <= 26) {
      // Ctrl+A..Z (code + 96 = lowercase letter)
      const letter = String.fromCharCode(code + 96);
      events.push(makeKey({
        name: letter, sequence: '', raw: ch, ctrl: true,
      }));
      buf = buf.slice(1);
      continue;
    }

    // ── Printable (utf-8 multi-byte handled by JS string indexing) ──
    // Consume one code point.
    const codePoint = buf.codePointAt(0)!;
    const printable = String.fromCodePoint(codePoint);
    events.push(makeKey({
      name: printable, sequence: printable, raw: printable,
    }));
    buf = buf.slice(printable.length);
  }

  return {
    events,
    state: { mode, pasteBuffer, carry: buf },
  };
}
