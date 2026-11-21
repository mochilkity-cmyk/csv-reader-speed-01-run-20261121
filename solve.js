// A faster drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
// Same answers on every input, reached with a faster scan:
//
// - A record with no quote before its line feed holds no quoted field, so
//   it is split on commas in one native pass instead of read a character
//   at a time (CRLF files: the trailing CR is the line break, not a field).
// - A quoted field is found with indexOf and sliced out whole; only a
//   field that holds a doubled quote, or a line break inside its quotes,
//   takes the normalising path.
// - An unquoted field is found by slicing to the next comma and looking
//   for a line break or stray CR inside that short slice, instead of
//   scanning the record three times over.
// - Only broken rows (a stray CR, junk after a closing quote, a quote that
//   never closes) take the slow path, and the slow path reads exactly as
//   csv-reader does, so the errors come out in the same order.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Written from the rules and the reference's behaviour, not
// copied from any other entry.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on, its index in rows (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Finds the next quote or line feed from a position, in one native scan.
  const quoteOrLf = /["\n]/g;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept. Only the rare
  // paths use it (junk after a closing quote, a quote that never closes);
  // the common unquoted field is read inline in the record loop below.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      const cIdx = text.indexOf(',', pos);
      const nIdx = text.indexOf('\n', pos);
      let end = len;
      let kind = END;
      if (cIdx !== -1 && (nIdx === -1 || cIdx < nIdx)) {
        end = cIdx;
        kind = COMMA;
      } else if (nIdx !== -1) {
        end = nIdx;
        kind = LINE_BREAK;
      }
      const seg = text.slice(pos, end);
      const r = seg.indexOf('\r');
      if (r === -1) {
        value += seg;
        added += seg.length;
        pos = kind === END ? len : end + 1;
        if (kind === LINE_BREAK) line += 1;
        return { value, ended: kind, added };
      }
      if (r === seg.length - 1 && kind === LINE_BREAK) {
        // The CR sits right before the LF: a CRLF line break.
        value += seg.slice(0, -1);
        added += seg.length - 1;
        pos = end + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += seg.slice(0, r);
      added += r;
      pos = pos + r + 1;
    }
  }

  // Files one record's fields: the header, a padded or cut row, or nothing
  // for a line left with no characters.
  function finishRecord(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  while (pos < len) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: no quote before the next line feed, so no quoted field can
    // span the line and the record is plain fields split on commas.
    quoteOrLf.lastIndex = pos;
    const qm = quoteOrLf.exec(text);
    let fast = null;
    if (qm === null) {
      // No quote and no line feed left: one last record to the end of text.
      const seg = text.slice(pos);
      if (seg.indexOf('\r') === -1) {
        fast = seg.split(',');
        pos = len;
      }
    } else if (qm[0] === '\n') {
      const nl = qm.index;
      const seg = text.slice(pos, nl);
      const r = seg.indexOf('\r');
      if (r === -1) {
        fast = seg.split(',');
      } else if (r === seg.length - 1) {
        // The CR is the CRLF line break, not a stray CR in a field.
        fast = seg.slice(0, -1).split(',');
      }
      if (fast !== null) {
        pos = nl + 1;
        line += 1;
      }
    }
    if (fast !== null) {
      finishRecord(fast, false);
      continue;
    }

    // Slow path: the record holds a quote, a stray CR, or both.
    const fields = [];
    let lastQuoted = false;
    let ended = END;
    for (;;) {
      let value;
      let quoted = false;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        let p = pos + 1;
        let doubled = false;
        let close = -1;
        for (;;) {
          const q = text.indexOf('"', p);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            doubled = true;
            p = q + 2;
            continue;
          }
          close = q;
          break;
        }
        if (close === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as an unquoted field.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          const uq = readUnquoted('"');
          value = uq.value;
          ended = uq.ended;
        } else {
          let raw = text.slice(open + 1, close);
          if (doubled || raw.indexOf('\r') !== -1 || raw.indexOf('\n') !== -1) {
            // A doubled quote is one quote; each CRLF or lone CR inside
            // quotes is one LF, and each LF moves to the next line.
            if (doubled) raw = raw.replaceAll('""', '"');
            if (raw.indexOf('\r') !== -1) raw = raw.replace(/\r\n?/g, '\n');
            let breaks = 0;
            for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) breaks += 1;
            line += breaks;
            value = raw;
          } else {
            value = raw;
          }
          pos = close + 1;
          if (pos >= len) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands,
              // up to the next comma or line break.
              const junk = readUnquoted(value);
              if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = junk.value;
              ended = junk.ended;
            }
          }
        }
      } else {
        // An unquoted field: slice to the next comma, then look for a line
        // break or a stray CR inside that short slice. A stray CR is
        // dropped and the field is scanned again from after it.
        let v = '';
        for (;;) {
          const cIdx = text.indexOf(',', pos);
          if (cIdx === -1) {
            // No comma left in the text: the field runs to the next line
            // break or the end of the text.
            const nIdx = text.indexOf('\n', pos);
            const end = nIdx === -1 ? len : nIdx;
            const seg = text.slice(pos, end);
            const r = seg.indexOf('\r');
            if (r === -1) {
              v += seg;
              pos = nIdx === -1 ? len : end + 1;
              if (nIdx !== -1) line += 1;
              ended = nIdx === -1 ? END : LINE_BREAK;
              break;
            }
            if (r === seg.length - 1 && nIdx !== -1) {
              v += seg.slice(0, -1);
              pos = end + 1;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            v += seg.slice(0, r);
            pos = pos + r + 1;
            continue;
          }
          const seg = text.slice(pos, cIdx);
          const n = seg.indexOf('\n');
          const r = seg.indexOf('\r');
          if (r !== -1 && (n === -1 || r < n)) {
            if (n !== -1 && r + 1 === n) {
              // The CR sits right before the LF: a CRLF line break.
              v += seg.slice(0, r);
              pos = pos + r + 2;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            v += seg.slice(0, r);
            pos = pos + r + 1;
            continue;
          }
          if (n !== -1) {
            v += seg.slice(0, n);
            pos = pos + n + 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          v += seg;
          pos = cIdx + 1;
          ended = COMMA;
          break;
        }
        value = v;
      }
      fields.push(value);
      lastQuoted = quoted;
      if (ended !== COMMA) break;
    }
    finishRecord(fields, lastQuoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
