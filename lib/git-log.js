/*
 *  Author: Hudson Silva Borges (hudsonsilbor[at]gmail.com)
 */
const Promise = require('bluebird');
const fs = require('fs');

const { compact } = require('lodash');
const { log, readObject } = require('isomorphic-git');

module.exports = async ({ dir, filepath, ref }) => {
  const commits = await log({ fs, dir, ref });

  let lastSHA = null;
  let lastCommit = null;

  return Promise.reduce(
    commits,
    async (matter, commit) =>
      readObject({ fs, dir, oid: commit.oid, filepath })
        .then((o) => {
          if (o.oid !== lastSHA) {
            if (lastSHA !== null) matter.push(lastCommit);
            lastSHA = o.oid;
          }
          lastCommit = commit;
          return matter;
        })
        .catch(() => matter),
    []
  ).then((matter) => compact([...matter, lastCommit]));
};
