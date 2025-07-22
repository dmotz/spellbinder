#!/usr/bin/env node

import {existsSync, writeFileSync} from 'fs'
import yargs from 'yargs'
import {hideBin} from 'yargs/helpers'
import {
  GoogleGenAI,
  Type,
  createUserContent,
  createPartFromUri
} from '@google/genai'
import {load} from 'cheerio'
import {limitFunction} from 'p-limit'
import {EPub} from '@lesjoursfr/html-to-epub'
import Spinnies from 'spinnies'
import template from './template.js'

const envKey = 'SPELLBINDER'
const keyFlag = 'api-key'
const {argv} = yargs(hideBin(process.argv))
  .scriptName('spellbinder')
  .env(envKey)
  .usage('$0 <input> [output] [options]')
  .positional('input', {
    describe: 'Input PDF file path',
    type: 'string'
  })
  .positional('output', {
    describe: 'Output file path (optional)',
    type: 'string'
  })
  .option(keyFlag, {
    alias: 'k',
    description: 'Gemini API key',
    type: 'string',
    demandOption: true
  })
  .option('model', {
    alias: 'm',
    description: 'Gemini model string',
    type: 'string',
    default: 'gemini-2.5-flash'
  })
  .option('html', {
    description: 'Output HTML file instead of EPUB',
    boolean: true,
    default: false
  })
  .help()
  .alias('help', 'h')

const envKey = 'GEMINI_API_KEY'
const apiKey = argv.key || process.env[envKey]

if (!apiKey) {
  console.error(
    `Make sure to provide an API key with the --${keyFlag} flag or set the ${envKey} environment variable.`
  )
  process.exit(1)
}

const ai = new GoogleGenAI({apiKey})
const spin = new Spinnies()
const mimeType = 'application/pdf'

const chapterId = n => `chapter-${n}`

const callModel = async (prompt, responseSchema, spinnerId, attempt = 0) => {
  try {
    const res = await ai.models.generateContent({
      model: argv.model,
      contents: createUserContent([inputFile, {text: prompt}]),
      config: {
        systemInstruction:
          'You are an expert at carefully analyzing PDF files and extracting structured data.',
        temperature: 0.3,
        safetySettings: [
          'HARM_CATEGORY_HATE_SPEECH',
          'HARM_CATEGORY_HARASSMENT',
          'HARM_CATEGORY_DANGEROUS_CONTENT',
          'HARM_CATEGORY_SEXUALLY_EXPLICIT'
        ].map(s => ({category: s, threshold: 'BLOCK_NONE'})),
        ...(responseSchema
          ? {responseMimeType: 'application/json', responseSchema}
          : {})
      }
    })

    if (!res.text) {
      throw new Error('No text content in response')
    }

    return res.text.replace(/```html\n/, '').replace(/\n```/, '')
  } catch (e) {
    if (attempt < 3) {
      const {text} = spin.pick(spinnerId)
      spin.update(spinnerId, {
        text: `${text} - Error, retrying... (attempt ${attempt + 1})`,
        color: 'yellow'
      })
      return callModel(prompt, responseSchema, spinnerId, attempt + 1)
    }

    spin.fail(spinnerId)
    console.error('Error calling model:', e.message)
    process.exit(1)
  }
}

const uploadFile = async path => {
  const spinnerId = 'upload'
  spin.add(spinnerId, {text: 'File upload'})
  const res = await ai.files.upload({file: path, config: {mimeType}})
  spin.succeed(spinnerId)
  return createPartFromUri(res.uri, mimeType)
}

const main = async () => {
  const spinnerId = 'processing'
  spin.add(spinnerId, {text: 'Structure analysis'})

  const res = await callModel(
    `\
Examine the provided PDF carefully and return a JSON object with the work's title \
in the "title" property, its author in the "author" property, (use "Unknown" if it's not clear) \
and an array of chapter titles in the "chapters" property.`,
    {
      type: Type.OBJECT,
      properties: {
        title: {type: Type.STRING},
        author: {type: Type.STRING},
        chapters: {type: Type.ARRAY, items: {type: Type.STRING}}
      }
    },
    spinnerId
  )

  spin.succeed(spinnerId)

  let meta

  try {
    meta = JSON.parse(res)
  } catch (e) {
    console.error('Error parsing JSON:', e)
    console.error('Raw response:', res)
    process.exit(1)
  }

  if (!meta.chapters?.length) {
    console.error('No chapters found in analysis')
    console.error('Raw response:', res)
    process.exit(1)
  }

  if (argv.html) {
    $('title').text(meta.title)
    $('h1').text(meta.title)
    $('ul').html(
      meta.chapters
        .map((c, i) => `<li><a href="#${chapterId(i + 1)}">${c}</a></li>`)
        .join('\n')
    )
    $('main').html(
      meta.chapters
        .map((c, i) => `<div id="${chapterId(i + 1)}">${c}</div>`)
        .join('\n')
    )
  }

  const content = await Promise.all(
    meta.chapters.map((c, i) => genChapter(c, i + 1, meta.chapters[i + 1]))
  )

  if (!argv.html) {
    await new EPub(
      {
        title: meta.title,
        author: meta.author,
        publisher: 'https://github.com/dmotz/spellbinder',
        tocTitle: 'Table of Contents',
        content
      },
      argv.output
    ).render()
  }

  console.log('Done!')
}

const genChapter = limitFunction(
  async (title, chapterN, nextTitle) => {
    const spinnerId = `chapter-${chapterN}`
    const spinnerTitle = `${chapterN}: ${title}`
    spin.add(spinnerId, {text: spinnerTitle})

    const data = await callModel(
      `\
You have been tasked with converting this PDF to an EPUB in a series of steps. \

Here are the conversion requirements:

- Retain basic formatting with proper headings, emphasis, and paragraphs for reflowable layout on e-readers.
- Omit extraneous text like page headings, page numbers, footnotes, etc.
- Fix any obvious OCR transcription errors.
- Remove all images. The final output should not contain any images and be text only.
- Remove inline footnote numbers.

For the current step, we want to convert ONLY one chapter: "Chapter ${chapterN}: ${title}". \
Do not add the chapter title to the output. The output should consist only of the \
tags containing the chapter content (<p>, <h2>, <ol>, <blockquote>, etc.). The \
chapter MAY contain subsections, which should be headed with <h2> tags.

Please output only the HTML for this particular chapter, and nothing else, no commentary. \
${
  nextTitle
    ? `Continue until you reach the next chapter, which is "Chapter ${
        chapterN + 1
      }: ${nextTitle}", then stop.`
    : ''
}
`,
      null,
      spinnerId
    )

    if (argv.html) {
      $(`#${chapterId(chapterN)}`).html(`<h2>${title}</h2>\n${data}`)
      writeFileSync(argv.output, $.html())
    }

    spin.succeed(spinnerId, {text: spinnerTitle})

    return {title, data}
  },
  {concurrency: 5}
)

const $ = load(template)
const inputFile = await uploadFile(argv.input)
await main()
