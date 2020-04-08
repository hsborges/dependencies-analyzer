/*
 *  Author: Hudson Silva Borges (hudsonsilbor[at]gmail.com)
 */
const Promise = require('bluebird');

const fs = require('fs');
const util = require('util');
const debug = require('debug');
const globby = require('globby');
const tmp = require('tmp-promise');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');

const writeFile = util.promisify(fs.writeFile);
const readJson = util.promisify(require('read-package-json'));

const { pick, sortBy, uniqWith, compact } = require('lodash');
const { isEmpty, isEqual } = require('lodash');

const gitLog = require('./git-log.js');

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

  const dirOptions = { unsafeCleanup: true };
  const fileOptions = { postfix: '.json' };

  return tmp.withDir(async ({ path: dir }) => {
    // faz o clone do projeto
    log(`Clonig ${repository} into ${dir}`);
    const corsProxy = 'https://cors.isomorphic-git.org';
    const url = `https://github.com/${repository}`;
    await git.clone({ fs, http, dir, corsProxy, url });

    // busca por arquivos package.json e bower.json
    log('Searching for package.json and bower.json files');
    const files = await globby('**/@(package|bower).json', {
      cwd: dir,
      ignore: ignoreModuleDirectories ? '**/+(node_modules|bower_modules)/**' : null
    });

    if (!files || !files.length)
      throw new Error('No [package|bower].json files found!');

    const history = await Promise.reduce(
      files,
      async (acc, filepath) => {
        // busca todos os commits que alteraram tais arquivos
        log(`Getting change history of ${filepath}`);
        const commits = await gitLog({ dir, filepath, ref: 'origin/HEAD' }).then(
          (list) =>
            list.map((commit) => ({
              file: filepath,
              sha: commit.oid,
              author: commit.commit.author.name,
              email: commit.commit.author.email,
              date: new Date(commit.commit.author.timestamp * 1000)
            }))
        );
        // itera sobre os commits
        log(`Iterating over ${commits.length} commits for ${filepath}`);
        return Promise.mapSeries(commits, async (commit) => {
          // lendo arquibo no commit historico do git
          return tmp.withFile(async ({ path: tmpFile }) => {
            // salva em um arquivo temporario
            await git
              .readBlob({ fs, dir, oid: commit.sha, filepath })
              .then(({ blob }) => writeFile(tmpFile, blob, 'utf8'));

            log(`Parsing ${filepath} @ ${commit.sha}`);
            return readJson(tmpFile)
              .then((json) => pick(json, FIELDS))
              .then((dependencies) =>
                isEmpty(dependencies) ? null : { ...commit, ...dependencies }
              )
              .catch((err) => {
                error(`Parsing failed for ${filepath} @ ${commit.sha}`);
                if (ignoreParsingErrors) return Promise.resolve(null);
                throw err;
              });
          }, fileOptions);
        }).then((data) => acc.concat(data));
      },
      []
    );
    // remove commits que não modificaram ou não possuem dependencias
    log(`Removing commits that did not modify dependencies`);
    return uniqWith(sortBy(compact(history), 'date'), (a, b) =>
      isEqual(pick(a, [...FIELDS, 'file']), pick(b, [...FIELDS, 'file']))
    );
  }, dirOptions);
};
