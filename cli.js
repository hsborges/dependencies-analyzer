/*
 *  Author: Hudson Silva Borges (hudsonsilbor[at]gmail.com)
 */
const path = require('path');

const { parse } = require('json2csv');
const { program } = require('commander');
const { createWriteStream } = require('fs');
const { flattenDeep, omit, map } = require('lodash');

const analyzer = require('./index.js');

const FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies'
];

program
  .arguments('<repository>')
  .option('-f, --format <format>', 'Output format (csv or json)', 'json')
  .option('-o, --output <file_path>', 'Output result to a file')
  .option('--tmp-dir <dir>', 'Directory to clone the project', '/tmp')
  .option('--ignore-parsing-errors', 'Ignore parsing errors', true)
  .option('--ignore-modules', 'Ignore (node|bower)_modules directories', true)
  .action(async (repository) => {
    return analyzer(repository, {
      tmpDir: program.tmpDir,
      ignoreParsingErrors: program.ignoreParsingErrors,
      ignoreModuleDirectories: program.ignoreModules
    })
      .then((result) => {
        if (program.output) {
          const outputFile = path.resolve(__dirname, program.output);
          const stream = createWriteStream(outputFile);
          process.stdout.write = stream.write.bind(stream);
        }
        if (program.format === 'csv') {
          process.stdout.write(
            parse(
              flattenDeep(
                map(result, (commit) =>
                  map(FIELDS, (field) =>
                    map(commit[field], (version, name) => ({
                      ...omit(commit, FIELDS),
                      type: field,
                      name,
                      version
                    }))
                  )
                )
              )
            )
          );
        } else if (program.format === 'json') {
          process.stdout.write(JSON.stringify(result, null, 2));
        }
      })
      .catch((err) => {
        process.stderr.write(err.toString());
        process.exit(1);
      });
  });

// faz o parser dos parametros e inicia o script
program.parse(process.argv);
