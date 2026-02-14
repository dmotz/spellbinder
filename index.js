#!/usr/bin/env node

import {existsSync} from 'fs'
import yargs from 'yargs'
import {hideBin} from 'yargs/helpers'
import {
  GoogleGenAI,
  Type,
  HarmCategory,
  createUserContent,
  createPartFromUri
} from '@google/genai'
import {limitFunction} from 'p-limit'
import {EPub} from '@lesjoursfr/html-to-epub'
import Spinnies from 'spinnies'

const ns = 'spellbinder'
const {argv} = yargs(hideBin(process.argv))
  .scriptName(ns)
  .env(ns.toUpperCase())
  .usage('$0 <input> [output] [options]')
  .positional('input', {
    describe: 'Input PDF file path',
    type: 'string'
  })
  .positional('output', {
    describe: 'Output file path (optional)',
    type: 'string'
  })
  .option('api-key', {
    alias: 'k',
    description: 'Gemini API key',
    type: 'string',
    demandOption: true
  })
  .option('model', {
    alias: 'm',
    description: 'Gemini model',
    type: 'string',
    default: 'gemini-3-flash-preview'
  })
  .help()
  .alias('help', 'h')
  .check(argv => {
    if (!argv._[0]) {
      throw new Error('Input file is required')
    }

    if (!existsSync(argv._[0])) {
      throw new Error(`Input file does not exist: ${argv._[0]}`)
    }

    argv._[1] ||= argv._[0].replace(/\.pdf$/i, '.epub')

    if (existsSync(argv._[1])) {
      throw new Error(
        `Output file already exists: ${argv._[1]}.\n` +
          'Pass a second file path argument to choose a different output destination.'
      )
    }

    return true
  })

const ai = new GoogleGenAI({apiKey: argv.apiKey})
const spin = new Spinnies()
const mimeType = 'application/pdf'
const [inputPath, outputPath] = argv._
const safetySettings = Object.values(HarmCategory)
  .slice(1, 6)
  .map(category => ({category, threshold: 'OFF'}))

const chapterId = n => `chapter-${n}`

const callModel = async (prompt, responseSchema, spinnerId, attempt = 0) => {
  try {
    const res = await ai.models.generateContent({
      model: argv.model,
      contents: createUserContent([inputFile, {text: prompt}]),
      config: {
        systemInstruction:
          'You are an expert at carefully analyzing PDF files and extracting structured data.',
        temperature: 0.33,
        safetySettings,
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

  const content = await Promise.all(
    meta.chapters.map((c, i) => genChapter(c, i + 1, meta.chapters[i + 1]))
  )

  await new EPub(
    {
      title: meta.title,
      author: meta.author,
      publisher: `https://github.com/dmotz/${ns}`,
      tocTitle: 'Table of Contents',
      description: '',
      content
    },
    outputPath
  ).render()

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

    spin.succeed(spinnerId, {text: spinnerTitle})

    return {title, data}
  },
  {concurrency: 5}
)

const inputFile = await uploadFile(inputPath)
await main()
