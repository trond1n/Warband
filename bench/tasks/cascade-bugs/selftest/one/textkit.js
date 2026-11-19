// Plain-text helpers used by the report printer.

/**
 * Collapse every run of whitespace in `text` into a single space.
 *
 * Leading and trailing whitespace is removed. Tabs and newlines count as
 * whitespace too, so "  a\t b\n" becomes "a b".
 */
function normalizeSpaces(text) {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Shorten `text` to at most `limit` words.
 *
 * Words are separated by any whitespace and are joined back with single
 * spaces. When `text` has more than `limit` words, exactly the first
 * `limit` words are kept and "..." is appended directly to the last kept
 * word: truncateWords("one two three", 2) === "one two...". When `text`
 * has `limit` words or fewer, all of them are returned and no "..." is
 * added. `limit` is always at least 1.
 */
function truncateWords(text, limit) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(' ');
  return words.slice(0, limit).join(' ') + '...';
}

/**
 * Greedily wrap `text` into lines of at most `width` characters.
 *
 * Words are never split and are separated by single spaces inside a line.
 * Each line takes as many words as fit, and a line that is exactly `width`
 * characters long still fits. A word longer than `width` goes on a line of
 * its own. Returns the array of lines; text without words gives [].
 */
function wrapLine(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length < width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/**
 * Return the number of sentences in `text`.
 *
 * A sentence is a stretch of text that contains at least one letter or
 * digit and ends with a run of ".", "!" or "?" characters, so "Wait..." and
 * "Really?!" are one sentence each. A final stretch with letters or digits
 * but without a terminator still counts as a sentence. Terminators that
 * follow no letter or digit neither start nor end a sentence: "" and "?!"
 * contain 0 sentences, "...and then." contains 1.
 */
function countSentences(text) {
  let count = 0;
  let inSentence = true;
  for (const char of text) {
    if ('.!?'.includes(char)) {
      if (inSentence) {
        count += 1;
        inSentence = false;
      }
    } else if (/[\p{L}\p{N}]/u.test(char)) {
      inSentence = true;
    }
  }
  if (inSentence) count += 1;
  return count;
}

/**
 * Turn `text` into a lowercase URL slug.
 *
 * Every run of characters that are not ASCII letters or digits becomes a
 * single "-", and the slug never starts or ends with "-":
 * slugify("  Hello, World!  ") === "hello-world".
 */
function slugify(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}

module.exports = { normalizeSpaces, truncateWords, wrapLine, countSentences, slugify };
