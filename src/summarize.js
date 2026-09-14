// 完全オフライン・無料の抽出型要約。外部APIを一切使わないので、
// APIキーもコストも通信も不要な代わりに、文章生成はせず「元の文から
// 重要そうな文を選んで並べる」だけの簡易的な要約になる。
// 日本語は単語の区切りが無いため、文字bigram頻度でおおまかな重要度を測る。

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function charBigrams(text) {
  const bigrams = [];
  for (let i = 0; i < text.length - 1; i++) bigrams.push(text.slice(i, i + 2));
  return bigrams;
}

export function summarize(text, maxSentences = 3) {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return sentences.join('');

  const freq = new Map();
  for (const sentence of sentences) {
    for (const bg of charBigrams(sentence)) freq.set(bg, (freq.get(bg) || 0) + 1);
  }

  const scored = sentences.map((sentence, index) => {
    const bigrams = charBigrams(sentence);
    const score = bigrams.length
      ? bigrams.reduce((sum, bg) => sum + (freq.get(bg) || 0), 0) / bigrams.length
      : 0;
    return { sentence, index, score };
  });

  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, maxSentences);
  top.sort((a, b) => a.index - b.index);
  return top.map((item) => item.sentence).join('');
}
