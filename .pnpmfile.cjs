// TypeScript 7 ships no JS compiler API. Mastra's bundler resolves tsconfig `paths`
// through typescript-paths, which calls that API. A peer would resolve to the
// workspace's TypeScript 7, so give typescript-paths its own TypeScript 6.
function readPackage(manifest) {
  if (manifest.name === "typescript-paths") {
    delete manifest.peerDependencies.typescript;
    manifest.dependencies = { ...manifest.dependencies, typescript: "6.0.3" };
  }

  return manifest;
}

module.exports = { hooks: { readPackage } };
