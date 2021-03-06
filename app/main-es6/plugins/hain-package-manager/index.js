'use strict';

const _ = require('lodash');
const co = require('co');
const Packman = require('./packman');
const got = require('got');

const COMMANDS_RE = / (install|uninstall|list)(\s+([^\s]+))?/i;
const NAME = 'hain-package-manager (experimental)';
const PREFIX = '/hpm';

const COMMANDS = [`${PREFIX} install `, `${PREFIX} uninstall `, `${PREFIX} list `];
const CACHE_DURATION_SEC = 5 * 60; // 5 mins

module.exports = (context) => {
  const pm = new Packman(context.MAIN_PLUGIN_REPO, './_temp');
  const toast = context.toast;
  const logger = context.logger;
  const shell = context.shell;
  const matchutil = context.matchutil;
  const app = context.app;
  const PLUGIN_API_VERSION = context.PLUGIN_API_VERSION;

  let currentStatus = null;
  let progressTimer = 0;
  let lastUpdatedTime = 0;
  let availablePackages = [];

  function* searchPackages(query) {
    const query_enc = query;
    const fields = 'name,rating,version,description,keywords,author';
    const url = `http://npmsearch.com/query?q=name:${query_enc}&fields=${fields}&default_operator=AND&sort=rating:desc&size=50`;
    const res = yield got(url, { json: true });
    const packages = _.filter(res.body.results, x => {
      return (x.keywords && x.keywords.indexOf(PLUGIN_API_VERSION) >= 0);
    });
    return packages.map(x => {
      return {
        name: x.name[0],
        version: x.version[0],
        desc: x.description[0],
        author: x.author[0] || ''
      };
    });
  }

  function checkAvailablePackages() {
    const elapsed = (Date.now() - lastUpdatedTime) / 1000;
    if (elapsed <= CACHE_DURATION_SEC)
      return;
    lastUpdatedTime = Date.now();
    return co(function* () {
      currentStatus = 'fetching available packages...';
      availablePackages = yield searchPackages('hain-plugin');
      currentStatus = null;
    });
  }

  function getPackageInfo(packageName) {
    return _.find(pm.listPackages(), (x) => x.name === packageName);
  }

  function startup() {
    co(function* () {
      pm.readPackages();
      checkAvailablePackages();
    }).catch((err) => {
      logger.log(err);
    });
  }

  function search(query, res) {
    if (currentStatus === null) {
      checkAvailablePackages();
    }
    clearTimeout(progressTimer);
    if (currentStatus) {
      res.add({
        id: '**',
        title: currentStatus,
        desc: NAME,
        icon: '#fa fa-spinner fa-spin'
      });
      progressTimer = setInterval(() => {
        if (!currentStatus) {
          res.remove('**');
          res.add(parseCommands(query));
          return clearTimeout(progressTimer);
        }
      }, 500);
      return;
    }
    res.add(parseCommands(query));
  }

  function _toSearchResult(cmdType, pkgInfo, customName, payload) {
    return {
      id: pkgInfo.name,
      payload: payload || cmdType,
      title: `${customName || pkgInfo.name} ` +
             ` <span style='font-size: 9pt'>${pkgInfo.version} by <b>${pkgInfo.author}</b></span>`,
      desc: `${pkgInfo.desc}`
    };
  }

  function parseCommands(query) {
    // install
    const parsed = COMMANDS_RE.exec(query.toLowerCase());
    if (!parsed) {
      return _makeCommandsHelp(query);
    }
    const command = parsed[1];
    const arg = parsed[2];
    if (command === 'install') {
      if (arg) {
        return matchutil.fuzzy(availablePackages, arg.trim(), x => x.name).map(x => {
          const m = matchutil.makeStringBoldHtml(x.elem.name, x.matches);
          return _toSearchResult('install', x.elem, m);
        });
      }
      return availablePackages.map(x => _toSearchResult('install', x));
    }
    if (command === 'uninstall') {
      const packages = pm.listPackages();
      return packages.map((x) => _toSearchResult('uninstall', x));
    }
    // list
    if (command === 'list') {
      const packages = pm.listPackages();
      return packages.map((x) => _toSearchResult('', x, null, 'list'));
    }
    return _makeCommandsHelp(query);
  }

  function _makeCommandsHelp(query) {
    const ret = matchutil.head(COMMANDS, `${PREFIX}${query}`, (x) => x).map((x) => {
      return {
        redirect: x.elem,
        title: matchutil.makeStringBoldHtml(x.elem, x.matches),
        desc: NAME
      };
    });
    return ret;
  }

  function execute(id, payload) {
    if (payload === 'install') {
      co(installPackage(id, 'latest'));
      app.setInput(`${PREFIX} `);
    } else if (payload === 'uninstall') {
      co(uninstallPackage(id));
      app.setInput(`${PREFIX} `);
    } else if (payload === 'list') {
      const pkgInfo = getPackageInfo(id);
      if (pkgInfo.homepage)
        shell.openExternal(pkgInfo.homepage);
    }
  }

  function* uninstallPackage(packageName) {
    currentStatus = `Uninstalling <b>${packageName}`;
    try {
      yield pm.removePackage(packageName);
      toast.enqueue(`${packageName} has uninstalled, <b>Restart</b> Hain to take effect`, 3000);
    } catch (e) {
      toast.enqueue(e.toString());
    } finally {
      currentStatus = null;
    }
  }

  function* installPackage(packageName, versionRange) {
    logger.log(`Installing ${packageName}`);
    currentStatus = `Installing <b>${packageName}</b>`;
    try {
      yield pm.installPackage(packageName, versionRange);
      toast.enqueue(`${packageName} has installed, <b>Restart</b> Hain to take effect`, 3000);
      logger.log(`${packageName} installed`);
    } catch (e) {
      toast.enqueue(e.toString());
      logger.log(`${packageName} ${e}`);
      throw e;
    } finally {
      currentStatus = null;
    }
  }

  return { startup, search, execute };
};
