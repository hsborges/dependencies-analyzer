/*
 *  Author: Hudson Silva Borges (hudsonsilbor[at]gmail.com)
 */
const Promise = require('bluebird');

const fs = require('fs');
const util = require('util');
const debug = require('debug');
const globby = require('globby');
const tmp = require('tmp-promise');
const simpleGit = require('simple-git/promise');

const writeFile = util.promisify(fs.writeFile);
const readJson = util.promisify(require('read-package-json'));

const { pick, sortBy, uniqWith, compact, flattenDeep } = require('lodash');
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
  { ignoreParsingErrors = true, ignoreModuleDirectories = true } = {}
) => {
  const [owner, name] = repository.split('/');

  if (!(owner && name))
    throw new Error(
      'Invalid repository name! Acceptable format: "owner/name" (e.g., twbs/bootstrap)'
    );

  tmp.setGracefulCleanup();

  const dirOptions = { prefix: 'repo-', unsafeCleanup: true };
  const fileOptions = { prefix: 'repo-', postfix: '.json' };

  return tmp.withDir(async ({ path: dir }) => {
    // faz o clone do projeto
    log(`Clonig ${repository} into ${dir}`);
    await simpleGit()
      .silent(true)
      .clone(`https://anonymous:anonymous@github.com/${repository}`, dir);

    // busca por arquivos package.json e bower.json
    log('Searching for package.json and bower.json files');
    const ignore = ['.git/**'];
    if (ignoreModuleDirectories) ignore.push('**/+(node_modules|bower_modules)/**');
    const files = await globby('**/@(package|bower).json', { cwd: dir, ignore });

    if (!files || !files.length)
      throw new Error('No [package|bower].json files found!');

    // cria uma instancia git
    const git = simpleGit(dir).silent(true);

    // itera sobre os commits e faz o parser
    return Promise.mapSeries(files, async (file) => {
      // busca todos os commits que alteraram tais arquivos
      log(`Getting change history of ${file}`);
      const format = { sha: '%H', author: '%an', email: '%ae', date: '%at' };
      const commits = (await git.log({ file, format })).all.map((c) => ({
        file,
        ...c,
        date: new Date(c.date * 1000)
      }));

      // itera sobre os commits
      let renamed = false;
      log(`Iterating over ${commits.length} commits for ${file}`);
      return Promise.mapSeries(commits, async (commit) => {
        // skip commits before a rename
        if (renamed) return Promise.resolve(null);
        // salva em um arquivo temporario e faz o parser
        return tmp
          .withFile(async ({ path: tmpFile }) => {
            await git
              .show([`${commit.sha}:${file}`])
              .then((blob) => writeFile(tmpFile, blob, 'utf8'));

            log(`Parsing ${file} @ ${commit.sha}`);
            return readJson(tmpFile)
              .then((json) => pick(json, FIELDS))
              .then((dependencies) =>
                isEmpty(dependencies) ? null : { ...commit, ...dependencies }
              )
              .catch((err) => {
                error(`Parsing failed for ${file} @ ${commit.sha}`);
                if (ignoreParsingErrors) return Promise.resolve(null);
                throw err;
              });
          }, fileOptions)
          .catch((err) => {
            if (!/path.*exists.on.disk,.but/i.test(err.message))
              return Promise.reject(err);
            // ignora os casos onde o arquivo foi renomeado
            renamed = true;
            return Promise.resolve(null);
          });
      }).then((fileCommits) =>
        // remove commits que não modificaram ou não possuem dependencias
        uniqWith(sortBy(compact(fileCommits), 'date'), (a, b) =>
          isEqual(pick(a, FIELDS), pick(b, FIELDS))
        )
      );
    }).then((history) => flattenDeep(history));
  }, dirOptions);
};
