function readPackage(packageManifest) {
  if (packageManifest.name === "@prisma/client" && packageManifest.version === "7.8.0") {
    delete packageManifest.peerDependencies?.prisma;
    delete packageManifest.peerDependencies?.typescript;
    delete packageManifest.peerDependenciesMeta?.prisma;
    delete packageManifest.peerDependenciesMeta?.typescript;
  }
  return packageManifest;
}

module.exports = { hooks: { readPackage } };
