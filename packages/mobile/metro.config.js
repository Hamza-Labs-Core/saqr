const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo root for shared packages
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, "node_modules"),
  path.join(monorepoRoot, "node_modules"),
];

// Resolve .js imports from src/ to .ts source files
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath;
  if (origin && moduleName.endsWith(".js")) {
    const tsName = moduleName.replace(/\.js$/, ".ts");
    const candidate = path.resolve(path.dirname(origin), tsName);
    if (fs.existsSync(candidate)) {
      return (defaultResolve ?? require("metro-resolver").resolve)(
        context,
        tsName,
        platform,
      );
    }
  }
  return (defaultResolve ?? require("metro-resolver").resolve)(
    context,
    moduleName,
    platform,
  );
};

module.exports = config;
