import {
  Worker, isMainThread, parentPort, workerData,
} from 'worker_threads'
import fs from 'fs'
import os from 'os'
import chalk from 'chalk'
import { ESLint } from 'eslint'
import { globSync } from 'glob'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

const numCPUs = os.cpus().length

const DEFAULT_EXTENSIONS = ['js', 'ts']
const ESLINTRC_JS = '.eslintrc.js'
const ESLINTRC_JSON = '.eslintrc.json'
const ESLINT_IGNORE = `${process.cwd()}/.eslintignore`

const SeverityEnum = {
  Pass: 0,
  Warning: 1,
  ERROR: 2,
}

const SeverityColor = {
  [SeverityEnum.Pass]: 'green',
  [SeverityEnum.Warning]: 'yellow',
  [SeverityEnum.ERROR]: 'red',
}

const SEVERITY_MESSAGES = {
  [SeverityEnum.Pass]: 'pass',
  [SeverityEnum.Warning]: 'warning',
  [SeverityEnum.ERROR]: 'error',
}

const splitArrayIntoChunks = (array, parts) => {
  const chunks = []
  for (let i = 0; i < parts; i++) {
    const size = Math.ceil(array.length / parts)
    chunks.push(array.slice(i * size, (i + 1) * size))
  }
  return chunks.filter(chunk => chunk.length > 0)
}

const runEslintOnFiles = async ({ files, options }) => {
  const { fix } = options
  const eslint = new ESLint({ useEslintrc: true, fix })
  return eslint.lintFiles(files)
}

const getEslintConfig = () => {
  const configs = [ESLINTRC_JS, ESLINTRC_JSON].map(config => `${process.cwd()}/${config}`)
  const config = configs.find(fs.existsSync)
  if (!config) {
    console.error('No eslint config found')
    process.exit(1)
  }
  return config
}

const parseEslintConfig = async ({ options, config }) => {
  const { ignorePath } = options
  const eslint = new ESLint({ useEslintrc: true, ignorePath: ignorePath || ESLINT_IGNORE })
  return new Promise(resolve => {
    try {
      eslint.calculateConfigForFile(config).then(config => resolve(config))
    } catch (error) {
      console.error('Error getting eslint config:', error)
      resolve({ ignorePatterns: [] })
    }
  })
}

const getGlobIgnorePatternsFromEslint = patterns => {
  return patterns.map(pattern => `${pattern}/**`)
}

const printFormattedMessage = ({ result, quiet = false }) => {
  const { filePath, messages, errorCount, warningCount } = result
  if (errorCount === 0 && warningCount === 0 && !quiet) {
    console.log(`${result.filePath} ${chalk[SeverityColor[SeverityEnum.Pass]].bold(SEVERITY_MESSAGES[SeverityEnum.Pass])}`)
    return
  }

  const ruleMessages = messages.reduce((acc, { ruleId, message, line, column, severity }) => {
    if (quiet && severity === SeverityEnum.Warning) return acc
    const severityMessage = chalk[SeverityColor[severity]].bold(SEVERITY_MESSAGES[severity])
    return `${acc}${line}:${column} ${severityMessage} ${message} ${ruleId}\n`
  }, '')

  if (!ruleMessages) return
  console.error(`${filePath}\n${ruleMessages}`)
}

const getLintTarget = ({ context, ext, ignorePatterns = [] }) => {
  const extensions = ext ? ext.split(',').map(extension => extension.replace('.', '')) : DEFAULT_EXTENSIONS

  const targetFolder = context || process.cwd()
  const pattern = `${targetFolder}/**/*.{${extensions.join(',')}}`
  return globSync(pattern, { ignore: getGlobIgnorePatternsFromEslint(ignorePatterns) })
}

const lintFiles = async ({ options, config }) => {
  if (!isMainThread) {
    const files = workerData.files
    runEslintOnFiles({ files, options }).then(results => {
      parentPort.postMessage(results)
    }).catch(error => {
      parentPort.postMessage({ error: error.message })
    })
  }

  if (isMainThread) {
    console.log('Start linting files...\n')
    const { context, ext, quiet } = options
    const { ignorePatterns = [] } = await parseEslintConfig({ options, config })
    const files = getLintTarget({ context, ext, ignorePatterns })
    const filesChunks = splitArrayIntoChunks(files, numCPUs)
    const finalResults = []

    filesChunks.forEach((chunk, index) => {
      const worker = new Worker(__filename, {
        workerData: { files: chunk },
      })
      worker.on('message', results => {
        if (results.error) return
        results.forEach(result => printFormattedMessage({ result, quiet }))
        finalResults.push(...results)
      })

      worker.on('error', error => {
        console.error(`Worker ${index} error:`, error)
      })

      worker.on('exit', code => {
        if (code !== 0)
          console.error(`Worker ${index} stopped with exit code ${code}`)
      })
    })

    process.on('exit', () => {
      const hasError = finalResults.some(result => result.errorCount > 0)

      if (finalResults.length === 0) {
        console.log('No files to lint')
      }
      process.exit(Number(hasError))
    })
  }
}

const getOptionsFromArgs = () => {
  const { _, ext, fix = false, ignorePath = '', quiet = false } = yargs(hideBin(process.argv)).options({
    fix: { type: 'boolean', describe: 'Fix linting errors' },
    ext: { type: 'string', describe: 'File extensions to lint' },
    'ignore-path': { type: 'string', describe: 'Ignore patterns' },
    quiet: { type: 'boolean', describe: 'Only show errors and warnings' },
  }).argv

  const context = _.length > 0 ? _[0] : process.cwd()
  return { context, ext, fix, ignorePath, quiet }
}

const main = () => {
  const options = getOptionsFromArgs()
  const config = getEslintConfig()
  lintFiles({ options, config })
}

main()
