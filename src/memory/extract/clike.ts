/**
 * Blanks comments and the contents of string/char literals in C-like sources,
 * keeping every newline (so line numbers stay right) and the quotes (so a
 * caller can still see that a literal was there). Shared by Go, Rust and Java.
 */
export function blankCLike(src: string, opts: { backtickStrings?: boolean; rustRaw?: boolean } = {}): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const keepNewlines = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (opts.rustRaw && c === 'r' && /^r#*"/.test(src.slice(i, i + 20)) && !/\w/.test(src[i - 1] ?? '')) {
      const hashes = /^r(#*)"/.exec(src.slice(i))![1]!;
      const close = `"${hashes}`;
      const start = i + 2 + hashes.length;
      const end = src.indexOf(close, start);
      const stop = end < 0 ? n : end + close.length;
      out += `"${keepNewlines(src.slice(start, stop - close.length))}"`;
      i = stop;
      continue;
    }
    if (c === '"' || (opts.backtickStrings && c === '`')) {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && c !== '`') j++;
        else if (src[j] === '\n' && c === '"') break;
        j++;
      }
      out += `${c}${keepNewlines(src.slice(i + 1, j))}${c}`;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Comments removed, strings kept (to read import paths). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
