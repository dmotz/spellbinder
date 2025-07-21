#!/usr/bin/env node

import {writeFileSync} from 'fs'
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
import Spinnies from 'spinnies'
import template from './template.js'

const {argv} = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    description: 'Input PDF file path',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    description: 'Output HTML file path',
    type: 'string',
    demandOption: true
  })
  .option('key', {
    alias: 'k',
    description: 'Google Gemini API Key',
    type: 'string',
    demandOption: true
  })
  .option('model', {
    alias: 'm',
    description: 'Google Gemini Model',
    type: 'string',
    default: 'gemini-2.5-flash'
  })
  .help()
  .alias('help', 'h')

const ai = new GoogleGenAI({apiKey: argv.key})
const spinnies = new Spinnies()
const mimeType = 'application/pdf'

const chapterId = n => `chapter-${n}`

const callModel = async (prompt, responseSchema, spinnerId, attempt = 0) => {
  try {
    const res = await ai.models.generateContent({
      model: argv.model,
      contents: createUserContent([inputFile]),
      config: {
        systemInstruction: prompt,
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
      const {text} = spinnies.pick(spinnerId)
      spinnies.update(spinnerId, {
        text: `${text} - Error, retrying... (attempt ${attempt + 1})`,
        color: 'yellow'
      })
      return callModel(prompt, responseSchema, spinnerId, attempt + 1)
    }

    spinnies.fail(spinnerId)
    console.error('Error calling model:', e.message)
    process.exit(1)
  }
}

const uploadFile = async path => {
  const spinnerId = 'upload'
  spinnies.add(spinnerId, {text: 'File upload'})
  const res = await ai.files.upload({file: path, config: {mimeType}})
  spinnies.succeed(spinnerId)
  return createPartFromUri(res.uri, mimeType)
}

const main = async () => {
  const spinnerId = 'processing'
  spinnies.add(spinnerId, {text: 'Chapter analysis'})

  const res = await callModel(
    `\
Examine the provided PDF carefully and return a JSON object with the work's title \
in the "title" property (use "Unknown" if it's not clear) and an array of chapter \
titles in the "chapters" property.`,
    {
      type: Type.OBJECT,
      properties: {
        title: {type: Type.STRING},
        chapters: {type: Type.ARRAY, items: {type: Type.STRING}}
      }
    }
  )

  spinnies.succeed(spinnerId)

  let json
  try {
    json = JSON.parse(res)
  } catch (e) {
    console.error('Error parsing JSON:', e)
    console.error('Raw response:', res)
    process.exit(1)
  }

  if (!json.chapters?.length) {
    console.error('No chapters found in analysis')
    console.error('Raw response:', res)
    process.exit(1)
  }

  $('title').text(json.title)
  $('h1').text(json.title)
  $('ul').html(
    json.chapters
      .map((c, i) => `<li><a href="#${chapterId(i + 1)}">${c}</a></li>`)
      .join('\n')
  )
  $('main').html(
    json.chapters
      .map((c, i) => `<div id="${chapterId(i + 1)}">${c}</div>`)
      .join('\n')
  )

  await Promise.all(
    json.chapters.map((c, i) => genChapter(c, i + 1, json.chapters[i + 1]))
  )

  console.log('Done!')
}

const genChapter = limitFunction(
  async (title, chapterN, nextTitle) => {
    const spinnerId = `chapter-${chapterN}`
    spinnies.add(spinnerId, {text: `Chapter ${chapterN}: ${title}`})

    const res = await callModel(
      `\
You have been tasked with converting this PDF to an EPUB in a series of steps. \

Here are the conversion requirements:

- Retain basic formatting with proper headings, emphasis, and paragraphs for reflowable layout on e-readers.
- Omit extraneous text like page headings, page numbers, footnotes, etc.
- Fix any obvious OCR transcription errors.
- Remove all images. The final output should not contain any images and be text only.
- Remove inline footnote numbers.

For the current step, we want to convert ONLY one chapter: "Chapter ${chapterN}: ${title}". \
The output should begin with an <h1> tag with the chapter number and title followed \
by the tags containing the chapter content (<p>, <h2>, <ol>, <blockquote>, etc.). \
The chapter MAY contain subchapters, which should be headed with <h2> tags. \

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

    $(`#${chapterId(chapterN)}`).html(res)
    writeFileSync(argv.output, $.html())
    spinnies.succeed(spinnerId)
  },
  {concurrency: 5}
)

const $ = load(template)
const inputFile = await uploadFile(argv.input)
await main()
