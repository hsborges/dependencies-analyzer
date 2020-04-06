/*
 *  Author: Hudson Silva Borges (hudsonsilbor[at]gmail.com)
 */
const Promise = require('bluebird');
const path = require('path');
const glob = require('glob');
const util = require('util');
const crypto = require('crypto');
const debug = require('debug');
const os = require('os');

const exec = util.promisify(require('child_process').exec);
const readJson = util.promisify(require('read-package-json'));

const { pick, sortBy, uniqWith, compact } = require('lodash');
const { isEmpty, isEqual } = require('lodash');

const log = debug('analyzer:log');
const error = debug('analyzer:error');

const FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies'
];

module.exports = async (
  repository,
  {
    tmpDir = os.tmpdir(),
    ignoreParsingErrors = true,
    ignoreModuleDirectories = true
  } = {}
) => {
  const [owner, name] = repository.split('/');

  if (!(owner && name))
    throw new Error(
      'Invalid repository name! Acceptable format: "owner/name" (e.g., twbs/bootstrap)'
    );

  const hash = crypto.createHash('md5').update(repository).digest('hex');
  const repositoryPath = path.join(tmpDir, `repo_${hash}`);
  const cloneCommand = `git clone https://github.com/${repository} ${repositoryPath}`;

  // faz o clone do projeto
  log(`Clonig ${repository} into ${repositoryPath}`);
  await exec(cloneCommand, { stdio: 'ignore' });

  // busca por arquivos package.json e bower.json
  log('Searching for package.json and bower.json files');
  const files = glob.sync('**/@(package|bower).json', {
    cwd: repositoryPath,
    ignore: ignoreModuleDirectories
      ? '**/+(node_modules|bower_modules)/**'
      : null
  });

  if (!files || !files.length)
    throw new Error('No [package|bower].json files found!');

  return Promise.reduce(
    files,
    async (filesAcc, file) => {
      // volta para o HEAD
      await exec('git checkout origin/HEAD', {
        cwd: repositoryPath,
        stdio: 'ignore'
      });
      // busca todos os commits que alteraram tais arquivos
      log(`Getting change history of ${file}`);
      const command = `git log --pretty=format:%H,%an,%ae,%at -- ${file}`;
      const { stdout } = await exec(command, {
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
        await exec(`git checkout ${commit.sha}`, {
          cwd: repositoryPath,
          stdio: 'ignore'
        });
        log(`Parsing ${file} on ${commit.sha}`);
        const fileP = path.join(repositoryPath, file);
        return readJson(fileP)
          .then((json) => pick(json, FIELDS))
          .then((dependencies) =>
            isEmpty(dependencies) ? null : { ...commit, ...dependencies }
          )
          .catch((err) => {
            error(`Parsing failed for ${file} on commit ${commit.sha}`);
            if (ignoreParsingErrors) return Promise.resolve(null);
            throw err;
          });
      }).then((data) => filesAcc.concat(data));
    },
    []
  )
    .then((result) => {
      // remove commits que não modificaram ou não possuem dependencias
      log(`Removing commits that did not modify dependencies`);
      return uniqWith(sortBy(compact(result), 'date'), (a, b) =>
        isEqual(pick(a, [...FIELDS, 'file']), pick(b, [...FIELDS, 'file']))
      );
    })
    .finally(() => exec(`rm -rf ${repositoryPath}`, { stdio: 'ignore' }));
};
