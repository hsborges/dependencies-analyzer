/*
 *  Author: Hudson Silva Borges (hudsonsilbor[at]gmail.com)
 */
const Promise = require('bluebird');
const path = require('path');
const glob = require('glob');
const readJson = Promise.promisify(require('read-package-json'));
const debug = require('debug');

const { execSync } = require('child_process');
const { pick, sortBy } = require('lodash');
const { uniqWith, isEqual } = require('lodash');

const log = debug('analyzer:log');
const error = debug('analyzer:error');

const FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies'
];

module.exports = (repository, { tmpDir, ignoreParsingErrors }) => {
  const [owner, name] = repository.split('/');

  if (!(owner && name)) {
    throw new Error(
      'Invalid repository name! Acceptable format: "owner/name" (e.g., twbs/bootstrap)'
    );
  }

  const repositoryPath = path.join(tmpDir, repository);
  const cloneCommand = `git clone https://github.com/${repository} ${repositoryPath}`;

  // faz o clone do projeto
  log(`Clonig ${repository} into ${repositoryPath}`);
  execSync(cloneCommand, { stdio: 'ignore' });

  // deleta arquivos se ctrl+c for pressionado
  log('Register handling to delete files before exit');
  process.on('SIGINT', () =>
    execSync(`rm -rf ${repositoryPath}`, { stdio: 'ignore' })
  );

  // busca por arquivos package.json e bower.json
  log('Searching for package.json and bower.json files');
  const files = glob.sync('**/@(package|bower).json', { cwd: repositoryPath });

  if (!files || !files.length)
    throw new Error('No package.json or bower.json found!');

  return Promise.reduce(
    files,
    async (filesAcc, file) => {
      // volta para o HEAD
      execSync('git checkout origin/HEAD', {
        cwd: repositoryPath,
        stdio: 'ignore'
      });
      // busca todos os commits que alteraram tais arquivos
      log(`Getting change history of ${file}`);
      const command = `git log --pretty=format:%H,%an,%ae,%at -- ${file}`;
      const stdout = execSync(command, {
        cwd: repositoryPath,
        encoding: 'utf8',
        maxBuffer: Infinity
      });

      const commits = stdout.split(/[\r\n]/gi).map((row) => {
        const [sha, author, email, date] = row.split(',');
        return { file, sha, author, email, date: new Date(date * 1000) };
      });

      // itera sobre os commits
      log(`Iterating over ${commits.length} commits for ${file}`);
      return Promise.mapSeries(commits, async (commit) => {
        // faz o checkout de cada commit e analisa as dependencias
        log(`Checking out commit ${commit.sha}`);
        execSync(`git checkout ${commit.sha}`, {
          cwd: repositoryPath,
          stdio: 'ignore'
        });
        log(`Parsing ${file} on ${commit.sha}`);
        const fileP = path.join(repositoryPath, file);
        return readJson(fileP)
          .then((json) =>
            FIELDS.reduce(
              (_, type) => (json[type] ? { ..._, [type]: json[type] } : _),
              commit
            )
          )
          .catch((err) => {
            error(`Parsing failed for ${file} on commit ${commit.sha}`);
            if (ignoreParsingErrors) return Promise.resolve([]);
            throw err;
          });
      }).then((data) => filesAcc.concat(data));
    },
    []
  )
    .then((result) => {
      // remove commits que não modificaram as dependencias
      log(`Removing commits that did not modify dependencies`);
      return uniqWith(sortBy(result, 'date'), (a, b) =>
        isEqual(pick(a, [...FIELDS, 'file']), pick(b, [...FIELDS, 'file']))
      );
    })
    .finally(() => execSync(`rm -rf ${repositoryPath}`));
};
