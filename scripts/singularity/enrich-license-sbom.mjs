import "./enrich-license-sbom-core.mjs";
import { enrichMaterializedLicenseSboms } from "./enrich-materialized-license-sbom.mjs";

function readOutputPath(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --output");
      }
      return value;
    }
  }
  throw new Error("Missing --output argument");
}

const outputPath = readOutputPath(process.argv.slice(2));
if (outputPath.endsWith("source.cdx.json")) {
  const enriched = enrichMaterializedLicenseSboms({
    roots: ["enterprise", "app"],
    sboms: [outputPath],
  });
  process.stdout.write(
    `Enriched ${String(enriched)} source SBOM components from materialized package manifests\n`,
  );
}
