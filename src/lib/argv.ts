/**
 * A command line typed into a settings field, split into words the way a POSIX
 * shell would split it.
 *
 * The agent's command and extra arguments are entered as text — `npx
 * @google/gemini-cli`, `--model "claude opus"` — but they are handed to the
 * backend as a list and never through a shell's parser, so the token jterm adds
 * can never be reinterpreted by quoting in what the user typed. That means the
 * splitting has to happen here, and it has to agree with what the user expects
 * from typing the same thing at a prompt: single quotes are literal, double
 * quotes keep spaces and honour a backslash before `"`, `\`, `$` and a
 * backtick, and a bare backslash escapes the next character.
 *
 * Nothing is expanded. `$HOME` stays `$HOME`, which is the honest outcome for a
 * field that is not a shell.
 */
export function splitArgs(line: string): string[] {
  const words: string[] = [];
  let word = "";
  // Whether a word has started, which is not the same as `word` being non-empty:
  // `""` is an empty argument, and must survive as one.
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && index + 1 < line.length && '"\\$`'.includes(line[index + 1])) {
        index += 1;
        word += line[index];
      } else {
        word += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }

    started = true;
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "\\" && index + 1 < line.length) {
      index += 1;
      word += line[index];
    } else {
      word += ch;
    }
  }

  // An unclosed quote takes the rest of the line, which is the reading least
  // likely to surprise anyone who simply forgot to close it.
  if (started) words.push(word);
  return words;
}
