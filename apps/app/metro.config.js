// Metro is the bundler Expo uses to build the app and the website.
//
// TripMate is a monorepo: shared code lives in ../../packages/core. On
// Windows, npm links workspace packages with symlinks that Metro's dev server
// does not always follow, so we tell Metro explicitly where the shared
// package is and that it should watch the whole workspace for changes.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@tripmate/core': path.resolve(workspaceRoot, 'packages/core'),
};

module.exports = config;
