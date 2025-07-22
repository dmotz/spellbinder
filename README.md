# 🪄📚 Spellbinder

## Convert PDFs to EPUBs using AI

Pre-LLM tools in this vein usually output an unreadable mess. Spellbinder
leverages the built-in PDF processing and large context window of the Gemini API
and is able to output high quality EPUBs ready for ereaders (usually).

### Features

- Clean, accurate outputs
- Table of contents and chapter structure
- Fixes OCR errors
- Auto-retry when encountering API errors

### Setup

Install:

```shell
npm i -g spellbinder-cli
```

Get a [Gemini API key](https://ai.google.dev/) and either set it to
`SPELLBINDER_API_KEY` in your shell, or pass it via the `-k`/`--key` flag when
running `spellbinder`.

### Usage

You can convert a PDF simply by passing it as the first argument:

```shell
spellbinder a-book.pdf
```

Progress logs will be emitted chapter-by-chapter during the conversion process
and the final EPUB will be written to `a-book.epub`.

You can explicitly pass a different output path with a second argument:

```shell
spellbinder a-book.pdf a-better-book.epub
```

### Current limitations

- No images
- No footnote linking
- Some books could be chunked in a way that exceeds the output token limit

Pull requests are welcome if you figure out clever ways to address any of these.

### Like books?

Try my other project, [Emdash](https://github.com/dmotz/emdash).
