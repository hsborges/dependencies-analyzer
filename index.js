global.Promise = require('bluebird');

const path = require('path');
const util = require('util');

const glob = util.promisify(require('glob'));
const exec = util.promisify(require('child_process').exec);
const readFile = util.promisify(require('fs').readFile);

const { parse } = require('json2csv');
const { program } = require('commander');
const { createWriteStream } = require('fs');

program
  .version('0.0.1')
  .arguments('<repository>')
  .option(
    '-t, --tmp-dir <dir>',
    'Temporary directory to clone the project',
    '/tmp'
  )
  .option('-f, --format <format>', 'Output format (csv or json)', 'csv')
  .option('-o, --output <file_path>', 'Output file path')
  .action((repository) => {
    const [owner, name] = repository.split('/');

    if (!(owner && name)) {
      process.stderr.write(
        'Invalid repository name! Acceptable format: "owner/name" (e.g., twbs/bootstrap)\n'
      );
      process.exit(1);
    }

    const repositoryPath = path.join(program.tmpDir, repository);

    // faz o clone do projeto
    exec(`git clone https://github.com/${repository} ${repositoryPath}`)
      .catch(({ stderr, code }) => {
        process.stderr.write(stderr);
        process.exit(code);
      })
      // busca por arquivos package.json e bower.json e itera sobre eles
      .then(() => glob('**/@(package|bower).json', { cwd: repositoryPath }))
      .then((files) => {
        if (!files || !files.length) {
          process.stderr.write('No package.json or bower.json found!');
          process.exit(1);
        }

        return Promise.reduce(
          files,
          async (filesAcc, file) => {
            // busca todos os commits que alteraram tais arquivos
            const command = `git log --follow --pretty=format:%H,%an,%ae,%at -- ${file}`;
            const { stdout, stderr } = await exec(command, {
              cwd: repositoryPath
            });

            if (stderr) throw stderr;

            const commits = stdout.split(/[\r\n]/gi).map((row) => {
              const [sha, author, email, date] = row.split(',');
              return { sha, author, email, date };
            });

            return Promise.reduce(
              commits,
              async (acc, commit) => {
                // faz o checkout de cada commit e analisa as dependencias
                await exec(`git checkout ${commit.sha}`, {
                  cwd: repositoryPath
                });
                const json = JSON.parse(
                  await readFile(`${path.join(repositoryPath, file)}`)
                );

                const types = [
                  'dependencies',
                  'devDependencies',
                  'optionalDependencies',
                  'peerDependencies',
                  'bundledDependencies'
                ];

                return Promise.reduce(
                  types,
                  (_acc, type) =>
                    _acc.concat(
                      Object.keys(json[type] || {}).map((_name) => ({
                        file,
                        ...commit,
                        name: _name,
                        version: json[type][name],
                        type
                      }))
                    ),
                  acc
                );
              },
              []
            ).then((data) => filesAcc.concat(data));
          },
          []
        );
      })
      .then((result) => {
        if (program.output) {
          const outputFile = path.resolve(__dirname, program.output);
          const stream = createWriteStream(outputFile);
          process.stdout.write = stream.write.bind(stream);
        }
        if (program.format === 'csv') process.stdout.write(parse(result));
        else process.stdout.write(JSON.stringify(result, null, 2));
      })
      .catch((err) => process.stderr.write(err))
      .finally(() => exec(`rm -rf ${repositoryPath}`));
  });

program.parse(process.argv);
